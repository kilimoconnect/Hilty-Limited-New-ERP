-- =============================================================================
-- Hilty ERP - Migration 0048: Edit posted sale (Owner only), keeping its number.
--
-- A posted sale is never changed in place. "Edit posted sale" makes a draft
-- copy that points at the original (sales.amends_sale_id). The original stays
-- posted while the copy is edited; deleting the copy changes nothing. When the
-- copy is posted, in the same transaction:
--   1. the original is reversed exactly as Void does (stock back at the cost
--      it left with, sales journal reversed) but dated on the original's date,
--      so that period shows the corrected figures;
--   2. the original is kept as voided, renamed "INV00597 (replaced)";
--   3. the copy is posted as INV00597 and linked both ways.
-- Refused when the original has posted customer receipts or returns, when
-- either date is in a closed period, or when the user is not the Owner.
-- post_sale below is the live definition with only the number step changed.
-- =============================================================================

alter table public.sales add column if not exists amends_sale_id uuid references public.sales(id) on delete set null;
alter table public.sales add column if not exists replaced_by_sale_id uuid references public.sales(id) on delete set null;
create index if not exists sales_amends_idx on public.sales(amends_sale_id) where amends_sale_id is not null;
-- One open correction per posted sale.
create unique index if not exists sales_one_open_amendment
  on public.sales(amends_sale_id) where amends_sale_id is not null and document_status = 'draft';

create or replace function public._replace_amended_sale(p_original uuid, p_new uuid, p_user uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  s public.sales; ln record; pay record; jlines jsonb := '[]'::jsonb;
  num text; n int := 1; renamed text;
begin
  if not public._user_is_owner(p_user) then
    raise exception 'Only the Owner can correct a posted sale' using errcode = '42501';
  end if;
  select * into s from public.sales where id = p_original for update;
  if not found then raise exception 'The sale being corrected was not found' using errcode = 'P0001'; end if;
  if s.document_status <> 'posted' then
    raise exception 'Sale % is no longer posted, so it cannot be corrected', coalesce(s.document_number, '') using errcode = 'P0001';
  end if;
  if (select company_id from public.sales where id = p_new) is distinct from s.company_id then
    raise exception 'The correction belongs to another company' using errcode = 'P0001';
  end if;
  perform public.assert_period_open(s.company_id, s.document_date);
  if exists (select 1 from public.customer_receipt_allocations a
             join public.customer_receipts r on r.id = a.receipt_id
             where a.sale_id = p_original and r.document_status = 'posted') then
    raise exception 'Sale % has customer payments received after the sale; void those first', s.document_number using errcode = 'P0001';
  end if;
  if exists (select 1 from public.sales_returns where sale_id = p_original and document_status = 'posted') then
    raise exception 'Sale % has returns; void those first', s.document_number using errcode = 'P0001';
  end if;

  -- 1. Reverse stock (back at the cost it left with), as void_sale does.
  for ln in select * from public.sale_lines where sale_id = p_original loop
    if ln.track_inventory and ln.quantity > 0 then
      perform public.record_stock_movement(s.company_id, s.branch_id, ln.product_id,
        'sale_void', 'sale_void', s.id, s.document_number, ln.quantity, 0, ln.unit_cost, p_user);
    end if;
  end loop;

  -- Reverse the sales journal, dated on the original sale's date.
  for pay in
    select public.resolve_payment_ledger(s.company_id, payment_account_id) as acc, sum(amount) as amt
    from public.sale_payments where sale_id = p_original group by 1
  loop
    jlines := jlines || jsonb_build_object('account_id', pay.acc, 'debit', 0, 'credit', pay.amt);
  end loop;
  if s.outstanding > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'1140'),'debit',0,'credit',s.outstanding);
  end if;
  if s.net_total > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'4100'),'debit',s.net_total,'credit',0);
  end if;
  if s.tax_total > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'2120'),'debit',s.tax_total,'credit',0);
  end if;
  if s.cogs_total > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'1150'),'debit',s.cogs_total,'credit',0);
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'5100'),'debit',0,'credit',s.cogs_total);
  end if;
  perform public.create_journal(s.company_id, s.branch_id, s.document_date, 'sale_void', s.id, s.document_number,
    'Corrected sale '||s.document_number||' (replaced)', p_user, jlines);

  -- 2. Keep the original as voided (the voiding triggers run as for Void) ...
  update public.sales set document_status = 'voided', voided_by = p_user, voided_at = now(),
    void_reason = 'Replaced by a corrected version (Edit posted sale)', replaced_by_sale_id = p_new
   where id = p_original;
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, reason, changed_by)
    values (s.company_id, 'sale', p_original, 'posted', 'voided', 'Replaced by a corrected version (Edit posted sale)', p_user);

  -- ... and free its number for the corrected sale: "INV00597 (replaced)", "(replaced 2)", ...
  num := s.document_number;
  loop
    renamed := num || case when n = 1 then ' (replaced)' else ' (replaced ' || n || ')' end;
    exit when not exists (select 1 from public.sales where company_id = s.company_id and document_number = renamed);
    n := n + 1;
  end loop;
  update public.sales set document_number = renamed where id = p_original;
  return num;
