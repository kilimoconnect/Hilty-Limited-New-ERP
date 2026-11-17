-- =============================================================================
-- Old Hilty system -> new ERP: server-side import.
--
-- Reads ONLY the raw tables staged in schema `legacy` (see stage.ts) and replays
-- every old document, in date order, through the new system's own posting
-- functions (post_sale, post_purchase, post_expense, post_cash_transfer,
-- dispatch/receive transfer trips, post_inventory_opening). Stock quantities,
-- weighted-average cost, VAT, COGS, payables and journals are therefore
-- recalculated by the new system; the old system's computed figures (kardex
-- balances, WAC, ledgers) are NOT copied.
--
-- Old record ids are kept, so every new document can be traced to its source.
-- Each document is replayed in its own savepoint: a failure is written to
-- legacy.import_log and the run continues.
--
-- Run through run-import.ts (dry run rolls everything back).
-- =============================================================================

create schema if not exists legacy;

create table if not exists legacy.import_log (
  seq bigserial primary key,
  run_at timestamptz not null default now(),
  step text not null,
  old_id uuid,
  doc_no text,
  doc_date date,
  ok boolean not null,
  message text
);

create table if not exists legacy.ctx (
  company uuid, owner uuid, hq uuid, walkin uuid, vat18 uuid, zero uuid,
  nmb uuid, crdb uuid, acc_cash uuid, acc_mpesa uuid, acc_mixx uuid, acc_opex uuid
);

-- Event order of the replay, kept for stamping stock movements afterwards.
-- Documents are replayed in the order they were ENTERED in the old system (its
-- stock and cash checks ran in that order; some documents were back-dated).
-- Accounting uses each document's own date; stock movements keep the original
-- entry time, as the old kardex did.
drop table if exists legacy.replay_events;
create table legacy.replay_events (
  seq int primary key, kind text not null, old_id uuid not null, doc_no text,
  event_date date not null, entered_at timestamptz not null, ok boolean
);

-- ---------------------------------------------------------------------------
-- Lookups
-- ---------------------------------------------------------------------------
create or replace function legacy.br(p_old uuid) returns uuid language sql stable as $$
  select coalesce((select id from public.branches where id = p_old), (select hq from legacy.ctx));
$$;

-- Who a record is attributed to: the original user when they exist here,
-- otherwise the Owner (e.g. the old Owner login, whose id changed).
create or replace function legacy.uid(p_old uuid) returns uuid language sql stable as $$
  select case when p_old is not null and exists (select 1 from public.user_profiles where id = p_old)
              then p_old else (select owner from legacy.ctx) end;
$$;

-- Who posts: an ACTIVE original user, otherwise the Owner.
create or replace function legacy.actor(p_old uuid) returns uuid language sql stable as $$
  select case when p_old is not null and exists (select 1 from public.user_profiles where id = p_old and is_active)
              then p_old else (select owner from legacy.ctx) end;
$$;

create or replace function legacy.tax(p_rate numeric) returns uuid language sql stable as $$
  select case when coalesce(p_rate, 0) > 0 then (select vat18 from legacy.ctx) else (select zero from legacy.ctx) end;
$$;

-- Payment account for an old method code at a branch. Banks are company-wide;
-- cash and mobile-money tills are per branch, as they were in the old system.
create or replace function legacy.pa(p_branch uuid, p_code text) returns uuid language plpgsql stable as $$
declare r uuid; c text := upper(trim(p_code));
begin
  if c in ('NMB', 'CRDB') then
    select id into r from public.payment_accounts where company_id = (select company from legacy.ctx) and code = c;
  else
    select pa.id into r from public.payment_accounts pa join public.branches b on b.id = pa.branch_id
     where pa.company_id = (select company from legacy.ctx) and pa.branch_id = p_branch and pa.code = c || '-' || b.code;
  end if;
  if r is null then raise exception 'No payment account for method % at branch %', p_code, p_branch; end if;
  return r;
end; $$;

