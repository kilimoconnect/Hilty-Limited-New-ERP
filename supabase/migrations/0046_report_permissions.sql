-- =============================================================================
-- Hilty ERP - Migration 0046: one permission per report, and Sales from Photos.
--
-- Reports used to share broad permissions (e.g. reports.view_sales opened
-- Sales Summary, Item Activity and Top Items together). Each report now has
-- its own permission, report.<slug>, so a role can be given exactly the
-- reports it needs. So that nobody loses access, every role that holds a
-- report's old permission is given the new one. The broad permissions stay:
-- other screens (dashboard figures, costs) still use them.
--
-- sales.from_photos: Sales from Photos, given to roles that may create sales.
-- Generated from src/lib/reports/catalog.ts.
-- =============================================================================

create temporary table _report_perms(resource text, action text, code text, description text, legacy text);
insert into _report_perms values
  ('report', 'cash_up', 'report.cash_up', 'Open the Daily Cash-up report', 'reports.view_cashup'),
  ('report', 'sales_summary', 'report.sales_summary', 'Open the Sales Summary report', 'reports.view_sales'),
  ('report', 'purchase_summary', 'report.purchase_summary', 'Open the Purchase Summary report', 'reports.view_purchases'),
  ('report', 'item_activity', 'report.item_activity', 'Open the Item Activity report', 'reports.view_sales'),
  ('report', 'stock_movements', 'report.stock_movements', 'Open the Stock Movements report', 'inventory.view'),
  ('report', 'top_items', 'report.top_items', 'Open the Top Items & Slow Movers report', 'reports.view_sales'),
  ('report', 'profit_and_loss', 'report.profit_and_loss', 'Open the Profit & Loss report', 'reports.view_profit_loss'),
  ('report', 'balance_sheet', 'report.balance_sheet', 'Open the Balance Sheet report', 'reports.view_balance_sheet'),
  ('report', 'cash_flow', 'report.cash_flow', 'Open the Cash Flow report', 'reports.view_cash_flow'),
  ('report', 'vat', 'report.vat', 'Open the VAT report', 'reports.view_vat'),
  ('report', 'receivables_ageing', 'report.receivables_ageing', 'Open the Receivables Ageing report', 'reports.view_receivables'),
  ('report', 'payables_ageing', 'report.payables_ageing', 'Open the Payables Ageing report', 'reports.view_payables'),
  ('report', 'customer_statements', 'report.customer_statements', 'Open the Customer Statements report', 'reports.view_receivables'),
  ('report', 'supplier_statements', 'report.supplier_statements', 'Open the Supplier Statements report', 'reports.view_payables'),
  ('report', 'inventory_valuation', 'report.inventory_valuation', 'Open the Inventory Valuation report', 'reports.view_inventory_valuation'),
  ('report', 'late_costs', 'report.late_costs', 'Open the Late Cost Adjustments report', 'reports.view_inventory_valuation'),
  ('report', 'cost_reconciliation', 'report.cost_reconciliation', 'Open the Cost Reconciliation report', 'reports.view_inventory_valuation'),
  ('report', 'shipment_costing', 'report.shipment_costing', 'Open the Shipment Costing report', 'imports.view_cost'),
  ('report', 'rebagging_costing', 'report.rebagging_costing', 'Open the Rebagging Costing report', 'inventory.view_cost'),
  ('report', 'transfer_costing', 'report.transfer_costing', 'Open the Transfer Costing report', 'inventory.view_cost'),
  ('report', 'branch_landed_cost', 'report.branch_landed_cost', 'Open the Branch Landed Cost report', 'inventory.view_cost'),
  ('report', 'profitability', 'report.profitability', 'Open the Profitability report', 'reports.view_profit_loss'),
  ('report', 'exceptions', 'report.exceptions', 'Open the Costing Exceptions report', 'inventory.view_cost');

insert into public.permissions (resource, action, code, description)
select resource, action, code, description from _report_perms
on conflict (code) do update set description = excluded.description;

-- Roles that could open a report keep it (custom roles included).
insert into public.role_permissions (role_id, permission_id)
select distinct rp.role_id, np.id
  from _report_perms r
  join public.permissions lp on lp.code = r.legacy
  join public.role_permissions rp on rp.permission_id = lp.id
  join public.permissions np on np.code = r.code
on conflict do nothing;

insert into public.permissions (resource, action, code, description)
values ('sales', 'from_photos', 'sales.from_photos', 'from photos sales')
on conflict (code) do nothing;

insert into public.role_permissions (role_id, permission_id)
select distinct rp.role_id, np.id
  from public.permissions lp
  join public.role_permissions rp on rp.permission_id = lp.id
  join public.permissions np on np.code = 'sales.from_photos'
 where lp.code = 'sales.create'
on conflict do nothing;

-- The Owner role holds every permission.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
 where r.code = 'OWNER'
on conflict do nothing;

drop table if exists _report_perms;