end; $$;

create or replace function public.post_sale(p_id uuid, p_user uuid, p_idem text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $$
declare
  s public.sales; ln record; pay record; docnum text;
  v_subtotal numeric(18,2):=0; v_disc numeric(18,2):=0; v_net numeric(18,2):=0;
  v_tax numeric(18,2):=0; v_grand numeric(18,2):=0; v_cogs numeric(18,2):=0;
  base numeric(18,2); net numeric(18,2); tax numeric(18,2); ltotal numeric(18,2);
  paid numeric(18,2); outstanding numeric(18,2); linecogs numeric(18,2);
  jlines jsonb := '[]'::jsonb;
begin
  select * into s from public.sales where id=p_id for update;
  if not found then raise exception 'Sale not found' using errcode='P0001'; end if;
  if s.document_status <> 'draft' then raise exception 'Sale already %', s.document_status using errcode='P0001'; end if;
  if not public.claim_idempotency(p_idem, 'post_sale', p_id) then return p_id; end if;
  perform public.assert_period_open(s.company_id, s.document_date);
  if not exists (select 1 from public.sale_lines where sale_id=p_id) then
    raise exception 'Sale has no lines' using errcode='P0001';
  end if;

  -- A correction of a posted sale (Edit posted sale): reverse the original and
  -- take over its number. Otherwise the next invoice number.
  if s.amends_sale_id is not null then
    docnum := public._replace_amended_sale(s.amends_sale_id, p_id, p_user);
  else
    docnum := public.next_document_number(s.company_id, s.branch_id, 'sales_invoice');
  end if;

  for ln in select * from public.sale_lines where sale_id=p_id order by line_no loop
    base := round(ln.quantity * ln.unit_price - ln.discount, 2);
    if base < 0 then raise exception 'Line discount exceeds line value' using errcode='P0001'; end if;
    if ln.tax_inclusive and ln.tax_rate > 0 then
      net := round(base / (1 + ln.tax_rate/100.0), 2);
      tax := round(base - net, 2);
      ltotal := base;
    else
      net := base;
      tax := round(base * ln.tax_rate/100.0, 2);
      ltotal := round(net + tax, 2);
    end if;
    v_subtotal := v_subtotal + round(ln.quantity * ln.unit_price, 2);
    v_disc := v_disc + ln.discount;
    v_net := v_net + net;
    v_tax := v_tax + tax;
    v_grand := v_grand + ltotal;

    linecogs := 0;
    if ln.track_inventory then
      linecogs := public.record_stock_movement(s.company_id, s.branch_id, ln.product_id,
        'sale','sale', s.id, docnum, 0, ln.quantity, 0, p_user);
      v_cogs := v_cogs + linecogs;
    end if;
    update public.sale_lines set net_amount=net, tax_amount=tax, line_total=ltotal,
      unit_cost = case when ln.quantity>0 then round(linecogs/ln.quantity,4) else 0 end, cogs=linecogs
      where id=ln.id;
  end loop;

  select coalesce(sum(amount),0) into paid from public.sale_payments where sale_id=p_id;
  if paid > v_grand + 0.001 then raise exception 'Payments exceed the sale total' using errcode='P0001'; end if;
  outstanding := round(v_grand - paid, 2);
  if outstanding > 0 and s.customer_id is null then
    raise exception 'A credit balance requires a customer' using errcode='P0001';
  end if;

  for pay in
    select public.resolve_payment_ledger(s.company_id, payment_account_id) as acc, sum(amount) as amt
    from public.sale_payments where sale_id=p_id group by 1
  loop
    jlines := jlines || jsonb_build_object('account_id', pay.acc, 'debit', pay.amt, 'credit', 0, 'memo','Payment received');
  end loop;
  if outstanding > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'1140'),'debit',outstanding,'credit',0,'memo','Accounts receivable');
  end if;
  if v_net > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'4100'),'debit',0,'credit',v_net,'memo','Sales revenue');
  end if;
  if v_tax > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'2120'),'debit',0,'credit',v_tax,'memo','Output VAT');
  end if;
  if v_cogs > 0 then
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'5100'),'debit',v_cogs,'credit',0,'memo','Cost of goods sold');
    jlines := jlines || jsonb_build_object('account_id', public.account_id_by_code(s.company_id,'1150'),'debit',0,'credit',v_cogs,'memo','Inventory');
  end if;

  perform public.create_journal(s.company_id, s.branch_id, s.document_date, 'sale', s.id, docnum,
    'Sale '||docnum, p_user, jlines);

  update public.sales set document_status='posted', document_number=docnum,
    subtotal=v_subtotal, discount_total=v_disc, net_total=v_net, tax_total=v_tax,
    grand_total=v_grand, cogs_total=v_cogs, posted_by=p_user, posted_at=now() where id=p_id;

  perform public.recalc_sale(p_id);
  insert into public.transaction_status_history(company_id, source_type, source_id, from_status, to_status, changed_by)
    values (s.company_id, 'sale', p_id, 'draft', 'posted', p_user);
  return p_id;
end; $$;

revoke all on function public._replace_amended_sale(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public._replace_amended_sale(uuid, uuid, uuid) to service_role;