create or replace function legacy.slug(p text) returns text language sql immutable as $$
  select left(trim(both '-' from upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]+', '-', 'g'))), 40);
$$;

-- ---------------------------------------------------------------------------
-- Master data, users and settings
-- ---------------------------------------------------------------------------
create or replace function legacy.load_master() returns void language plpgsql as $$
declare c uuid; o uuid; hq uuid;
begin
  select id into c from public.companies where code = 'HILTY';
  select id into o from public.user_profiles where is_primary_owner;
  select id into hq from public.branches where company_id = c and code = 'HQ';
  if c is null or o is null then raise exception 'Company/Owner missing: run db:seed and bootstrap:owner first'; end if;

  delete from legacy.ctx;
  insert into legacy.ctx values (c, o, hq,
    (select id from public.customers where company_id = c and code = 'WALK-IN'),
    (select id from public.tax_codes where company_id = c and code = 'VAT18'),
    (select id from public.tax_codes where company_id = c and code = 'ZERO'),
    (select id from public.payment_accounts where company_id = c and code = 'NMB'),
    (select id from public.payment_accounts where company_id = c and code = 'CRDB'),
    (select id from public.chart_of_accounts where company_id = c and code = '1110'),
    (select id from public.chart_of_accounts where company_id = c and code = '1131'),
    (select id from public.chart_of_accounts where company_id = c and code = '1132'),
    (select id from public.chart_of_accounts where company_id = c and code = '6100'));

  -- Branches (old ids kept). The old, unused "Main Branch" maps onto Head Office.
  insert into public.branches(id, company_id, code, name, address, is_active, created_at, created_by)
  select b.id, c, b.code, b.name, nullif(concat_ws(', ', b.street, b.city, b.country), ''), b.is_active, b.created_at, o
    from legacy.ref_branches b where b.code <> 'MAIN'
  on conflict (id) do nothing;

  -- User profiles: every login that exists in the new project (users.ts).
  -- Old roles: Owner -> OWNER, Manager -> DIRECTOR, Cashier -> CASHIER.
  -- Logins with no profile in the old system are created inactive (AUDITOR).
  insert into public.user_profiles(id, email, full_name, phone, role_id, default_company_id, default_branch_id,
      is_active, is_primary_owner, created_by, updated_by)
  select u.id, lower(u.email), coalesce(a.name, split_part(u.email, '@', 1)), a.phone,
    (select id from public.roles where code = case r.name when 'Owner' then 'OWNER' when 'Manager' then 'DIRECTOR'
                                                         when 'Cashier' then 'CASHIER' else 'AUDITOR' end),
    c,
    (select legacy.br(ub.branch_id) from legacy.sec_user_branches ub where ub.user_id = u.id order by ub.branch_id limit 1),
    coalesce(a.is_active, false), false, o, o
  from auth.users u
  left join legacy.sec_app_users a on a.id = u.id
  left join legacy.sec_user_roles ur on ur.user_id = u.id
  left join legacy.sec_roles r on r.id = ur.role_id
  where u.id <> o and not exists (select 1 from public.user_profiles p where p.id = u.id)
    and lower(u.email) like '%@hilty.co.tz';

  insert into public.user_company_access(user_id, company_id, created_by)
  select p.id, c, o from public.user_profiles p where p.id <> o
  on conflict (user_id, company_id) do nothing;

  insert into public.user_branch_access(user_id, branch_id, is_default, created_by)
  select distinct on (ub.user_id, legacy.br(ub.branch_id)) ub.user_id, legacy.br(ub.branch_id),
         legacy.br(ub.branch_id) = p.default_branch_id, o
    from legacy.sec_user_branches ub join public.user_profiles p on p.id = ub.user_id
   where p.id <> o
     and not exists (select 1 from public.user_branch_access x where x.user_id = ub.user_id and x.branch_id = legacy.br(ub.branch_id));

  -- Units (matched by code), brands, categories.
  insert into public.units(id, company_id, code, name, is_active, created_by)
  select u.id, c, upper(u.code), u.name, u.is_active, o from legacy.ref_units u
   where not exists (select 1 from public.units x where x.company_id = c and x.code = upper(u.code));

  insert into public.brands(id, company_id, code, name, is_active, created_at, created_by)
  select id, c, legacy.slug(name) || case when n > 1 then '-' || n else '' end, name, is_active, created_at, o
    from (select *, row_number() over (partition by legacy.slug(name) order by created_at, id) n from legacy.ref_brands) b
  on conflict (id) do nothing;

  insert into public.product_categories(id, company_id, code, name, is_active, created_at, created_by)
  select id, c, legacy.slug(name) || case when n > 1 then '-' || n else '' end, name, is_active, created_at, o
    from (select *, row_number() over (partition by legacy.slug(name) order by created_at, id) n from legacy.ref_categories) k
  on conflict (id) do nothing;

  -- Products (old ids and codes kept).
  insert into public.products(id, company_id, sku, name, category_id, brand_id, base_unit_id, purchase_price, selling_price,
      tax_code_id, reorder_level, track_inventory, is_active, created_at, created_by)
  select p.id, c, p.code, p.name, p.category_id, p.brand_id,
    (select x.id from public.units x join legacy.ref_units u on upper(u.code) = x.code where u.id = p.unit_id and x.company_id = c),
    coalesce(p.purchase_price, p.cost_price, 0), coalesce(p.selling_price, 0),
    legacy.tax((select t.rate from legacy.ref_tax_codes t where t.id = p.tax_code_id)),
    coalesce(p.reorder_level, 0), true, p.is_active, p.created_at, o
  from legacy.public_products p
  on conflict (id) do nothing;

  -- Suppliers / customers from the old contacts register.
  insert into public.suppliers(id, company_id, code, name, phone, email, tin, address, is_active, created_at, created_by)
  select id, c, 'SUP-' || lpad(row_number() over (order by created_at, id)::text, 3, '0'), display_name, phone, email, tax_id, address,
         is_active, created_at, o
    from legacy.public_ops_contacts where kind in ('SUPPLIER', 'BOTH')
  on conflict (id) do nothing;

  insert into public.customers(id, company_id, code, name, phone, email, tin, address, is_active, created_at, created_by)
  select id, c, 'CUS-' || lpad(row_number() over (order by created_at, id)::text, 3, '0'), display_name, phone, email, tax_id, address,
         is_active, created_at, o
    from legacy.public_ops_contacts where kind in ('CUSTOMER', 'BOTH')
  on conflict (id) do nothing;

  -- Expense categories (all post to Operating Expenses 6100).
  insert into public.expense_categories(id, company_id, code, name, description, expense_account_id, is_active, created_at, created_by)
  select id, c, code, name, category_group, (select acc_opex from legacy.ctx), is_active, created_at, o
    from legacy.ref_expense_categories
  on conflict (id) do nothing;

  -- Payment tills per branch for cash / M-Pesa / Mixx (banks stay company-wide),
  -- each with its own ledger account so every till keeps its own balance:
  --   Cash 1110 -> 1110n, M-Pesa 1131 -> 1131n, Mixx 1132 -> 1132n (n = branch no.).
  update public.chart_of_accounts set name = 'Mixx by Yas' where company_id = c and code = '1132' and name = 'MIX';
  create temp table if not exists _tills(code text, label text, kind text, parent uuid) on commit drop;
  delete from _tills;
  insert into _tills values ('CASH', 'Cash', 'cash', (select acc_cash from legacy.ctx)),
                            ('MPESA', 'M-Pesa', 'mobile_money', (select acc_mpesa from legacy.ctx)),
                            ('MIXX', 'Mixx by Yas', 'mobile_money', (select acc_mixx from legacy.ctx));
  insert into public.chart_of_accounts(company_id, code, name, account_type, parent_id, normal_balance, allow_posting,
      is_system, is_active, is_control, cashflow_class, created_by)
  select c, pa.code || bn.n, m.label || ' - ' || bn.name, 'asset', m.parent, 'debit', true, false, true, true, 'unclassified', o
    from _tills m join public.chart_of_accounts pa on pa.id = m.parent
    cross join (select id, name, row_number() over (order by code) n from public.branches
                 where company_id = c and code <> 'HQ') bn
   where not exists (select 1 from public.chart_of_accounts x where x.company_id = c and x.code = pa.code || bn.n);
  insert into public.payment_accounts(company_id, branch_id, code, name, account_type, ledger_account_id, is_active, created_by)
  select c, bn.id, m.code || '-' || bn.code, m.label || ' - ' || bn.name, m.kind,
         (select x.id from public.chart_of_accounts x where x.company_id = c and x.code = pa.code || bn.n), true, o
    from _tills m join public.chart_of_accounts pa on pa.id = m.parent
    cross join (select id, code, name, row_number() over (order by code) n from public.branches
                 where company_id = c and code <> 'HQ') bn
   where not exists (select 1 from public.payment_accounts x where x.company_id = c and x.code = m.code || '-' || bn.code);
  -- The company-wide Cash / M-Pesa / MIX accounts from the seed are replaced by the branch tills.
  update public.payment_accounts set is_active = false where company_id = c and code in ('CASH', 'MPESA', 'MIX');
end; $$;

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
create or replace function legacy.imp_opening(p_branch uuid, p_date date) returns void language plpgsql as $$
declare id_ uuid; o uuid := (select owner from legacy.ctx);
begin
  insert into public.inventory_openings(company_id, branch_id, opening_date, reference, description, created_by)
  values ((select company from legacy.ctx), legacy.br(p_branch), p_date, 'Old system opening stock',
          'Opening stock carried over from the old system (kardex opening balances).', o)
  returning id into id_;
  -- The old opening costs include VAT (as all old purchase costs did); the new
  -- system carries stock net of recoverable VAT, so take the VAT out using the
  -- product's old tax rate.
  insert into public.inventory_opening_lines(opening_id, product_id, quantity, unit_cost, line_no)
  select id_, x.product_id, x.q, round(x.v / x.q / (1 + coalesce(t.rate, 0)), 4), row_number() over (order by x.product_id)
    from (select product_id, sum(qty) q, sum(qty * unit_cost) v
            from legacy.public_kardex where movement_type = 'OPENING_BALANCE' and branch_id = p_branch
           group by product_id) x
    left join legacy.public_products p on p.id = x.product_id
    left join legacy.ref_tax_codes t on t.id = p.tax_code_id
   where x.q > 0;
  perform public.post_inventory_opening(id_, o, null);
end; $$;

create or replace function legacy.imp_sale(p_id uuid) returns void language plpgsql as $$
declare s legacy.fin_sales; b uuid;
begin
  select * into s from legacy.fin_sales where id = p_id;
  b := legacy.br(s.branch_id);
  insert into public.sales(id, company_id, branch_id, document_date, customer_id, customer_reference, salesperson_id, notes,
      created_by, created_at, grand_total)
  values (s.id, (select company from legacy.ctx), b, s.doc_date, (select walkin from legacy.ctx),
          nullif(trim(coalesce(s.walkin_name, s.customer_ref, '')), ''), legacy.uid(s.created_by),
          'Old system ' || s.doc_no, legacy.uid(s.created_by), s.created_at, s.total_amount);
  insert into public.sale_lines(sale_id, product_id, description, quantity, unit_price, original_price, discount, tax_code_id,
      tax_rate, tax_type, tax_name, tax_inclusive, track_inventory, line_no)
  select s.id, l.product_id, p.name, l.quantity, l.unit_price, l.unit_price, coalesce(l.discount_abs, 0), t.id,
         round(coalesce(l.vat_rate, 0) * 100, 4), t.tax_type, t.name, upper(coalesce(l.vat_mode, 'INCL')) = 'INCL', p.track_inventory,
         row_number() over (order by l.created_at, l.id)
    from legacy.fin_sale_lines l join public.products p on p.id = l.product_id
    join public.tax_codes t on t.id = legacy.tax(l.vat_rate)
   where l.sale_id = s.id;
  insert into public.sale_payments(sale_id, payment_account_id, amount, payment_date, created_at)
  select s.id, legacy.pa(b, sp.payment_method), sp.amount, s.doc_date, sp.created_at
    from legacy.fin_sale_payments sp where sp.sale_id = s.id and sp.amount > 0;
  perform public.post_sale(s.id, legacy.actor(s.posted_by), null);
end; $$;

create or replace function legacy.imp_purchase(p_id uuid) returns void language plpgsql as $$
declare p legacy.fin_purchases; b uuid; credit boolean; grand numeric(18,2); paid numeric(18,2); inv text; big uuid;
begin
  select * into p from legacy.fin_purchases where id = p_id;
  b := legacy.br(p.branch_id);
  credit := coalesce(p.balance, 0) >= 1;
  -- Same arithmetic as post_purchase, so a fully paid purchase stays fully paid.
  select coalesce(sum(case when upper(vat_mode) = 'INCL' and vat_rate > 0
                           then round(quantity * unit_cost, 2)
                           else round(quantity * unit_cost, 2) + round(round(quantity * unit_cost, 2) * vat_rate, 2) end), 0)
    into grand from legacy.fin_purchase_lines where purchase_id = p.id;
  select coalesce(sum(amount), 0) into paid from legacy.fin_purchase_payments where purchase_id = p.id and amount > 0;
  inv := nullif(trim(coalesce(p.supplier_ref, '')), '');
  if inv is not null and exists (select 1 from public.purchases x where x.supplier_id = p.supplier_id
                                   and x.supplier_invoice_norm = public.norm_invoice(inv) and x.document_status = 'posted') then
    inv := inv || ' (' || p.doc_no || ')';
  end if;

  insert into public.purchases(id, company_id, branch_id, document_date, supplier_invoice_date, supplier_invoice_number,
      internal_reference, supplier_id, notes, is_credit, due_date, created_by, created_at)
  values (p.id, (select company from legacy.ctx), b, p.doc_date, p.doc_date, inv, p.doc_no, p.supplier_id,
          'Old system ' || p.doc_no, credit, case when credit then p.doc_date + 30 end, legacy.uid(p.created_by), p.created_at);
  insert into public.purchase_lines(purchase_id, product_id, description, quantity, unit_cost, discount, tax_code_id, tax_rate,
      tax_type, tax_name, tax_inclusive, is_recoverable, track_inventory, line_no)
  select p.id, l.product_id, pr.name, l.quantity, l.unit_cost, 0, t.id, round(coalesce(l.vat_rate, 0) * 100, 4),
         t.tax_type, t.name, upper(coalesce(l.vat_mode, 'INCL')) = 'INCL', coalesce(l.vat_rate, 0) > 0, pr.track_inventory,
         row_number() over (order by l.created_at, l.id)
    from legacy.fin_purchase_lines l join public.products pr on pr.id = l.product_id
    join public.tax_codes t on t.id = legacy.tax(l.vat_rate)
   where l.purchase_id = p.id;
  insert into public.purchase_payments(purchase_id, payment_account_id, amount, payment_date, created_at)
  select p.id, legacy.pa(b, pp.payment_method), pp.amount, p.doc_date, pp.created_at
    from legacy.fin_purchase_payments pp where pp.purchase_id = p.id and pp.amount > 0;
  -- Old cents-level rounding (paid within TZS 1 of the total): settle exactly.
  if not credit and paid > 0 and abs(grand - paid) < 1 and grand <> paid then
    select id into big from public.purchase_payments where purchase_id = p.id order by amount desc limit 1;
    update public.purchase_payments set amount = amount + (grand - paid) where id = big;
  end if;
  perform public.post_purchase(p.id, legacy.actor(p.posted_by), null);
end; $$;

create or replace function legacy.imp_expense(p_id uuid) returns void language plpgsql as $$
declare e legacy.ops_petty_cash; b uuid;
begin
  select * into e from legacy.ops_petty_cash where id = p_id;
  b := legacy.br(e.branch_id);
  insert into public.expenses(id, company_id, branch_id, document_date, expense_category_id, reference, description,
      tax_code_id, tax_name, tax_rate, tax_inclusive, is_recoverable, net_total, tax_total, grand_total, created_by, created_at)
  values (e.id, (select company from legacy.ctx), b, e.doc_date, e.category_id,
          e.doc_no || coalesce(' / ' || nullif(trim(e.reference_no), ''), ''),
          nullif(concat_ws(' - ', nullif(trim(e.payee), ''), nullif(trim(e.description), '')), ''),
          (select zero from legacy.ctx), (select name from public.tax_codes where id = (select zero from legacy.ctx)),
          0, false, false, e.amount, 0, e.amount, legacy.uid(e.created_by), e.created_at);
  insert into public.expense_payments(expense_id, payment_account_id, amount, payment_date, created_at)
  values (e.id, legacy.pa(b, e.payment_method_code), e.amount, e.doc_date, e.created_at);
  perform public.post_expense(e.id, legacy.actor(e.posted_by), null);
end; $$;

create or replace function legacy.imp_cash_transfer(p_id uuid) returns void language plpgsql as $$
declare t legacy.ops_cash_transfers; b uuid;
begin
  select * into t from legacy.ops_cash_transfers where id = p_id;
  b := legacy.br(t.branch_id);
  insert into public.cash_transfers(id, company_id, transfer_date, source_account_id, destination_account_id,
      source_branch_id, destination_branch_id, amount, fee, reference, description, created_by, created_at)
  values (t.id, (select company from legacy.ctx), t.transfer_date, legacy.pa(b, t.from_method_code), legacy.pa(b, t.to_method_code),
          b, b, t.amount, 0, t.doc_no || coalesce(' / ' || nullif(trim(t.reference), ''), ''), nullif(trim(t.note), ''),
          legacy.uid(t.created_by), t.created_at);
  perform public.post_cash_transfer(t.id, legacy.actor(t.posted_by), null);
end; $$;

create or replace function legacy.imp_transfer_dispatch(p_id uuid) returns void language plpgsql as $$
declare t legacy.fin_transfers; o uuid := (select owner from legacy.ctx); c uuid := (select company from legacy.ctx);
begin
  select * into t from legacy.fin_transfers where id = p_id;
  insert into public.stock_transfers(id, company_id, source_branch_id, destination_branch_id, transfer_date, reference, notes,
      created_by, created_at)
  values (t.id, c, legacy.br(t.from_branch_id), legacy.br(t.to_branch_id), t.doc_date, t.doc_no,
          coalesce(nullif(trim(t.note), ''), 'Old system ' || t.doc_no), o, t.created_at);
  insert into public.stock_transfer_lines(transfer_id, company_id, product_id, qty_requested, line_no)
  select t.id, c, l.product_id, l.qty, row_number() over (order by l.id)
    from legacy.fin_transfer_lines l where l.transfer_id = t.id and l.qty > 0;
  perform public.dispatch_stock_transfer(t.id, o, 'legacy:dispatch:' || t.id);
end; $$;

create or replace function legacy.imp_transfer_receive(p_id uuid) returns void language plpgsql as $$
declare t legacy.fin_transfers; o uuid := (select owner from legacy.ctx); d uuid; items jsonb;
begin
  select * into t from legacy.fin_transfers where id = p_id;
  select id into d from public.stock_transfer_dispatches where transfer_id = t.id order by trip_no limit 1;
  if d is null then raise exception 'Transfer % was not dispatched', t.doc_no; end if;
  select jsonb_agg(jsonb_build_object('dispatch_line_id', dl.id, 'accepted', dl.qty)) into items
    from public.stock_transfer_dispatch_lines dl where dl.dispatch_id = d;
  perform public.receive_transfer_trip(d, o, items,
    coalesce(t.received_at, (t.received_date + time '12:00') at time zone 'Africa/Dar_es_Salaam',
             (t.doc_date + time '12:00') at time zone 'Africa/Dar_es_Salaam'),
    'Received in the old system', null, 'legacy:receive:' || t.id, 'legacy:receive:' || t.id);
end; $$;

-- ---------------------------------------------------------------------------
-- Driver
-- ---------------------------------------------------------------------------
create or replace function legacy.run_import(p_opening_date date) returns table(step text, total int, ok int, failed int)
language plpgsql as $$
#variable_conflict use_column
declare ev record; err text;
begin
  perform legacy.load_master();

  -- Let tills go overdrawn while history is replayed (the old system kept no
  -- opening cash/bank balances); restored below and reported afterwards.
  update public.payment_accounts set allow_negative = true, overdraft_limit = 1e14, overdraft_start = null, overdraft_end = null
   where company_id = (select company from legacy.ctx);

  delete from legacy.replay_events;
  insert into legacy.replay_events(seq, kind, old_id, doc_no, event_date, entered_at)
  select row_number() over (order by ts, rank, id), kind, id, doc_no, d, ts from (
    select p_opening_date d, 0 rank, min(created_at) ts, 'opening' kind, branch_id id, 'Opening stock' doc_no
      from legacy.public_kardex where movement_type = 'OPENING_BALANCE' group by branch_id
    union all select doc_date, 1, created_at, 'purchase', id, doc_no from legacy.fin_purchases where status = 'POSTED'
    union all select doc_date, 2, coalesce(sent_at, created_at), 'transfer_dispatch', id, doc_no from legacy.fin_transfers where status <> 'DRAFT'
    union all select coalesce((received_at at time zone 'Africa/Dar_es_Salaam')::date, received_date, doc_date), 3,
                     coalesce(received_at, updated_at, created_at), 'transfer_receive', id, doc_no
                from legacy.fin_transfers where status = 'RECEIVED'
    union all select doc_date, 4, created_at, 'sale', id, doc_no from legacy.fin_sales where status = 'POSTED'
    union all select doc_date, 5, created_at, 'expense', id, doc_no from legacy.ops_petty_cash where is_posted
    union all select transfer_date, 6, created_at, 'cash_transfer', id, doc_no from legacy.ops_cash_transfers where is_posted
  ) x;

  for ev in select * from legacy.replay_events order by seq loop
    begin
      case ev.kind
        when 'opening' then perform legacy.imp_opening(ev.old_id, ev.event_date);
        when 'purchase' then perform legacy.imp_purchase(ev.old_id);
        when 'transfer_dispatch' then perform legacy.imp_transfer_dispatch(ev.old_id);
        when 'transfer_receive' then perform legacy.imp_transfer_receive(ev.old_id);
        when 'sale' then perform legacy.imp_sale(ev.old_id);
        when 'expense' then perform legacy.imp_expense(ev.old_id);
        when 'cash_transfer' then perform legacy.imp_cash_transfer(ev.old_id);
      end case;
      update legacy.replay_events set ok = true where seq = ev.seq;
    exception when others then
      get stacked diagnostics err = message_text;
      update legacy.replay_events set ok = false where seq = ev.seq;
      insert into legacy.import_log(step, old_id, doc_no, doc_date, ok, message)
      values (ev.kind, ev.old_id, ev.doc_no, ev.event_date, false, err);
    end;
  end loop;

  -- Give each stock movement its original entry time (instead of the moment it
  -- was replayed), so the kardex and as-of valuations read as they happened.
  alter table public.stock_movements disable trigger trg_stock_movements_no_update;
  with ev as (
    select r.* from legacy.replay_events r where r.ok
  ), m as (
    select sm.id, ev.entered_at, row_number() over (partition by ev.seq order by sm.created_at, sm.id) as k
      from public.stock_movements sm
      join ev on (
        (ev.kind = 'opening' and sm.source_type = 'inventory_opening' and sm.branch_id = legacy.br(ev.old_id)
           and sm.source_id in (select id from public.inventory_openings where reference = 'Old system opening stock'))
        or (ev.kind = 'transfer_dispatch' and sm.source_id = ev.old_id and sm.movement_type = 'transfer_out')
        or (ev.kind = 'transfer_receive' and sm.source_id = ev.old_id and sm.movement_type = 'transfer_in')
        or (ev.kind in ('purchase', 'sale') and sm.source_id = ev.old_id))
  )
  update public.stock_movements sm
     set created_at = m.entered_at + m.k * interval '1 microsecond'
    from m where m.id = sm.id;
  alter table public.stock_movements enable trigger trg_stock_movements_no_update;

  update public.stock_balances sb set last_movement_at = x.t
    from (select company_id, branch_id, product_id, max(created_at) t from public.stock_movements group by 1, 2, 3) x
   where x.company_id = sb.company_id and x.branch_id = sb.branch_id and x.product_id = sb.product_id;

  update public.stock_transfers st set dispatched_at = coalesce(o.sent_at, o.created_at)
    from legacy.fin_transfers o where o.id = st.id;
  update public.stock_transfer_dispatches d set dispatched_at = coalesce(o.sent_at, o.created_at)
    from legacy.fin_transfers o where o.id = d.transfer_id;

  update public.payment_accounts set allow_negative = false, overdraft_limit = 0
   where company_id = (select company from legacy.ctx);

  return query
    select r.kind, count(*)::int, count(*) filter (where r.ok)::int, count(*) filter (where not r.ok)::int
      from legacy.replay_events r group by r.kind order by min(r.seq);
end; $$;
