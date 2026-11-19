import type { Metadata } from "next";
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
import { formatMoney } from "@/lib/format";

export const metadata: Metadata = { title: "Sales Summary" };

type SP = Record<string, string | string[] | undefined>;
interface Row { key: string; label: string; docs: number; net: number | null; tax: number | null; gross: number | null; cogs: number | null; collected: number | null }

const GROUPS = [
  { id: "day", label: "By day" }, { id: "branch", label: "By branch" }, { id: "user", label: "By salesperson" },
  { id: "category", label: "By category" }, { id: "method", label: "Collections by payment method" },
];
const N = (v: unknown) => Number(v ?? 0);

export default async function SalesSummaryPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("reports.view_sales");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const { start, end } = reportPeriod(sp);
  const branch = str(sp, "branch");
  const by = GROUPS.some((g) => g.id === str(sp, "by")) ? str(sp, "by") : "day";
  const showCost = can(ctx.user, "sales.view_cost") || can(ctx.user, "inventory.view_cost");
  const branches = reportBranches(ctx, branch);

  const rows = branches && branches.length === 0 ? [] : await selectAll<Row>(() => createAdminClient().rpc("report_sales_summary", {
    p_company: ctx.companyId, p_branches: branches, p_start: start, p_end: end, p_group: by,
  }));
  const method = by === "method";
  const t = { docs: 0, net: 0, tax: 0, gross: 0, cogs: 0, collected: 0 };
  for (const r of rows) { t.docs += N(r.docs); t.net += N(r.net); t.tax += N(r.tax); t.gross += N(r.gross); t.cogs += N(r.cogs); t.collected += N(r.collected); }
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  const groupLabel = GROUPS.find((g) => g.id === by)!.label.replace(/^By /, "").replace(/^Collections by /, "");

  const header = method ? ["Payment account", "Documents", "Collected", "Share"]
    : ["Group", "Invoices", "Net", "VAT", "Total", ...(showCost ? ["Cost of sales", "Gross profit", "Margin"] : []), ...(by !== "category" ? ["Paid"] : [])];
  const csv = rows.map((r) => method ? [r.label, N(r.docs), N(r.collected), pct(N(r.collected), t.collected)]
    : [r.label, N(r.docs), N(r.net), N(r.tax), N(r.gross), ...(showCost ? [N(r.cogs), N(r.net) - N(r.cogs), pct(N(r.net) - N(r.cogs), N(r.net))] : []), ...(by !== "category" ? [N(r.collected)] : [])]);

  return (
    <div>
      <PageHeader title="Sales Summary" description="Posted sales for the period, grouped as you choose. Collections lists money received by payment account (sale payments and customer receipts)."
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename={`sales-summary-${by}-${start}-to-${end}.csv`} header={header} rows={csv} /></div>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <PeriodFilter start={start} end={end} />
        <ParamSelect param="by" value={by === "day" ? "" : by} placeholder="By day" options={GROUPS.filter((g) => g.id !== "day").map((g) => ({ id: g.id, label: g.label }))} />
        <ParamSelect param="branch" value={branch} placeholder={ctx.user.isOwner ? "All branches" : "All my branches"}
          options={ctx.branches.map((b) => ({ id: b.id, label: `${b.code} - ${b.name}` }))} />
      </div>

      {!method && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card className="p-4"><p className="text-xs text-muted-foreground">Sales (incl. VAT)</p><p className="text-lg font-semibold tabular-nums">{formatMoney(t.gross)}</p></Card>
          <Card className="p-4"><p className="text-xs text-muted-foreground">Net of VAT</p><p className="text-lg font-semibold tabular-nums">{formatMoney(t.net)}</p></Card>
          {showCost && <Card className="p-4"><p className="text-xs text-muted-foreground">Gross profit</p><p className="text-lg font-semibold tabular-nums">{formatMoney(t.net - t.cogs)} <span className="text-sm font-normal text-muted-foreground">({pct(t.net - t.cogs, t.net)})</span></p></Card>}
          <Card className="p-4"><p className="text-xs text-muted-foreground">Invoices</p><p className="text-lg font-semibold tabular-nums">{by === "category" ? "—" : t.docs}</p></Card>
        </div>
      )}

      {rows.length === 0 ? <EmptyState title="No posted sales in this period" /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="capitalize">{method ? "Payment account" : groupLabel}</TableHead>
              <TableHead className="text-right">{method ? "Documents" : "Invoices"}</TableHead>
              {method ? <><TableHead className="text-right">Collected</TableHead><TableHead className="text-right">Share</TableHead></> : <>
                <TableHead className="text-right">Net</TableHead><TableHead className="text-right">VAT</TableHead><TableHead className="text-right">Total</TableHead>
                {showCost && <><TableHead className="text-right">Cost of sales</TableHead><TableHead className="text-right">Gross profit</TableHead><TableHead className="text-right">Margin</TableHead></>}
                {by !== "category" && <TableHead className="text-right">Paid</TableHead>}
              </>}
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="text-sm">{r.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{N(r.docs)}</TableCell>
                  {method ? <>
                    <TableCell className="text-right tabular-nums">{formatMoney(N(r.collected))}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{pct(N(r.collected), t.collected)}</TableCell>
                  </> : <>
                    <TableCell className="text-right tabular-nums">{formatMoney(N(r.net))}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{formatMoney(N(r.tax))}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMoney(N(r.gross))}</TableCell>
                    {showCost && <>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{formatMoney(N(r.cogs))}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(N(r.net) - N(r.cogs))}</TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">{pct(N(r.net) - N(r.cogs), N(r.net))}</TableCell>
                    </>}
                    {by !== "category" && <TableCell className="text-right tabular-nums">{formatMoney(N(r.collected))}</TableCell>}
                  </>}
                </TableRow>
              ))}
              <TableRow className="border-t-2 font-semibold">
                <TableCell>Total</TableCell>
                <TableCell className="text-right tabular-nums">{by === "category" ? "" : t.docs}</TableCell>
                {method ? <><TableCell className="text-right tabular-nums">{formatMoney(t.collected)}</TableCell><TableCell /></> : <>
                  <TableCell className="text-right tabular-nums">{formatMoney(t.net)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(t.tax)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(t.gross)}</TableCell>
                  {showCost && <><TableCell className="text-right tabular-nums">{formatMoney(t.cogs)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(t.net - t.cogs)}</TableCell>
                    <TableCell className="text-right tabular-nums">{pct(t.net - t.cogs, t.net)}</TableCell></>}
                  {by !== "category" && <TableCell className="text-right tabular-nums">{formatMoney(t.collected)}</TableCell>}
                </>}
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
