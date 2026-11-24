/**
 * Every report, with its own permission ("report.<slug>") so a role can be
 * given exactly the reports it needs. Used by the menu, the Reports page and
 * each report's page guard. `legacy` is the broad permission that opened the
 * report before 0046; the migration grants the new permission to every role
 * that had it, so nobody lost access.
 */
export interface ReportDef {
  slug: string;
  href: string;
  title: string;
  desc: string;
  legacy: string;
  feature?: string;
}

export const REPORTS: ReportDef[] = [
  { slug: "cash_up", href: "/reports/cash-up", title: "Daily Cash-up", desc: "Each branch till by day: in, out, banked, expected and counted", legacy: "reports.view_cashup" },
  { slug: "sales_summary", href: "/reports/sales-summary", title: "Sales Summary", desc: "Sales by day, branch, salesperson, category or payment method", legacy: "reports.view_sales" },
  { slug: "purchase_summary", href: "/reports/purchase-summary", title: "Purchase Summary", desc: "Purchases by day, branch, supplier, category or payment account", legacy: "reports.view_purchases" },
  { slug: "item_activity", href: "/reports/item-activity", title: "Item Activity", desc: "One product: every sale and purchase, and its stock", legacy: "reports.view_sales" },
  { slug: "stock_movements", href: "/reports/stock-movements", title: "Stock Movements", desc: "Transfers between branches and stock adjustments", legacy: "inventory.view" },
  { slug: "top_items", href: "/reports/top-items", title: "Top Items & Slow Movers", desc: "Best sellers, and stock that is not selling", legacy: "reports.view_sales" },
  { slug: "profit_and_loss", href: "/reports/profit-and-loss", title: "Profit & Loss", desc: "Revenue, cost of sales and expenses", legacy: "reports.view_profit_loss" },
  { slug: "balance_sheet", href: "/reports/balance-sheet", title: "Balance Sheet", desc: "Assets, liabilities and equity as of a date", legacy: "reports.view_balance_sheet" },
  { slug: "cash_flow", href: "/reports/cash-flow", title: "Cash Flow", desc: "Cash movements by activity", legacy: "reports.view_cash_flow" },
  { slug: "vat", href: "/reports/vat", title: "VAT Report", desc: "Output and input VAT with reconciliation", legacy: "reports.view_vat" },
  { slug: "receivables_ageing", href: "/reports/receivables-ageing", title: "Receivables Ageing", desc: "Customer balances by age bucket", legacy: "reports.view_receivables" },
  { slug: "payables_ageing", href: "/reports/payables-ageing", title: "Payables Ageing", desc: "Supplier balances by age bucket", legacy: "reports.view_payables" },
  { slug: "customer_statements", href: "/reports/customer-statements", title: "Customer Statements", desc: "Statement of account for a customer", legacy: "reports.view_receivables" },
  { slug: "supplier_statements", href: "/reports/supplier-statements", title: "Supplier Statements", desc: "Statement of account for a supplier", legacy: "reports.view_payables" },
  { slug: "inventory_valuation", href: "/reports/inventory-valuation", title: "Inventory Valuation", desc: "Stock value by product & branch", legacy: "reports.view_inventory_valuation" },
  { slug: "late_costs", href: "/reports/late-costs", title: "Late Cost Adjustments", desc: "Costs added after goods were received or sold", legacy: "reports.view_inventory_valuation" },
  { slug: "cost_reconciliation", href: "/reports/cost-reconciliation", title: "Cost Reconciliation", desc: "Stock value in the books against the stock ledger", legacy: "reports.view_inventory_valuation" },
  { slug: "shipment_costing", href: "/reports/shipment-costing", title: "Shipment Costing", desc: "Landed cost of each import shipment", legacy: "imports.view_cost", feature: "imports" },
  { slug: "rebagging_costing", href: "/reports/rebagging-costing", title: "Rebagging Costing", desc: "Cost of bags produced from bulk", legacy: "inventory.view_cost", feature: "rebagging" },
  { slug: "transfer_costing", href: "/reports/transfer-costing", title: "Transfer Costing", desc: "Cost of moving stock between branches", legacy: "inventory.view_cost" },
  { slug: "branch_landed_cost", href: "/reports/branch-landed-cost", title: "Branch Landed Cost", desc: "What each product costs at each branch", legacy: "inventory.view_cost" },
  { slug: "profitability", href: "/reports/profitability", title: "Profitability", desc: "Margin by branch and product", legacy: "reports.view_profit_loss" },
  { slug: "exceptions", href: "/reports/exceptions", title: "Costing Exceptions", desc: "Stock and cost problems to look at", legacy: "inventory.view_cost" },
];

export const reportPermission = (slug: string) => `report.${slug}`;

export function reportBySlug(slug: string): ReportDef {
  const r = REPORTS.find((x) => x.slug === slug);
  if (!r) throw new Error(`Unknown report ${slug}`);
  return r;
}
