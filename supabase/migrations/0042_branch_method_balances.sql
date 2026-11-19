-- =============================================================================
-- Hilty ERP - Migration 0042: balance of each payment method per branch.
--
-- Each branch sees its own balance for every payment method, as the old
-- system's payment-method ledger did (branch + method):
--   - per-branch methods (cash, mobile money): the branch's own account.
--   - shared methods (banks): the movements of that branch's documents
--     (journal_entries.branch_id) on the bank account. The branch shares add
--     up to the bank's total.
-- Listed: the methods assigned to the branch, and any other method that
-- still holds a balance there.
-- =============================================================================

create or replace function public.report_branch_method_balances(p_company uuid, p_branches uuid[])
returns table(branch_id uuid, payment_method_id uuid, payment_account_id uuid, assigned boolean, balance numeric)
language sql stable security definer set search_path = public as $$
  with br as (
    select b.id from public.branches b
     where b.company_id = p_company and (p_branches is null or b.id = any(p_branches))
  ),
  pairs as (
    select br.id branch_id, m.id method_id, m.per_branch,
           case when m.per_branch
                then (select pa.id from public.payment_accounts pa where pa.payment_method_id = m.id and pa.branch_id = br.id order by pa.is_active desc limit 1)
                else (select pa.id from public.payment_accounts pa where pa.payment_method_id = m.id and pa.branch_id is null order by pa.is_active desc limit 1)
           end account_id,
           exists (select 1 from public.branch_payment_methods x where x.branch_id = br.id and x.payment_method_id = m.id) assigned
      from br cross join public.payment_methods m
     where m.company_id = p_company
  ),
  bal as (
    select p.*,
           coalesce((select sum(l.debit - l.credit)
                       from public.journal_lines l join public.journal_entries j on j.id = l.journal_id
                      where l.account_id = (select ledger_account_id from public.payment_accounts where id = p.account_id)
                        and (p.per_branch or j.branch_id = p.branch_id)), 0) balance
      from pairs p where p.account_id is not null
  )
  select branch_id, method_id, account_id, assigned, round(balance, 2)
    from bal where assigned or balance <> 0;
$$;

revoke all on function public.report_branch_method_balances(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.report_branch_method_balances(uuid, uuid[]) to service_role;
