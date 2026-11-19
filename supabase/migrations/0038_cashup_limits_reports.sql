-- =============================================================================
-- Hilty ERP - Migration 0038: daily cash-up, role limits, operational reports.
--
-- 1. Role limits (enforced by the app's server actions, which are the only
--    callers of the posting functions):
--      backdate_days     how many days back a document may be dated
--      max_discount_pct  largest reduction below the list price on a sale line
--      petty_cash_cap    largest expense that may be paid from a cash till
--    NULL = no limit. The Owner is never limited.
-- 2. cash_counts: end-of-day count of a branch till; the cash-up report sets it
--    against the till balance (over / short). A count posts nothing.
-- 3. Report functions that aggregate in the database (lists of any size):
--      report_daily_cashup, report_sales_summary, report_purchase_summary,
--      report_item_ranking.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Role limits
-- ---------------------------------------------------------------------------
alter table public.roles add column if not exists backdate_days integer;
alter table public.roles add column if not exists max_discount_pct numeric(5,2);
alter table public.roles add column if not exists petty_cash_cap numeric(18,2);
do $$ begin
  alter table public.roles add constraint roles_limits_check check (
    (backdate_days is null or backdate_days >= 0)
    and (max_discount_pct is null or (max_discount_pct >= 0 and max_discount_pct <= 100))
    and (petty_cash_cap is null or petty_cash_cap >= 0));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 2. Cash counts
-- ---------------------------------------------------------------------------
create table if not exists public.cash_counts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  payment_account_id uuid not null references public.payment_accounts(id) on delete restrict,
  count_date date not null,
  counted_amount numeric(18,2) not null check (counted_amount >= 0),
  expected_at_count numeric(18,2) not null,
  notes text,
  counted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (payment_account_id, count_date)
);
create index if not exists cash_counts_branch_date_idx on public.cash_counts(company_id, branch_id, count_date);

alter table public.cash_counts enable row level security;
drop policy if exists cash_counts_select on public.cash_counts;
create policy cash_counts_select on public.cash_counts for select to authenticated
  using (public.has_company_access(company_id) and public.current_user_has_branch(branch_id));
revoke all on public.cash_counts from anon, authenticated;
grant select on public.cash_counts to authenticated;
grant select, insert, update, delete on public.cash_counts to service_role;

