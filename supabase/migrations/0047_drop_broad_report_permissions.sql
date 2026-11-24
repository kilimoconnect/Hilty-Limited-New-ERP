-- =============================================================================
-- Hilty ERP - Migration 0047: remove the old broad "reports.*" permissions.
--
-- 0046 gave every report its own permission (report.<slug>) and granted it to
-- every role that held the broad permission that used to open it. The broad
-- ones (reports.view, reports.view_sales, ...) no longer control anything:
-- the last two uses moved to report.profit_and_loss (Dashboard financial
-- panel) and report.purchase_summary (purchases on Item Activity), which the
-- same roles already hold. Removing them leaves one Reports group on the
-- Roles page. Role links are removed with them (on delete cascade).
-- =============================================================================

-- Safety: every role that could open a report through a broad permission
-- already holds that report's own permission (0046). Stop if not.
do $$
declare missing integer;
begin
  select count(*) into missing
    from (values
      ('reports.view_cashup', 'report.cash_up'),
      ('reports.view_sales', 'report.sales_summary'),
      ('reports.view_sales', 'report.item_activity'),
      ('reports.view_sales', 'report.top_items'),
      ('reports.view_purchases', 'report.purchase_summary'),
      ('reports.view_profit_loss', 'report.profit_and_loss'),
      ('reports.view_profit_loss', 'report.profitability'),
      ('reports.view_balance_sheet', 'report.balance_sheet'),
      ('reports.view_cash_flow', 'report.cash_flow'),
      ('reports.view_vat', 'report.vat'),
      ('reports.view_receivables', 'report.receivables_ageing'),
      ('reports.view_receivables', 'report.customer_statements'),
      ('reports.view_payables', 'report.payables_ageing'),
      ('reports.view_payables', 'report.supplier_statements'),
      ('reports.view_inventory_valuation', 'report.inventory_valuation'),
      ('reports.view_inventory_valuation', 'report.late_costs'),
      ('reports.view_inventory_valuation', 'report.cost_reconciliation')
    ) m(old_code, new_code)
    join public.permissions op on op.code = m.old_code
    join public.role_permissions orp on orp.permission_id = op.id
   where not exists (
     select 1 from public.role_permissions nrp
       join public.permissions np on np.id = nrp.permission_id
      where nrp.role_id = orp.role_id and np.code = m.new_code);
  if missing > 0 then
    raise exception 'Migration 0047: % role/report grants are missing; run 0046 first', missing;
  end if;
end $$;

delete from public.permissions where resource = 'reports';
