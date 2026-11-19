-- =============================================================================
-- Hilty ERP - Migration 0041: payment methods assigned per branch (as in the
-- old system: Cash, CRDB Bank, Mixx by Yas, MPESA, NMB Bank).
--
-- A payment method is what users pick (Cash, MPESA...). Branches are given the
-- methods they may use. Underneath, money still sits in payment accounts:
--   - per-branch methods (cash, mobile money): one account per branch, each with
--     its own ledger account, so every branch keeps its own balance
--     (CASH-BUN -> 11101 ...). Assigning such a method to a branch creates its
--     account when missing.
--   - company-wide methods (banks): one account shared by all branches.
-- =============================================================================

create table if not exists public.payment_methods (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references public.companies(id) on delete restrict,
  code             text not null,
  name             text not null,
  method_type      text not null check (method_type in ('cash','bank','mobile_money')),
  per_branch       boolean not null default true,
  -- Ledger header the per-branch accounts are created under (e.g. 1110 Cash).
  ledger_parent_id uuid references public.chart_of_accounts(id) on delete restrict,
  provider         text,
  sort_order       integer not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  created_by       uuid references auth.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id) on delete set null,
  unique (company_id, code)
);

alter table public.payment_accounts add column if not exists payment_method_id uuid references public.payment_methods(id) on delete restrict;
create index if not exists payment_accounts_method_idx on public.payment_accounts(payment_method_id, branch_id);

create table if not exists public.branch_payment_methods (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete restrict,
  branch_id         uuid not null references public.branches(id) on delete cascade,
  payment_method_id uuid not null references public.payment_methods(id) on delete cascade,
  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id) on delete set null,
  unique (branch_id, payment_method_id)
);
create index if not exists branch_payment_methods_branch_idx on public.branch_payment_methods(branch_id);

drop trigger if exists trg_branch_payment_methods_company on public.branch_payment_methods;
create trigger trg_branch_payment_methods_company before insert or update on public.branch_payment_methods
  for each row execute function public.check_company_consistency('branch_id', 'branches', 'payment_method_id', 'payment_methods');

