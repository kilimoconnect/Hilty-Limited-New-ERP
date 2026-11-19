-- =============================================================================
-- Hilty ERP - Migration 0040: purchase orders with suggested quantities.
--
-- 1. products.preferred_supplier_id: who normally supplies a product. When it
--    is empty the supplier of the product's latest posted purchase is used.
-- 2. purchase_orders / purchase_order_lines: quantities only, no prices.
--    draft -> confirmed -> partially_received -> received; or cancelled/closed.
--    A purchase (with prices) can be raised from a confirmed order; posting it
--    updates qty_received on the order automatically (trigger).
-- 3. Pending orders last 30 days: expire_purchase_orders() deletes orders that
--    received nothing by then and closes partly received ones.
-- 4. report_reorder_suggestions(): average monthly demand over 6 / 9 / 12
--    months (or as much history as the product has), reorder level and the
--    suggested order quantity per product for a branch.
-- =============================================================================

alter table public.products add column if not exists preferred_supplier_id uuid references public.suppliers(id) on delete set null;
create index if not exists products_preferred_supplier_idx on public.products(preferred_supplier_id);

create table if not exists public.purchase_orders (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete restrict,
  branch_id        uuid not null references public.branches(id) on delete restrict,
  supplier_id      uuid not null references public.suppliers(id) on delete restrict,
  document_number  text,
  status           text not null default 'draft'
                   check (status in ('draft','confirmed','partially_received','received','closed','cancelled')),
  order_date       date not null default current_date,
  expected_date    date,
  reference        text,
  notes            text,
  -- How the quantities were suggested (kept for the record).
  basis            text check (basis is null or basis in ('sales','purchases')),
  basis_months     integer check (basis_months is null or basis_months in (6, 9, 12)),
  lead_days        integer check (lead_days is null or lead_days >= 0),
  safety_days      integer check (safety_days is null or safety_days >= 0),
  cover_days       integer check (cover_days is null or cover_days >= 0),
  confirmed_at     timestamptz,
  confirmed_by     uuid references auth.users(id) on delete set null,
  -- Pending until this moment; afterwards expire_purchase_orders() removes or closes it.
  expires_at       timestamptz not null default (now() + interval '30 days'),
  closed_at        timestamptz,
  close_reason     text,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id) on delete set null
);
create unique index if not exists purchase_orders_number_uniq
  on public.purchase_orders(company_id, document_number) where document_number is not null;
create index if not exists purchase_orders_branch_idx on public.purchase_orders(company_id, branch_id, status);
create index if not exists purchase_orders_supplier_idx on public.purchase_orders(supplier_id);

drop trigger if exists trg_purchase_orders_company on public.purchase_orders;
create trigger trg_purchase_orders_company before insert or update on public.purchase_orders
  for each row execute function public.check_company_consistency('branch_id', 'branches', 'supplier_id', 'suppliers');

create table if not exists public.purchase_order_lines (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references public.purchase_orders(id) on delete cascade,
  product_id     uuid not null references public.products(id) on delete restrict,
  description    text,
  quantity       numeric(18,4) not null check (quantity > 0),
  qty_received   numeric(18,4) not null default 0 check (qty_received >= 0),
  -- Snapshot of the suggestion when the line was generated (null for lines added by hand).
  avg_monthly    numeric(18,4),
  reorder_level  numeric(18,4),
  on_hand        numeric(18,4),
  suggested_qty  numeric(18,4),
  note           text,
  line_no        integer not null default 1,
  unique (order_id, product_id)
);
create index if not exists purchase_order_lines_order_idx on public.purchase_order_lines(order_id);
create index if not exists purchase_order_lines_product_idx on public.purchase_order_lines(product_id);

alter table public.purchases add column if not exists purchase_order_id uuid references public.purchase_orders(id) on delete set null;
create index if not exists purchases_order_idx on public.purchases(purchase_order_id) where purchase_order_id is not null;

