import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/batch";
import { reportBranches, reportPeriod, addDays } from "@/lib/reports/scope";
import { Pager, pageOf, pageSizeOf, str } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PeriodFilter, ParamSelect, PrintButton, ExportCsvButton } from "@/components/reports/report-tools";
import { formatDate, formatMoney, formatQuantity, todayISO } from "@/lib/format";
import { pageBranch } from "@/lib/branch-filter";

export const metadata: Metadata = { title: "Top Items & Slow Movers" };

type SP = Record<string, string | string[] | undefined>;
interface Row { product_id: string; sku: string; name: string; category: string | null; qty_sold: number; revenue: number; cogs: number;
  profit: number; invoices: number; stock_qty: number; stock_value: number; last_sale: string | null }
const N = (v: unknown) => Number(v ?? 0);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

export default async function TopItemsPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("report.top_items");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const { start, end } = reportPeriod(sp, addDays(todayISO(), -29));
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const view = str(sp, "view") === "slow" ? "slow" : "top";
  // Gross profit is for the Owner only; stock value follows the inventory-cost permission.
  const showProfit = ctx.user.isOwner;
  const showStockValue = can(ctx.user, "inventory.view_cost");
  const sorts = showProfit ? ["revenue", "qty", "profit"] : ["revenue", "qty"];
  const sort = sorts.includes(str(sp, "sort")) ? str(sp, "sort") : "revenue";
  const page = pageOf(sp), size = pageSizeOf(sp);
  const branches = reportBranches(ctx, branch);

  const all = branches && branches.length === 0 ? [] : await selectAll<Row>(() => createAdminClient().rpc("report_item_ranking", {
    p_company: ctx.companyId, p_branches: branches, p_start: start, p_end: end,
  }));
  const key = (r: Row) => (sort === "qty" ? N(r.qty_sold) : sort === "profit" ? N(r.profit) : N(r.revenue));
  const list = view === "top"
    ? all.filter((r) => N(r.qty_sold) > 0).sort((a, b) => key(b) - key(a))
    // Slow movers: stock on hand, least sold first, then the most money tied up.
    : all.filter((r) => N(r.stock_qty) > 0).sort((a, b) => N(a.qty_sold) - N(b.qty_sold) || N(b.stock_value) - N(a.stock_value));
  const rows = list.slice((page - 1) * size, page * size);
  const totalRevenue = all.reduce((a, r) => a + N(r.revenue), 0);
  const unsold = all.filter((r) => N(r.stock_qty) > 0 && N(r.qty_sold) === 0);

  const csv = list.map((r, i) => [i + 1, r.sku, r.name, r.category ?? "", N(r.qty_sold), N(r.revenue), ...(showProfit ? [N(r.profit)] : []),
    N(r.stock_qty), ...(showStockValue ? [N(r.stock_value)] : []), r.last_sale ?? "", r.last_sale ? daysBetween(r.last_sale, end) : ""]);

  return (
    <div>
      <PageHeader title="Top Items & Slow Movers" description="Which products sell best in the period, and which sit in stock without selling."
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename={`${view === "top" ? "top-items" : "slow-movers"}-${start}-to-${end}.csv`}
          header={["Rank", "SKU", "Product", "Category", "Qty sold", "Sales (net)", ...(showProfit ? ["Gross profit"] : []), "On hand", ...(showStockValue ? ["Stock value"] : []), "Last sale", "Days since sale"]} rows={csv} /></div>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <PeriodFilter start={start} end={end} />
        <ParamSelect param="view" value={view === "slow" ? "slow" : ""} placeholder="Top items" options={[{ id: "slow", label: "Slow movers" }]} />
        {view === "top" && <ParamSelect param="sort" value={sort === "revenue" ? "" : sort} placeholder="Rank by sales value"
          options={[{ id: "qty", label: "Rank by quantity" }, ...(showProfit ? [{ id: "profit", label: "Rank by profit" }] : [])]} />}
        <ParamSelect param="branch" value={branchParam} placeholder={ctx.user.isOwner ? "All branches" : "All my branches"}
          options={ctx.branches.map((b) => ({ id: b.id, label: `${b.code} - ${b.name}` }))} />
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="p-4"><p className="text-xs text-muted-foreground">Products sold</p><p className="text-lg font-semibold tabular-nums">{all.filter((r) => N(r.qty_sold) > 0).length}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Sales (net of VAT)</p><p className="text-lg font-semibold tabular-nums">{formatMoney(totalRevenue)}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">In stock, not sold in period</p><p className="text-lg font-semibold tabular-nums">{unsold.length}</p></Card>
        {showStockValue && <Card className="p-4"><p className="text-xs text-muted-foreground">Value of that stock</p><p className="text-lg font-semibold tabular-nums">{formatMoney(unsold.reduce((a, r) => a + N(r.stock_value), 0))}</p></Card>}
      </div>

      {rows.length === 0 ? <EmptyState title={view === "top" ? "No sales in this period" : "No stock on hand"} /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="w-12 text-right">#</TableHead><TableHead>Product</TableHead>
              <TableHead className="text-right">Qty sold</TableHead><TableHead className="text-right">Sales (net)</TableHead>
              {view === "top" && <TableHead className="text-right">Share</TableHead>}
              {showProfit && <TableHead className="text-right">Gross profit</TableHead>}
              <TableHead className="text-right">On hand</TableHead>{showStockValue && <TableHead className="text-right">Stock value</TableHead>}
              <TableHead>Last sale</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r, i) => {
                const idle = r.last_sale ? daysBetween(r.last_sale, end) : null;
                return (
                  <TableRow key={r.product_id}>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{(page - 1) * size + i + 1}</TableCell>
                    <TableCell>
                      <Link className="font-medium text-primary hover:underline" href={`/reports/item-activity?product=${r.product_id}&start=${start}&end=${end}${branch ? `&branch=${branch}` : ""}`}>{r.name}</Link>
                      <div className="text-xs text-muted-foreground"><span className="font-mono">{r.sku}</span>{r.category ? ` · ${r.category}` : ""}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{N(r.qty_sold) ? formatQuantity(r.qty_sold) : <span className="text-muted-foreground">0</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(N(r.revenue))}</TableCell>
                    {view === "top" && <TableCell className="text-right tabular-nums text-muted-foreground">{totalRevenue ? `${((N(r.revenue) / totalRevenue) * 100).toFixed(1)}%` : "—"}</TableCell>}
                    {showProfit && <TableCell className="text-right tabular-nums">{formatMoney(N(r.profit))}</TableCell>}
                    <TableCell className="text-right tabular-nums">{formatQuantity(r.stock_qty)}</TableCell>
                    {showStockValue && <TableCell className="text-right tabular-nums">{formatMoney(N(r.stock_value))}</TableCell>}
                    <TableCell className="whitespace-nowrap text-sm">{r.last_sale ? <>{formatDate(r.last_sale)} <span className="text-xs text-muted-foreground">({idle} d)</span></> : <span className="text-muted-foreground">never</span>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
      <Pager basePath="/reports/top-items" params={{ start, end, branch: branchParam, view: view === "slow" ? "slow" : "", sort: sort === "revenue" ? "" : sort }} page={page} pageSize={size} total={list.length} />
    </div>
  );
}