-- ---------------------------------------------------------------------------
-- 3a. Daily cash-up: every branch till, every day of the range.
--     Movements come from the till's own ledger account, grouped by source.
-- ---------------------------------------------------------------------------
create or replace function public.report_daily_cashup(
  p_company uuid, p_branches uuid[], p_start date, p_end date
) returns table(
  day date, branch_id uuid, branch_code text, account_id uuid, account_code text, account_name text, account_type text,
  opening numeric, sales numeric, receipts numeric, other_in numeric, transfers_in numeric,
  expenses numeric, purchases numeric, transfers_out numeric, other_out numeric,
  closing numeric, counted numeric, difference numeric, count_notes text
) language sql stable security definer set search_path = public as $$
  with acc as (
    select pa.id, pa.code, pa.name, pa.account_type, pa.branch_id, pa.ledger_account_id, b.code as bcode
      from public.payment_accounts pa join public.branches b on b.id = pa.branch_id
     where pa.company_id = p_company and pa.branch_id is not null and pa.ledger_account_id is not null
       and (p_branches is null or pa.branch_id = any(p_branches))
  ), mv as (
    select a.id as acc_id, je.entry_date as d, je.source_type as st, (jl.debit - jl.credit) as amt
      from acc a
      join public.journal_lines jl on jl.account_id = a.ledger_account_id
      join public.journal_entries je on je.id = jl.journal_id
     where je.company_id = p_company and je.entry_date <= p_end
  ), cls as (
    select acc_id, d, amt,
      case
        when st in ('sale', 'sale_void', 'sales_return', 'sales_return_void') then 'sales'
        when st in ('customer_receipt', 'customer_receipt_void') then 'receipts'
        when st in ('expense', 'expense_void') then 'expenses'
        when st in ('purchase', 'purchase_void', 'supplier_payment', 'supplier_payment_void',
                    'purchase_return', 'purchase_return_void', 'supplier_refund') then 'purchases'
        when st in ('cash_transfer', 'cash_transfer_void') then 'transfer'
        else 'other'
      end as k
      from mv where d >= p_start
  ), day_sums as (
    select acc_id, d,
      coalesce(sum(amt) filter (where k = 'sales'), 0) as sales,
      coalesce(sum(amt) filter (where k = 'receipts'), 0) as receipts,
      coalesce(sum(amt) filter (where k = 'other' and amt > 0), 0) as other_in,
      coalesce(sum(amt) filter (where k = 'transfer' and amt > 0), 0) as transfers_in,
      coalesce(-sum(amt) filter (where k = 'expenses'), 0) as expenses,
      coalesce(-sum(amt) filter (where k = 'purchases'), 0) as purchases,
      coalesce(-sum(amt) filter (where k = 'transfer' and amt < 0), 0) as transfers_out,
      coalesce(-sum(amt) filter (where k = 'other' and amt < 0), 0) as other_out,
      sum(amt) as net
      from cls group by 1, 2
  ), opening as (
    select acc_id, coalesce(sum(amt), 0) as bal from mv where d < p_start group by 1
  ), grid as (
    select a.*, g.d::date as d
      from acc a cross join generate_series(p_start, p_end, interval '1 day') g(d)
  ), joined as (
    select g.d, g.branch_id, g.bcode, g.id, g.code, g.name, g.account_type,
      coalesce(o.bal, 0) + coalesce(sum(ds.net) over (partition by g.id order by g.d rows between unbounded preceding and 1 preceding), 0) as opening,
      coalesce(ds.sales, 0) as sales, coalesce(ds.receipts, 0) as receipts, coalesce(ds.other_in, 0) as other_in,
      coalesce(ds.transfers_in, 0) as transfers_in, coalesce(ds.expenses, 0) as expenses, coalesce(ds.purchases, 0) as purchases,
      coalesce(ds.transfers_out, 0) as transfers_out, coalesce(ds.other_out, 0) as other_out,
      coalesce(o.bal, 0) + coalesce(sum(ds.net) over (partition by g.id order by g.d), 0) as closing,
      cc.counted_amount, cc.notes,
      ds.acc_id is not null as moved
      from grid g
      left join day_sums ds on ds.acc_id = g.id and ds.d = g.d
      left join opening o on o.acc_id = g.id
      left join public.cash_counts cc on cc.payment_account_id = g.id and cc.count_date = g.d
  )
  select d, branch_id, bcode, id, code, name, account_type,
    round(opening, 2), round(sales, 2), round(receipts, 2), round(other_in, 2), round(transfers_in, 2),
    round(expenses, 2), round(purchases, 2), round(transfers_out, 2), round(other_out, 2),
    round(closing, 2), counted_amount, round(counted_amount - closing, 2), notes
    from joined
   where moved or counted_amount is not null or round(opening, 2) <> 0
   order by d desc, bcode, code;
$$;

