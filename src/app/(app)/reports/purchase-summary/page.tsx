import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
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
import { pageBranch } from "@/lib/branch-filter";

export const metadata: Metadata = { title: "Purchase Summary" };

type SP = Record<string, string | string[] | undefined>;
interface Row { key: string; label: string; docs: number; net: number | null; tax: number | null; gross: number | null; paid: number | null; outstanding: number | null }

const GROUPS = [
  { id: "day", label: "By day" }, { id: "branch", label: "By branch" }, { id: "supplier", label: "By supplier" },
  { id: "category", label: "By category" }, { id: "method", label: "Payments by account" },
];
const N = (v: unknown) => Number(v ?? 0);

export default async function PurchaseSummaryPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("reports.view_purchases");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const { start, end } = reportPeriod(sp);
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const by = GROUPS.some((g) => g.id === str(sp, "by")) ? str(sp, "by") : "day";
  const branches = reportBranches(ctx, branch);

  const rows = branches && branches.length === 0 ? [] : await selectAll<Row>(() => createAdminClient().rpc("report_purchase_summary", {
    p_company: ctx.companyId, p_branches: branches, p_start: start, p_end: end, p_group: by,
  }));
  const method = by === "method";
  const lineLevel = by === "category";
  const t = { docs: 0, net: 0, tax: 0, gross: 0, paid: 0, outstanding: 0 };
  for (const r of rows) { t.docs += N(r.docs); t.net += N(r.net); t.tax += N(r.tax); t.gross += N(r.gross); t.paid += N(r.paid); t.outstanding += N(r.outstanding); }
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  const groupLabel = GROUPS.find((g) => g.id === by)!.label.replace(/^By /, "");

  const header = method ? ["Payment account", "Documents", "Paid", "Share"]
    : ["Group", "Purchases", "Net", "VAT", "Total", ...(lineLevel ? [] : ["Paid", "Outstanding"])];
  const csv = rows.map((r) => method ? [r.label, N(r.docs), N(r.paid), pct(N(r.paid), t.paid)]
    : [r.label, N(r.docs), N(r.net), N(r.tax), N(r.gross), ...(lineLevel ? [] : [N(r.paid), N(r.outstanding)])]);

  return (
    <div>
      <PageHeader title="Purchase Summary" description="Posted purchases for the period, grouped as you choose. Payments by account lists money paid at purchase and through supplier payments."
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename={`purchase-summary-${by}-${start}-to-${end}.csv`} header={header} rows={csv} /></div>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <PeriodFilter start={start} end={end} />
        <ParamSelect param="by" value={by === "day" ? "" : by} placeholder="By day" options={GROUPS.filter((g) => g.id !== "day").map((g) => ({ id: g.id, label: g.label }))} />
        <ParamSelect param="branch" value={branchParam} placeholder={ctx.user.isOwner ? "All branches" : "All my branches"}
          options={ctx.branches.map((b) => ({ id: b.id, label: `${b.code} - ${b.name}` }))} />
      </div>

      {!method && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card className="p-4"><p className="text-xs text-muted-foreground">Purchases (incl. VAT)</p><p className="text-lg font-semibold tabular-nums">{formatMoney(t.gross)}</p></Card>
          <Card className="p-4"><p className="text-xs text-muted-foreground">Input VAT</p><p className="text-lg font-semibold tabular-nums">{formatMoney(t.tax)}</p></Card>
          {!lineLevel && <Card className="p-4"><p className="text-xs text-muted-foreground">Paid</p><p className="text-lg font-semibold tabular-nums">{formatMoney(t.paid)}</p></Card>}
          {!lineLevel && <Card className="p-4"><p className="text-xs text-muted-foreground">Still owed</p><p className="text-lg font-semibold tabular-nums">{formatMoney(t.outstanding)}</p></Card>}
        </div>
      )}

      {rows.length === 0 ? <EmptyState title="No posted purchases in this period" /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead className="capitalize">{method ? "Payment account" : groupLabel}</TableHead>
              <TableHead className="text-right">{method ? "Documents" : "Purchases"}</TableHead>
              {method ? <><TableHead className="text-right">Paid</TableHead><TableHead className="text-right">Share</TableHead></> : <>
                <TableHead className="text-right">Net</TableHead><TableHead className="text-right">VAT</TableHead><TableHead className="text-right">Total</TableHead>
                {!lineLevel && <><TableHead className="text-right">Paid</TableHead><TableHead className="text-right">Outstanding</TableHead></>}
              </>}
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell className="text-sm">{r.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{N(r.docs)}</TableCell>
                  {method ? <>
                    <TableCell className="text-right tabular-nums">{formatMoney(N(r.paid))}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{pct(N(r.paid), t.paid)}</TableCell>
                  </> : <>
                    <TableCell className="text-right tabular-nums">{formatMoney(N(r.net))}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{formatMoney(N(r.tax))}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMoney(N(r.gross))}</TableCell>
                    {!lineLevel && <>
                      <TableCell className="text-right tabular-nums">{formatMoney(N(r.paid))}</TableCell>
                      <TableCell className={`text-right tabular-nums ${N(r.outstanding) > 0 ? "text-destructive" : "text-muted-foreground"}`}>{formatMoney(N(r.outstanding))}</TableCell>
                    </>}
                  </>}
                </TableRow>
              ))}
              <TableRow className="border-t-2 font-semibold">
                <TableCell>Total</TableCell>
                <TableCell className="text-right tabular-nums">{lineLevel ? "" : t.docs}</TableCell>
                {method ? <><TableCell className="text-right tabular-nums">{formatMoney(t.paid)}</TableCell><TableCell /></> : <>
                  <TableCell className="text-right tabular-nums">{formatMoney(t.net)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(t.tax)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(t.gross)}</TableCell>
                  {!lineLevel && <><TableCell className="text-right tabular-nums">{formatMoney(t.paid)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(t.outstanding)}</TableCell></>}
                </>}
              </TableRow>
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
