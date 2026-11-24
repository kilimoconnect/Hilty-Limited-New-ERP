import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/batch";
import { reportBranches, reportPeriod } from "@/lib/reports/scope";
import { str } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PeriodFilter, ParamSelect, PrintButton, ExportCsvButton } from "@/components/reports/report-tools";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";
import { pageBranch } from "@/lib/branch-filter";

export const metadata: Metadata = { title: "Item Activity" };

type SP = Record<string, string | string[] | undefined>;
interface SaleLine { id: string; quantity: number; unit_price: number; line_total: number; net_amount: number; cogs: number;
  sale: { id: string; document_number: string | null; document_date: string; branch: { code: string } | null } }
interface PurLine { id: string; quantity: number; unit_cost: number; gross_amount: number; inventory_value: number;
  purchase: { id: string; document_number: string | null; document_date: string; branch: { code: string } | null; supplier: { name: string } | null } }
const N = (v: unknown) => Number(v ?? 0);

export default async function ItemActivityPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("report.item_activity");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const { start, end } = reportPeriod(sp);
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const productId = str(sp, "product");
  const branches = reportBranches(ctx, branch);
  // Cost of sales and gross profit are for the Owner only.
  const showCost = ctx.user.isOwner;
  const showPurchases = can(ctx.user, "report.purchase_summary");
  const admin = createAdminClient();

  const products = await selectAll<{ id: string; sku: string; name: string }>(() =>
    admin.from("products").select("id, sku, name").eq("company_id", ctx.companyId).order("sku").order("id"));
  const product = products.find((p) => p.id === productId);

  let sales: SaleLine[] = [], purchases: PurLine[] = [], stock: { quantity: number; stock_value: number; branch: { code: string } | null }[] = [];
  if (product && !(branches && branches.length === 0)) {
    [sales, purchases, stock] = await Promise.all([
      selectAll<SaleLine>(() => {
        let q = admin.from("sale_lines")
          .select("id, quantity, unit_price, line_total, net_amount, cogs, sale:sales!inner(id, document_number, document_date, branch_id, company_id, document_status, branch:branches(code))")
          .eq("product_id", product.id).eq("sale.company_id", ctx.companyId).eq("sale.document_status", "posted")
          .gte("sale.document_date", start).lte("sale.document_date", end);
        if (branches) q = q.in("sale.branch_id", branches);
        return q.order("id");
      }),
      showPurchases ? selectAll<PurLine>(() => {
        let q = admin.from("purchase_lines")
          .select("id, quantity, unit_cost, gross_amount, inventory_value, purchase:purchases!inner(id, document_number, document_date, branch_id, company_id, document_status, branch:branches(code), supplier:suppliers(name))")
          .eq("product_id", product.id).eq("purchase.company_id", ctx.companyId).eq("purchase.document_status", "posted")
          .gte("purchase.document_date", start).lte("purchase.document_date", end);
        if (branches) q = q.in("purchase.branch_id", branches);
        return q.order("id");
      }) : Promise.resolve([] as PurLine[]),
      selectAll<{ quantity: number; stock_value: number; branch: { code: string } | null }>(() => {
        let q = admin.from("stock_balances").select("id, quantity, stock_value, branch:branches(code)")
          .eq("company_id", ctx.companyId).eq("product_id", product.id);
        if (branches) q = q.in("branch_id", branches);
        return q.order("id");
      }),
    ]);
    sales.sort((a, b) => b.sale.document_date.localeCompare(a.sale.document_date));
    purchases.sort((a, b) => b.purchase.document_date.localeCompare(a.purchase.document_date));
  }
  const sold = sales.reduce((a, l) => a + N(l.quantity), 0);
  const revenue = sales.reduce((a, l) => a + N(l.net_amount), 0);
  const cogs = sales.reduce((a, l) => a + N(l.cogs), 0);
  const bought = purchases.reduce((a, l) => a + N(l.quantity), 0);
  const boughtValue = purchases.reduce((a, l) => a + N(l.inventory_value), 0);
  const onHand = stock.reduce((a, s) => a + N(s.quantity), 0);
  const csv = [
    ...sales.map((l) => ["Sale", l.sale.document_date, l.sale.document_number ?? "", l.sale.branch?.code ?? "", "", N(l.quantity), N(l.unit_price), N(l.line_total), ...(showCost ? [N(l.cogs)] : [])]),
    ...purchases.map((l) => ["Purchase", l.purchase.document_date, l.purchase.document_number ?? "", l.purchase.branch?.code ?? "", l.purchase.supplier?.name ?? "", N(l.quantity), N(l.unit_cost), N(l.gross_amount), ...(showCost ? [N(l.inventory_value)] : [])]),
  ];

  return (
    <div>
      <PageHeader title="Item Activity" description="Everything one product did in a period: each sale and purchase, and its stock now."
        actions={product && <div className="flex gap-2"><PrintButton /><ExportCsvButton filename={`item-${product.sku}-${start}-to-${end}.csv`}
          header={["Type", "Date", "Document", "Branch", "Supplier", "Qty", "Price / cost", "Total", ...(showCost ? ["Cost value"] : [])]} rows={csv} /></div>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <ParamSelect param="product" value={productId} placeholder="Choose a product..." options={products.map((p) => ({ id: p.id, label: `${p.sku} - ${p.name}` }))} />
        <PeriodFilter start={start} end={end} />
        <ParamSelect param="branch" value={branchParam} placeholder={ctx.user.isOwner ? "All branches" : "All my branches"}
          options={ctx.branches.map((b) => ({ id: b.id, label: `${b.code} - ${b.name}` }))} />
      </div>

      {!product ? <EmptyState title="Choose a product" description="Pick a product above to see its sales, purchases and stock." /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Card className="p-4"><p className="text-xs text-muted-foreground">Sold</p><p className="text-lg font-semibold tabular-nums">{formatQuantity(sold)} <span className="text-sm font-normal text-muted-foreground">in {new Set(sales.map((l) => l.sale.id)).size} invoices</span></p></Card>
            <Card className="p-4"><p className="text-xs text-muted-foreground">Sales (net of VAT)</p><p className="text-lg font-semibold tabular-nums">{formatMoney(revenue)}</p>
              {showCost && <p className="text-xs text-muted-foreground">profit {formatMoney(revenue - cogs)}</p>}</Card>
            {showPurchases && <Card className="p-4"><p className="text-xs text-muted-foreground">Bought</p><p className="text-lg font-semibold tabular-nums">{formatQuantity(bought)}</p>
              {showCost && <p className="text-xs text-muted-foreground">cost {formatMoney(boughtValue)}</p>}</Card>}
            <Card className="p-4"><p className="text-xs text-muted-foreground">On hand now</p><p className="text-lg font-semibold tabular-nums">{formatQuantity(onHand)}</p>
              <p className="text-xs text-muted-foreground">{stock.filter((s) => N(s.quantity) !== 0).map((s) => `${s.branch?.code} ${formatQuantity(s.quantity)}`).join(" · ") || "no stock"}</p></Card>
          </div>

          <h2 className="mb-2 text-sm font-semibold">Sales ({sales.length})</h2>
          {sales.length === 0 ? <p className="mb-6 text-sm text-muted-foreground">No sales of this product in the period.</p> : (
            <Card className="mb-6 overflow-x-auto"><Table>
              <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Invoice</TableHead><TableHead>Branch</TableHead>
                <TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Price</TableHead><TableHead className="text-right">Total</TableHead>
                {showCost && <TableHead className="text-right">Cost</TableHead>}</TableRow></TableHeader>
              <TableBody>{sales.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-sm">{formatDate(l.sale.document_date)}</TableCell>
                  <TableCell className="font-mono text-xs"><Link className="text-primary hover:underline" href={`/sales/${l.sale.id}`}>{l.sale.document_number}</Link></TableCell>
                  <TableCell className="text-sm">{l.sale.branch?.code}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(l.quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(N(l.unit_price))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(N(l.line_total))}</TableCell>
                  {showCost && <TableCell className="text-right tabular-nums text-muted-foreground">{formatMoney(N(l.cogs))}</TableCell>}
                </TableRow>))}</TableBody>
            </Table></Card>
          )}

          {showPurchases && <>
            <h2 className="mb-2 text-sm font-semibold">Purchases ({purchases.length})</h2>
            {purchases.length === 0 ? <p className="text-sm text-muted-foreground">No purchases of this product in the period.</p> : (
              <Card className="overflow-x-auto"><Table>
                <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Purchase</TableHead><TableHead>Branch</TableHead><TableHead>Supplier</TableHead>
                  <TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Unit cost</TableHead><TableHead className="text-right">Total</TableHead></TableRow></TableHeader>
                <TableBody>{purchases.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell className="text-sm">{formatDate(l.purchase.document_date)}</TableCell>
                    <TableCell className="font-mono text-xs"><Link className="text-primary hover:underline" href={`/purchases/${l.purchase.id}`}>{l.purchase.document_number}</Link></TableCell>
                    <TableCell className="text-sm">{l.purchase.branch?.code}</TableCell>
                    <TableCell className="text-sm">{l.purchase.supplier?.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(l.quantity)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(N(l.unit_cost))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(N(l.gross_amount))}</TableCell>
                  </TableRow>))}</TableBody>
              </Table></Card>
            )}
          </>}
        </>
      )}
    </div>
  );
}