-- ---------------------------------------------------------------------------
-- 3b. Sales summary, grouped by day, branch, user, category or payment method.
--     "method" lists money collected: sale payments by sale date plus
--     customer receipts by receipt date.
-- ---------------------------------------------------------------------------
create or replace function public.report_sales_summary(
  p_company uuid, p_branches uuid[], p_start date, p_end date, p_group text
) returns table(key text, label text, docs bigint, net numeric, tax numeric, gross numeric, cogs numeric, collected numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_group = 'method' then
    return query
      with col as (
        select sp.payment_account_id as acc, sp.amount, s.id as doc
          from public.sale_payments sp join public.sales s on s.id = sp.sale_id
         where s.company_id = p_company and s.document_status = 'posted'
           and s.document_date between p_start and p_end
           and (p_branches is null or s.branch_id = any(p_branches))
        union all
        select r.payment_account_id, r.amount, r.id
          from public.customer_receipts r
         where r.company_id = p_company and r.document_status = 'posted'
           and r.document_date between p_start and p_end
           and (p_branches is null or r.branch_id = any(p_branches))
      )
      select c.acc::text, pa.name, count(distinct c.doc), null::numeric, null::numeric, null::numeric, null::numeric, round(sum(c.amount), 2)
        from col c join public.payment_accounts pa on pa.id = c.acc
       group by c.acc, pa.name order by 8 desc;
  elsif p_group = 'category' then
    return query
      select coalesce(pc.id::text, '-'), coalesce(pc.name, 'Uncategorised'), count(distinct s.id),
        round(sum(l.net_amount), 2), round(sum(l.tax_amount), 2), round(sum(l.line_total), 2), round(sum(l.cogs), 2), null::numeric
        from public.sale_lines l join public.sales s on s.id = l.sale_id
        join public.products p on p.id = l.product_id
        left join public.product_categories pc on pc.id = p.category_id
       where s.company_id = p_company and s.document_status = 'posted'
         and s.document_date between p_start and p_end
         and (p_branches is null or s.branch_id = any(p_branches))
       group by pc.id, pc.name order by 6 desc;
  else
    return query
      select k.key, k.label, count(*), round(sum(s.net_total), 2), round(sum(s.tax_total), 2), round(sum(s.grand_total), 2),
        round(sum(s.cogs_total), 2), round(sum(s.amount_paid), 2)
        from public.sales s
        left join public.branches b on b.id = s.branch_id
        left join public.user_profiles u on u.id = coalesce(s.salesperson_id, s.created_by)
        cross join lateral (select
          case p_group when 'branch' then s.branch_id::text when 'user' then coalesce(u.id::text, '-') else s.document_date::text end as key,
          case p_group when 'branch' then b.code || ' - ' || b.name when 'user' then coalesce(u.full_name, u.email, 'Unknown')
               else to_char(s.document_date, 'DD/MM/YYYY') end as label) k
       where s.company_id = p_company and s.document_status = 'posted'
         and s.document_date between p_start and p_end
         and (p_branches is null or s.branch_id = any(p_branches))
       group by k.key, k.label
       order by case when p_group in ('branch', 'user') then null else k.key end desc nulls last, 6 desc;
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- 3c. Purchases summary, grouped by day, branch, supplier, category or method.
-- ---------------------------------------------------------------------------
create or replace function public.report_purchase_summary(
  p_company uuid, p_branches uuid[], p_start date, p_end date, p_group text
) returns table(key text, label text, docs bigint, net numeric, tax numeric, gross numeric, paid numeric, outstanding numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_group = 'method' then
    return query
      with pay as (
        select pp.payment_account_id as acc, pp.amount, p.id as doc
          from public.purchase_payments pp join public.purchases p on p.id = pp.purchase_id
         where p.company_id = p_company and p.document_status = 'posted'
           and p.document_date between p_start and p_end
           and (p_branches is null or p.branch_id = any(p_branches))
        union all
        select f.payment_account_id, f.amount, sp.id
          from public.supplier_payment_funding f join public.supplier_payments sp on sp.id = f.payment_id
         where sp.company_id = p_company and sp.document_status = 'posted'
           and sp.document_date between p_start and p_end
           and (p_branches is null or sp.branch_id = any(p_branches))
      )
      select x.acc::text, pa.name, count(distinct x.doc), null::numeric, null::numeric, null::numeric, round(sum(x.amount), 2), null::numeric
        from pay x join public.payment_accounts pa on pa.id = x.acc
       group by x.acc, pa.name order by 7 desc;
  elsif p_group = 'category' then
    return query
      select coalesce(pc.id::text, '-'), coalesce(pc.name, 'Uncategorised'), count(distinct p.id),
        round(sum(l.net_amount), 2), round(sum(l.tax_amount), 2), round(sum(l.gross_amount), 2), null::numeric, null::numeric
        from public.purchase_lines l join public.purchases p on p.id = l.purchase_id
        join public.products pr on pr.id = l.product_id
        left join public.product_categories pc on pc.id = pr.category_id
       where p.company_id = p_company and p.document_status = 'posted'
         and p.document_date between p_start and p_end
         and (p_branches is null or p.branch_id = any(p_branches))
       group by pc.id, pc.name order by 6 desc;
  else
    return query
      select k.key, k.label, count(*), round(sum(p.net_total), 2), round(sum(p.tax_total), 2), round(sum(p.grand_total), 2),
        round(sum(p.amount_paid), 2), round(sum(p.outstanding), 2)
        from public.purchases p
        left join public.branches b on b.id = p.branch_id
        left join public.suppliers su on su.id = p.supplier_id
        cross join lateral (select
          case p_group when 'branch' then p.branch_id::text when 'supplier' then p.supplier_id::text else p.document_date::text end as key,
          case p_group when 'branch' then b.code || ' - ' || b.name when 'supplier' then su.name
               else to_char(p.document_date, 'DD/MM/YYYY') end as label) k
       where p.company_id = p_company and p.document_status = 'posted'
         and p.document_date between p_start and p_end
         and (p_branches is null or p.branch_id = any(p_branches))
       group by k.key, k.label
       order by case when p_group in ('branch', 'supplier') then null else k.key end desc nulls last, 6 desc;
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- 3d. Item ranking: sales of each product in the period next to its stock,
--     for "top items" and "slow movers".
-- ---------------------------------------------------------------------------
create or replace function public.report_item_ranking(
  p_company uuid, p_branches uuid[], p_start date, p_end date
) returns table(product_id uuid, sku text, name text, category text, qty_sold numeric, revenue numeric, cogs numeric,
  profit numeric, invoices bigint, stock_qty numeric, stock_value numeric, last_sale date)
language sql stable security definer set search_path = public as $$
  with sold as (
    select l.product_id, sum(l.quantity) as q, sum(l.net_amount) as rev, sum(l.cogs) as c, count(distinct s.id) as inv
      from public.sale_lines l join public.sales s on s.id = l.sale_id
     where s.company_id = p_company and s.document_status = 'posted'
       and s.document_date between p_start and p_end
       and (p_branches is null or s.branch_id = any(p_branches))
     group by 1
  ), stock as (
    select sb.product_id, sum(sb.quantity) as q, sum(sb.stock_value) as v
      from public.stock_balances sb
     where sb.company_id = p_company and (p_branches is null or sb.branch_id = any(p_branches))
     group by 1
  ), last_s as (
    select l.product_id, max(s.document_date) as d
      from public.sale_lines l join public.sales s on s.id = l.sale_id
     where s.company_id = p_company and s.document_status = 'posted' and s.document_date <= p_end
       and (p_branches is null or s.branch_id = any(p_branches))
     group by 1
  )
  select p.id, p.sku, p.name, pc.name,
    round(coalesce(so.q, 0), 4), round(coalesce(so.rev, 0), 2), round(coalesce(so.c, 0), 2),
    round(coalesce(so.rev, 0) - coalesce(so.c, 0), 2), coalesce(so.inv, 0),
    round(coalesce(st.q, 0), 4), round(coalesce(st.v, 0), 2), ls.d
    from public.products p
    left join public.product_categories pc on pc.id = p.category_id
    left join sold so on so.product_id = p.id
    left join stock st on st.product_id = p.id
    left join last_s ls on ls.product_id = p.id
   where p.company_id = p_company and (so.product_id is not null or coalesce(st.q, 0) <> 0);
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.report_daily_cashup(uuid,uuid[],date,date)',
    'public.report_sales_summary(uuid,uuid[],date,date,text)',
    'public.report_purchase_summary(uuid,uuid[],date,date,text)',
    'public.report_item_ranking(uuid,uuid[],date,date)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