-- Document numbers: PO00001...
do $$ declare c record; begin
  for c in select id from public.companies loop
    perform public._ensure_doc_sequence(c.id, 'purchase_order', 'PO');
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Received quantities follow the posted purchases raised from the order.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_purchase_order(p_order uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  o public.purchase_orders;
  all_done boolean;
  any_in boolean;
begin
  select * into o from public.purchase_orders where id = p_order for update;
  if not found then return; end if;
  update public.purchase_order_lines ol set qty_received = coalesce((
    select sum(pl.quantity) from public.purchase_lines pl join public.purchases p on p.id = pl.purchase_id
     where p.purchase_order_id = p_order and p.document_status = 'posted' and pl.product_id = ol.product_id), 0)
   where ol.order_id = p_order;
  if o.status in ('draft','cancelled','closed') then return; end if;
  select bool_and(qty_received >= quantity), bool_or(qty_received > 0) into all_done, any_in
    from public.purchase_order_lines where order_id = p_order;
  update public.purchase_orders set
    status = case when all_done then 'received' when any_in then 'partially_received' else 'confirmed' end,
    updated_at = now()
   where id = p_order;
end; $$;

create or replace function public.trg_purchase_refresh_order()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE','DELETE') and old.purchase_order_id is not null then
    perform public.refresh_purchase_order(old.purchase_order_id);
  end if;
  if tg_op in ('INSERT','UPDATE') and new.purchase_order_id is not null
     and (tg_op = 'INSERT' or new.purchase_order_id is distinct from old.purchase_order_id or new.document_status is distinct from old.document_status) then
    perform public.refresh_purchase_order(new.purchase_order_id);
  end if;
  return null;
end; $$;
drop trigger if exists trg_purchases_refresh_order on public.purchases;
create trigger trg_purchases_refresh_order after insert or update of document_status, purchase_order_id or delete on public.purchases
  for each row execute function public.trg_purchase_refresh_order();

-- ---------------------------------------------------------------------------
-- Pending orders last 30 days. Nothing received -> deleted; partly received
-- -> closed (the rest is no longer expected). Returns how many were touched.
-- ---------------------------------------------------------------------------
create or replace function public.expire_purchase_orders(p_company uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; m integer := 0;
begin
  -- Draft purchases raised from an expired order lose the link (the draft stays).
  delete from public.purchase_orders o
   where o.company_id = p_company and o.expires_at < now()
     and o.status in ('draft','confirmed')
     and not exists (select 1 from public.purchases p where p.purchase_order_id = o.id and p.document_status = 'posted');
  get diagnostics n = row_count;
  update public.purchase_orders set status = 'closed', closed_at = now(), close_reason = 'Expired after 30 days', updated_at = now()
   where company_id = p_company and expires_at < now() and status in ('confirmed','partially_received');
  get diagnostics m = row_count;
  return n + m;
end; $$;

-- ---------------------------------------------------------------------------
-- Suggested order quantities for one branch.
--   demand (basis 'sales')      = posted sales - posted sales returns + stock
--                                 dispatched to other branches
--   demand (basis 'purchases')  = posted purchases (how much was ordered before)
--   months_used  = the chosen window, shortened to the product's own history
--                  at the branch (first stock movement), at least 1
--   avg_monthly  = demand in the window / months_used
--   reorder level = avg daily x (lead + safety days)
--   suggested    = avg daily x (lead + safety + cover days) - on hand
--                  - in transit - still pending on open orders, rounded up
-- ---------------------------------------------------------------------------
create or replace function public.report_reorder_suggestions(
  p_company uuid, p_branch uuid, p_months integer, p_basis text,
  p_lead integer, p_safety integer, p_cover integer,
  p_suppliers uuid[] default null, p_brands uuid[] default null,
  p_categories uuid[] default null, p_products uuid[] default null
) returns table(
  product_id uuid, sku text, name text, brand text, category text, unit text,
  supplier_id uuid, supplier_name text, supplier_source text,
  history_months numeric, months_used numeric,
  avg_6 numeric, avg_9 numeric, avg_12 numeric, avg_monthly numeric,
  reorder_level numeric, current_reorder_level numeric,
  on_hand numeric, in_transit numeric, on_order numeric, suggested numeric
) language sql stable security definer set search_path = public as $$
  with prods as (
    select p.id, p.sku, p.name, b.name brand, c.name category, u.symbol unit, p.reorder_level, p.preferred_supplier_id
      from public.products p
      left join public.brands b on b.id = p.brand_id
      left join public.product_categories c on c.id = p.category_id
      left join public.units u on u.id = p.base_unit_id
     where p.company_id = p_company and p.is_active and p.track_inventory
       and (p_brands is null or p.brand_id = any(p_brands))
       and (p_categories is null or p.category_id = any(p_categories))
       and (p_products is null or p.id = any(p_products))
  ),
  last_sup as (
    select distinct on (pl.product_id) pl.product_id, p.supplier_id
      from public.purchase_lines pl join public.purchases p on p.id = pl.purchase_id
     where p.company_id = p_company and p.document_status = 'posted'
     order by pl.product_id, p.document_date desc, p.created_at desc
  ),
  sup as (
    select pr.id product_id,
           coalesce(pr.preferred_supplier_id, ls.supplier_id) supplier_id,
           case when pr.preferred_supplier_id is not null then 'preferred' when ls.supplier_id is not null then 'last_purchase' end supplier_source
      from prods pr left join last_sup ls on ls.product_id = pr.id
  ),
  events as (
    -- (product, date, quantity) of demand at the branch over the last 12 months
    select sl.product_id, s.document_date d, sl.quantity q
      from public.sale_lines sl join public.sales s on s.id = sl.sale_id
     where p_basis = 'sales' and s.company_id = p_company and s.branch_id = p_branch
       and s.document_status = 'posted' and s.document_date > current_date - interval '12 months'
    union all
    select rl.product_id, r.document_date, -rl.quantity
      from public.sales_return_lines rl join public.sales_returns r on r.id = rl.return_id
     where p_basis = 'sales' and r.company_id = p_company and r.branch_id = p_branch
       and r.document_status = 'posted' and r.document_date > current_date - interval '12 months'
    union all
    select tl.product_id, t.transfer_date, tl.qty_dispatched
      from public.stock_transfer_lines tl join public.stock_transfers t on t.id = tl.transfer_id
     where p_basis = 'sales' and t.company_id = p_company and t.source_branch_id = p_branch
       and tl.qty_dispatched > 0 and t.transfer_date > current_date - interval '12 months'
    union all
    select pl.product_id, p.document_date, pl.quantity
      from public.purchase_lines pl join public.purchases p on p.id = pl.purchase_id
     where p_basis = 'purchases' and p.company_id = p_company and p.branch_id = p_branch
       and p.document_status = 'posted' and p.document_date > current_date - interval '12 months'
  ),
  dem as (
    select e.product_id,
           sum(e.q) filter (where e.d > current_date - interval '6 months') q6,
           sum(e.q) filter (where e.d > current_date - interval '9 months') q9,
           sum(e.q) q12
      from events e group by e.product_id
  ),
  hist as (
    select m.product_id, greatest(1, round(((current_date - min(m.created_at)::date) / 30.4375)::numeric, 1)) months
      from public.stock_movements m where m.company_id = p_company and m.branch_id = p_branch
     group by m.product_id
  ),
  open_po as (
    select ol.product_id, sum(greatest(ol.quantity - ol.qty_received, 0)) q
      from public.purchase_order_lines ol join public.purchase_orders o on o.id = ol.order_id
     where o.company_id = p_company and o.branch_id = p_branch and o.status in ('draft','confirmed','partially_received')
     group by ol.product_id
  ),
  calc as (
    select pr.*, s.supplier_id, s.supplier_source,
           coalesce(h.months, 1) history_months,
           least(p_months::numeric, coalesce(h.months, 1)) months_used,
           case when coalesce(h.months, 0) >= 6 then coalesce(d.q6, 0) / 6 end avg_6,
           case when coalesce(h.months, 0) >= 9 then coalesce(d.q9, 0) / 9 end avg_9,
           case when coalesce(h.months, 0) >= 12 then coalesce(d.q12, 0) / 12 end avg_12,
           greatest(case p_months when 6 then coalesce(d.q6, 0) when 9 then coalesce(d.q9, 0) else coalesce(d.q12, 0) end, 0)
             / least(p_months::numeric, coalesce(h.months, 1)) avg_monthly,
           coalesce(sb.quantity, 0) on_hand, coalesce(sb.qty_in_transit, 0) in_transit, coalesce(op.q, 0) on_order
      from prods pr
      join sup s on s.product_id = pr.id
      left join dem d on d.product_id = pr.id
      left join hist h on h.product_id = pr.id
      left join public.stock_balances sb on sb.product_id = pr.id and sb.branch_id = p_branch
      left join open_po op on op.product_id = pr.id
     where (p_suppliers is null or s.supplier_id = any(p_suppliers))
  )
  select c.id, c.sku, c.name, c.brand, c.category, c.unit,
         c.supplier_id, sp.name, c.supplier_source,
         c.history_months, c.months_used,
         round(c.avg_6, 2), round(c.avg_9, 2), round(c.avg_12, 2), round(c.avg_monthly, 2),
         ceil(c.avg_monthly / 30.4375 * (p_lead + p_safety)),
         c.reorder_level,
         c.on_hand, c.in_transit, c.on_order,
         greatest(0, ceil(c.avg_monthly / 30.4375 * (p_lead + p_safety + p_cover) - c.on_hand - c.in_transit - c.on_order))
    from calc c left join public.suppliers sp on sp.id = c.supplier_id
   order by sp.name nulls last, c.brand nulls last, c.name;
$$;

-- ---------------------------------------------------------------------------
-- RLS: readable by users of the order's branch; written only by the server.
-- ---------------------------------------------------------------------------
alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
drop policy if exists purchase_orders_select on public.purchase_orders;
create policy purchase_orders_select on public.purchase_orders for select to authenticated
  using (public.has_company_access(company_id) and public.current_user_has_branch(branch_id));
drop policy if exists purchase_order_lines_select on public.purchase_order_lines;
create policy purchase_order_lines_select on public.purchase_order_lines for select to authenticated
  using (exists (select 1 from public.purchase_orders o where o.id = order_id
                  and public.has_company_access(o.company_id) and public.current_user_has_branch(o.branch_id)));
revoke all on public.purchase_orders, public.purchase_order_lines from anon, authenticated;
grant select on public.purchase_orders, public.purchase_order_lines to authenticated;
grant select, insert, update, delete on public.purchase_orders, public.purchase_order_lines to service_role;

revoke all on function public.trg_purchase_refresh_order() from public, anon, authenticated;
revoke all on function public.refresh_purchase_order(uuid) from public, anon, authenticated;
revoke all on function public.expire_purchase_orders(uuid) from public, anon, authenticated;
revoke all on function public.report_reorder_suggestions(uuid, uuid, integer, text, integer, integer, integer, uuid[], uuid[], uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.refresh_purchase_order(uuid) to service_role;
grant execute on function public.expire_purchase_orders(uuid) to service_role;
grant execute on function public.report_reorder_suggestions(uuid, uuid, integer, text, integer, integer, integer, uuid[], uuid[], uuid[], uuid[]) to service_role;
