-- =============================================================================
-- Hilty ERP - Migration 0044: selling prices follow sales, upward only.
--
-- 1. When a sale is posted at any branch, each product sold above its
--    selling price gets that price (the highest on the sale). Prices never go
--    down automatically. Every change is written to product_price_changes.
-- 2. revise_prices_from_recent_sales(company, days): one-off revision - the
--    price each product sold at most often over the last `days` (posted sales,
--    all branches; a tie takes the higher price) becomes its selling price
--    when it is higher than now. Returns how many prices went up.
-- Prices compared are as entered on the sale (VAT inclusive), the same basis
-- as products.selling_price.
-- =============================================================================

create or replace function public.raise_prices_from_sale(p_sale uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare s public.sales; n integer := 0; r record;
begin
  select * into s from public.sales where id = p_sale;
  if not found or s.document_status <> 'posted' then return 0; end if;
  for r in
    select p.id, p.company_id, p.selling_price old_price, x.price new_price
      from (select sl.product_id, max(sl.unit_price) price
              from public.sale_lines sl where sl.sale_id = p_sale and sl.product_id is not null
             group by sl.product_id) x
      join public.products p on p.id = x.product_id
     where x.price > p.selling_price and p.company_id = s.company_id
     for update of p
  loop
    insert into public.product_price_changes(company_id, product_id, old_price, new_price, basis, reason, changed_by)
      values (r.company_id, r.id, r.old_price, round(r.new_price, 2),
              jsonb_build_object('source', 'sale', 'sale_id', p_sale, 'branch_id', s.branch_id),
              'Raised to the price of sale ' || coalesce(s.document_number, ''), coalesce(s.posted_by, s.updated_by, s.created_by));
    update public.products set selling_price = round(r.new_price, 2) where id = r.id;
    n := n + 1;
  end loop;
  return n;
end; $$;

create or replace function public.trg_sale_raise_prices()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.document_status = 'posted' and old.document_status is distinct from 'posted' then
    perform public.raise_prices_from_sale(new.id);
  end if;
  return null;
end; $$;
drop trigger if exists trg_sales_raise_prices on public.sales;
create trigger trg_sales_raise_prices after update of document_status on public.sales
  for each row execute function public.trg_sale_raise_prices();

create or replace function public.revise_prices_from_recent_sales(p_company uuid, p_days integer default 30)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; r record;
begin
  for r in
    with lines as (
      select sl.product_id, sl.unit_price price, count(*) c
        from public.sale_lines sl join public.sales s on s.id = sl.sale_id
       where s.company_id = p_company and s.document_status = 'posted' and sl.product_id is not null
         and s.document_date > current_date - p_days and sl.unit_price > 0
       group by sl.product_id, sl.unit_price
    ), mode as (
      select distinct on (product_id) product_id, price
        from lines order by product_id, c desc, price desc
    )
    select p.id, p.selling_price old_price, m.price new_price
      from mode m join public.products p on p.id = m.product_id
     where p.company_id = p_company and m.price > p.selling_price
  loop
    insert into public.product_price_changes(company_id, product_id, old_price, new_price, basis, reason)
      values (p_company, r.id, r.old_price, round(r.new_price, 2),
              jsonb_build_object('source', 'recent_sales_mode', 'days', p_days),
              'Revised to the most common sale price of the last ' || p_days || ' days');
    update public.products set selling_price = round(r.new_price, 2) where id = r.id;
    n := n + 1;
  end loop;
  return n;
end; $$;

revoke all on function public.raise_prices_from_sale(uuid) from public, anon, authenticated;
revoke all on function public.trg_sale_raise_prices() from public, anon, authenticated;
revoke all on function public.revise_prices_from_recent_sales(uuid, integer) from public, anon, authenticated;
grant execute on function public.raise_prices_from_sale(uuid) to service_role;
grant execute on function public.revise_prices_from_recent_sales(uuid, integer) to service_role;