-- ---------------------------------------------------------------------------
-- The account a branch uses for a method; created for per-branch methods when
-- missing (with its own ledger account under the method's ledger header).
-- ---------------------------------------------------------------------------
create or replace function public.ensure_method_account(p_branch uuid, p_method uuid, p_user uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  m public.payment_methods;
  b public.branches;
  acc uuid;
  parent public.chart_of_accounts;
  n integer;
  gl uuid;
begin
  select * into m from public.payment_methods where id = p_method;
  select * into b from public.branches where id = p_branch;
  if m.id is null or b.id is null or m.company_id <> b.company_id then
    raise exception 'Payment method or branch not found' using errcode = 'P0001';
  end if;

  if not m.per_branch then
    select id into acc from public.payment_accounts
     where payment_method_id = m.id and branch_id is null order by is_active desc, created_at limit 1;
    if acc is null then
      raise exception 'Payment method % has no account; set its ledger account first', m.name using errcode = 'P0001';
    end if;
    return acc;
  end if;

  select id into acc from public.payment_accounts where payment_method_id = m.id and branch_id = b.id order by is_active desc limit 1;
  if acc is not null then
    update public.payment_accounts set is_active = true, updated_at = now(), updated_by = p_user where id = acc and not is_active;
    return acc;
  end if;

  select * into parent from public.chart_of_accounts where id = m.ledger_parent_id;
  if parent.id is null then
    raise exception 'Payment method % has no ledger header for branch accounts', m.name using errcode = 'P0001';
  end if;
  -- Next free child code: header code + running number (11101, 11102 ...).
  select coalesce(max(substr(c.code, length(parent.code) + 1)::int), 0) + 1 into n
    from public.chart_of_accounts c
   where c.company_id = m.company_id and c.parent_id = parent.id
     and c.code ~ ('^' || parent.code || '[0-9]+$');
  insert into public.chart_of_accounts(company_id, code, name, account_type, parent_id, normal_balance, allow_posting,
      is_system, is_active, is_control, cashflow_class, created_by)
  values (m.company_id, parent.code || n, m.name || ' - ' || b.name, 'asset', parent.id, 'debit', true, false, true, true,
          'unclassified', p_user)
  returning id into gl;
  insert into public.payment_accounts(company_id, branch_id, code, name, account_type, ledger_account_id, payment_method_id, is_active, created_by)
  values (m.company_id, b.id, m.code || '-' || b.code, m.name || ' - ' || b.name, m.method_type, gl, m.id, true, p_user)
  returning id into acc;
  return acc;
end; $$;

-- Replaces the methods a branch may use (accounts are kept; balances stay).
create or replace function public.set_branch_payment_methods(p_branch uuid, p_methods uuid[], p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare mid uuid; co uuid;
begin
  select company_id into co from public.branches where id = p_branch;
  if co is null then raise exception 'Branch not found' using errcode = 'P0001'; end if;
  if exists (select 1 from unnest(coalesce(p_methods, '{}')) x
              where not exists (select 1 from public.payment_methods m where m.id = x and m.company_id = co and m.is_active)) then
    raise exception 'A selected payment method is invalid or inactive' using errcode = 'P0001';
  end if;
  delete from public.branch_payment_methods where branch_id = p_branch and not (payment_method_id = any(coalesce(p_methods, '{}')));
  foreach mid in array coalesce(p_methods, '{}') loop
    perform public.ensure_method_account(p_branch, mid, p_user);
    insert into public.branch_payment_methods(company_id, branch_id, payment_method_id, created_by)
    values (co, p_branch, mid, p_user) on conflict (branch_id, payment_method_id) do nothing;
  end loop;
end; $$;

-- ---------------------------------------------------------------------------
-- Existing companies: the old system's five methods, linked to today's accounts
-- and assigned to every active branch.
-- ---------------------------------------------------------------------------
-- Nothing new is created here: a method is per branch when branch accounts
-- already exist for it (CASH-BUN ...), otherwise it uses its one company-wide
-- account. Each active branch is given the methods it already has an account
-- for (company-wide methods: every active branch). More can be assigned in
-- Admin -> Branches, which creates the branch account then.
do $$
declare
  c record;
  owner_id uuid;
begin
  select id into owner_id from public.user_profiles where is_primary_owner limit 1;
  for c in select id from public.companies loop
    insert into public.payment_methods(company_id, code, name, method_type, per_branch, ledger_parent_id, provider, sort_order)
    select c.id, v.code, v.name, v.kind,
           exists (select 1 from public.payment_accounts pa where pa.company_id = c.id and pa.branch_id is not null and pa.code like v.code || '-%'),
           (select id from public.chart_of_accounts where company_id = c.id and code = v.gl), v.provider, v.ord
      from (values ('CASH','Cash','cash','1110',null,1),
                   ('CRDB','CRDB Bank','bank',null,'CRDB Bank',2),
                   ('MIXX','Mixx by Yas','mobile_money','1132',null,3),
                   ('MPESA','MPESA','mobile_money','1131',null,4),
                   ('NMB','NMB Bank','bank',null,'NMB Bank',5)) v(code, name, kind, gl, provider, ord)
     where exists (select 1 from public.payment_accounts pa where pa.company_id = c.id and pa.is_active
                    and (pa.code = v.code or pa.code like v.code || '-%'))
    on conflict (company_id, code) do nothing;

    -- Link accounts: branch tills CASH-xxx / MPESA-xxx / MIXX-xxx, or the one company-wide account.
    update public.payment_accounts pa set payment_method_id = m.id
      from public.payment_methods m
     where pa.company_id = c.id and m.company_id = c.id and pa.payment_method_id is null
       and ((m.per_branch and pa.branch_id is not null and pa.code like m.code || '-%')
         or (not m.per_branch and pa.branch_id is null and pa.code = m.code));

    insert into public.branch_payment_methods(company_id, branch_id, payment_method_id, created_by)
    select c.id, b.id, m.id, owner_id
      from public.branches b join public.payment_methods m on m.company_id = c.id
     where b.company_id = c.id and b.is_active
       and exists (select 1 from public.payment_accounts pa where pa.payment_method_id = m.id and pa.is_active
                    and (pa.branch_id = b.id or (not m.per_branch and pa.branch_id is null)))
    on conflict (branch_id, payment_method_id) do nothing;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS: readable within the company; written only by the server.
-- ---------------------------------------------------------------------------
alter table public.payment_methods enable row level security;
alter table public.branch_payment_methods enable row level security;
drop policy if exists payment_methods_select on public.payment_methods;
create policy payment_methods_select on public.payment_methods for select to authenticated
  using (public.has_company_access(company_id));
drop policy if exists branch_payment_methods_select on public.branch_payment_methods;
create policy branch_payment_methods_select on public.branch_payment_methods for select to authenticated
  using (public.has_company_access(company_id));
revoke all on public.payment_methods, public.branch_payment_methods from anon, authenticated;
grant select on public.payment_methods, public.branch_payment_methods to authenticated;
grant select, insert, update, delete on public.payment_methods, public.branch_payment_methods to service_role;

revoke all on function public.ensure_method_account(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.set_branch_payment_methods(uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.ensure_method_account(uuid, uuid, uuid) to service_role;
grant execute on function public.set_branch_payment_methods(uuid, uuid[], uuid) to service_role;
