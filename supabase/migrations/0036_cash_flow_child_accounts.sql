-- =============================================================================
-- Hilty ERP - Migration 0036: cash-flow report covers every cash/bank/mobile
-- money account.
--
-- report_cash_flow listed the seeded account codes explicitly, so any account
-- added later under Cash (1110), Bank (1120) or Mobile Money (1130) - e.g. a
-- branch till or a new bank account - was left out of the statement. It now
-- takes those three headers and every account beneath them.
-- =============================================================================

create or replace function public.report_cash_flow(
  p_company uuid, p_start date, p_end date
)
returns table(source_type text, opening numeric, movement numeric)
language sql stable security definer set search_path = public as $$
  with recursive cash_accounts as (
    select id from public.chart_of_accounts
    where company_id = p_company and code in ('1110','1120','1130')
    union
    select c.id from public.chart_of_accounts c
    join cash_accounts a on c.parent_id = a.id
    where c.company_id = p_company
  )
  select je.source_type,
    coalesce(sum(case when je.entry_date < p_start then jl.debit - jl.credit else 0 end),0) as opening,
    coalesce(sum(case when je.entry_date between p_start and p_end then jl.debit - jl.credit else 0 end),0) as movement
  from public.journal_lines jl
  join public.journal_entries je on je.id = jl.journal_id
  where je.company_id = p_company and jl.account_id in (select id from cash_accounts)
  group by je.source_type;
$$;

revoke all on function public.report_cash_flow(uuid,date,date) from public, anon, authenticated;
grant execute on function public.report_cash_flow(uuid,date,date) to service_role;
