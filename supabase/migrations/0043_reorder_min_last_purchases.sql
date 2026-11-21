-- =============================================================================
-- Hilty ERP - Migration 0043: the suggested order quantity is never below the
-- smallest quantity bought in the product's last five posted purchases at
-- the branch (suppliers sell in their usual lot sizes).
--
--   need      = what the averages call for (as in 0040)
--   min_last5 = smallest quantity among the last 5 posted purchases of the
--               product at the branch (null when it was never bought there)
--   suggested = 0 when nothing is needed, otherwise greatest(need, min_last5)
--
-- Two columns are added at the end of the result, so the function is dropped
-- and created again.
-- =============================================================================

drop function if exists public.report_reorder_suggestions(uuid, uuid, integer, text, integer, integer, integer, uuid[], uuid[], uuid[], uuid[]);

create function public.report_reorder_suggestions(
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
  on_hand numeric, in_transit numeric, on_order numeric, suggested numeric,
  need numeric, min_last5 numeric
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
  -- Quantity of each product per posted purchase at the branch, newest first.
  buys as (
    select pl.product_id, p.id purchase_id, sum(pl.quantity) q,
           row_number() over (partition by pl.product_id order by p.document_date desc, p.created_at desc, p.id desc) rn
      from public.purchase_lines pl join public.purchases p on p.id = pl.purchase_id
     where p.company_id = p_company and p.branch_id = p_branch and p.document_status = 'posted'
       and pl.product_id in (select id from prods)
     group by pl.product_id, p.id, p.document_date, p.created_at
  ),
  last5 as (
    select b.product_id, min(b.q) q from buys b where b.rn <= 5 and b.q > 0 group by b.product_id
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
           coalesce(sb.quantity, 0) on_hand, coalesce(sb.qty_in_transit, 0) in_transit, coalesce(op.q, 0) on_order,
           l5.q min_last5
      from prods pr
      join sup s on s.product_id = pr.id
      left join dem d on d.product_id = pr.id
      left join hist h on h.product_id = pr.id
      left join public.stock_balances sb on sb.product_id = pr.id and sb.branch_id = p_branch
      left join open_po op on op.product_id = pr.id
      left join last5 l5 on l5.product_id = pr.id
     where (p_suppliers is null or s.supplier_id = any(p_suppliers))
  ),
  fin as (
    select c.*, greatest(0, ceil(c.avg_monthly / 30.4375 * (p_lead + p_safety + p_cover) - c.on_hand - c.in_transit - c.on_order)) need
      from calc c
  )
  select f.id, f.sku, f.name, f.brand, f.category, f.unit,
         f.supplier_id, sp.name, f.supplier_source,
         f.history_months, f.months_used,
         round(f.avg_6, 2), round(f.avg_9, 2), round(f.avg_12, 2), round(f.avg_monthly, 2),
         ceil(f.avg_monthly / 30.4375 * (p_lead + p_safety)),
         f.reorder_level,
         f.on_hand, f.in_transit, f.on_order,
         case when f.need > 0 then greatest(f.need, coalesce(f.min_last5, 0)) else 0 end,
         f.need, f.min_last5
    from fin f left join public.suppliers sp on sp.id = f.supplier_id
   order by sp.name nulls last, f.brand nulls last, f.name;
$$;

revoke all on function public.report_reorder_suggestions(uuid, uuid, integer, text, integer, integer, integer, uuid[], uuid[], uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.report_reorder_suggestions(uuid, uuid, integer, text, integer, integer, integer, uuid[], uuid[], uuid[], uuid[]) to service_role;
