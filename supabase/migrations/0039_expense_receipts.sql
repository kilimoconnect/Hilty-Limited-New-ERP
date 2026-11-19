-- =============================================================================
-- Hilty ERP - Migration 0039: receipts on expenses, slips on cash transfers.
--
-- An expense (petty-cash voucher) can carry its receipt and a cash transfer its
-- deposit slip: owner types 'expense' and 'cash_transfer' and categories
-- 'receipt' and 'deposit_slip' join the attachment rules. Access follows
-- the record: expenses.view / cash_transfers.view plus access to its branch
-- (uploading also needs documents.upload and the 'attachments' feature).
-- =============================================================================

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'document_attachments_owner_v2') then
    alter table public.document_attachments drop constraint document_attachments_owner_v2;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_attachments_owner_v3') then
    alter table public.document_attachments add constraint document_attachments_owner_v3 check (owner_type in (
      'import_shipment','import_receipt','cost_invoice','purchase','stock_transfer','stock_transfer_receipt','rebag_order',
      'stock_transfer_dispatch','expense','cash_transfer'));
  end if;
  if exists (select 1 from pg_constraint where conname = 'document_attachments_category_v2') then
    alter table public.document_attachments drop constraint document_attachments_category_v2;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'document_attachments_category_v3') then
    alter table public.document_attachments add constraint document_attachments_category_v3 check (category in (
      'bill_of_lading','packing_list','customs_entry','supplier_invoice','cost_invoice','delivery_note','proof_of_delivery','photo','other',
      'driver_licence','cargo_papers','loading_photo','weighbridge_ticket','transport_invoice','signed_delivery_note','offloading_photo',
      'receipt','deposit_slip'));
  end if;
end $$;

create or replace function public._document_owner(p_owner_type text, p_owner_id uuid, out company_id uuid, out branch_ids uuid[], out view_permission text)
returns record language plpgsql stable security definer set search_path = public as $$
begin
  if p_owner_type = 'import_shipment' then
    select s.company_id, array[s.branch_id], 'imports.view' into company_id, branch_ids, view_permission
      from public.import_shipments s where s.id = p_owner_id;
  elsif p_owner_type = 'import_receipt' then
    select r.company_id, array[r.branch_id], 'imports.view' into company_id, branch_ids, view_permission
      from public.import_receipts r where r.id = p_owner_id;
  elsif p_owner_type = 'cost_invoice' then
    select c.company_id, null::uuid[], 'documents.view_financial' into company_id, branch_ids, view_permission
      from public.cost_invoices c where c.id = p_owner_id;
  elsif p_owner_type = 'purchase' then
    select p.company_id, null::uuid[], 'documents.view_financial' into company_id, branch_ids, view_permission
      from public.purchases p where p.id = p_owner_id;
  elsif p_owner_type = 'stock_transfer' then
    select t.company_id, array[t.source_branch_id, t.destination_branch_id], 'inventory.transfer_view'
      into company_id, branch_ids, view_permission
      from public.stock_transfers t where t.id = p_owner_id;
  elsif p_owner_type = 'stock_transfer_receipt' then
    select t.company_id, array[t.source_branch_id, t.destination_branch_id], 'inventory.transfer_view'
      into company_id, branch_ids, view_permission
      from public.stock_transfer_receipts r join public.stock_transfers t on t.id = r.transfer_id where r.id = p_owner_id;
  elsif p_owner_type = 'stock_transfer_dispatch' then
    select t.company_id, array[t.source_branch_id, t.destination_branch_id], 'inventory.transfer_view'
      into company_id, branch_ids, view_permission
      from public.stock_transfer_dispatches d join public.stock_transfers t on t.id = d.transfer_id where d.id = p_owner_id;
  elsif p_owner_type = 'rebag_order' then
    select o.company_id, array[o.branch_id], 'rebagging.view' into company_id, branch_ids, view_permission
      from public.rebag_orders o where o.id = p_owner_id;
  elsif p_owner_type = 'expense' then
    select e.company_id, array[e.branch_id], 'expenses.view' into company_id, branch_ids, view_permission
      from public.expenses e where e.id = p_owner_id;
  elsif p_owner_type = 'cash_transfer' then
    -- Company-wide accounts have no branch; the record then needs no branch access.
    select t.company_id, nullif(array_remove(array[t.source_branch_id, t.destination_branch_id], null), '{}'), 'cash_transfers.view'
      into company_id, branch_ids, view_permission
      from public.cash_transfers t where t.id = p_owner_id;
  end if;
  if company_id is null then
    raise exception 'Document owner not found' using errcode = 'P0001';
  end if;
end; $$;
