import type { Metadata } from "next";
import { Fragment } from "react";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/batch";
import { str } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PeriodFilter, ParamSelect, PrintButton, ExportCsvButton } from "@/components/reports/report-tools";
import { formatDate, formatMoney, todayISO } from "@/lib/format";
import { CountCell } from "./count-cell";
import { pageBranch } from "@/lib/branch-filter";

export const metadata: Metadata = { title: "Daily Cash-up" };

type SP = Record<string, string | string[] | undefined>;
interface Row {
  day: string; branch_id: string; branch_code: string; account_id: string; account_code: string; account_name: string; account_type: string;
  opening: number; sales: number; receipts: number; other_in: number; transfers_in: number;
  expenses: number; purchases: number; transfers_out: number; other_out: number;
  closing: number; counted: number | null; difference: number | null; count_notes: string | null;
}

const MAX_DAYS = 92;
const N = (v: unknown) => Number(v ?? 0);
function addDays(iso: string, d: number) { const x = new Date(`${iso}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); }
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

export default async function CashUpPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("report.cash_up");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const today = todayISO();
  let end = isDate(str(sp, "end")) ? str(sp, "end") : today;
  if (end > today) end = today;
  let start = isDate(str(sp, "start")) ? str(sp, "start") : addDays(end, -6);
  if (start > end) start = end;
  const clamped = start < addDays(end, -(MAX_DAYS - 1));
  if (clamped) start = addDays(end, -(MAX_DAYS - 1));
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const kind = str(sp, "kind");

  const myBranches = ctx.user.isOwner ? null : ctx.user.branchIds;
  const branches = branch ? (myBranches && !myBranches.includes(branch) ? [] : [branch]) : myBranches;
  const admin = createAdminClient();
  const all = branches && branches.length === 0 ? [] : await selectAll<Row>(() => admin.rpc("report_daily_cashup", {
    p_company: ctx.companyId, p_branches: branches, p_start: start, p_end: end,
  }));
  const rows = all.filter((r) => !kind || (kind === "cash" ? r.account_type === "cash" : r.account_type !== "cash"));
  const canCount = can(ctx.user, "cash_accounts.count_cash");

  // Period totals; the balance is each till's closing on the last day shown.
  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  const lastDay = rows.reduce((m, r) => (r.day > m ? r.day : m), "");
  const balance = rows.filter((r) => r.day === lastDay).reduce((a, r) => a + N(r.closing), 0);
  const counted = rows.filter((r) => r.counted !== null);
  const shortOver = counted.reduce((a, r) => a + N(r.difference), 0);

  const days = Array.from(new Set(rows.map((r) => r.day)));
  const csv = rows.map((r) => [r.day, r.branch_code, r.account_name, N(r.opening), N(r.sales), N(r.receipts) + N(r.other_in), N(r.transfers_in),
    N(r.expenses), N(r.purchases), N(r.transfers_out), N(r.other_out), N(r.closing), r.counted ?? "", r.difference ?? "", r.count_notes ?? ""]);

  return (
    <div>
      <PageHeader title="Daily Cash-up"
        description="Each branch till day by day: what came in, what was paid and moved to the bank, the balance it should hold, and the count against it."
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename={`cash-up-${start}-to-${end}.csv`}
          header={["Date", "Branch", "Till", "Opening", "Sales", "Other in", "Moved in", "Expenses", "Purchases", "Moved out", "Other out", "Expected", "Counted", "Over/short", "Count note"]} rows={csv} /></div>} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <PeriodFilter start={start} end={end} />
        <ParamSelect param="branch" value={branchParam} placeholder={ctx.user.isOwner ? "All branches" : "All my branches"}
          options={ctx.branches.filter((b) => b.code !== "HQ").map((b) => ({ id: b.id, label: `${b.code} - ${b.name}` }))} />
        <ParamSelect param="kind" value={kind} placeholder="All tills"
          options={[{ id: "cash", label: "Cash tills" }, { id: "mobile", label: "Mobile money tills" }]} />
      </div>
      {clamped && <p className="mb-3 text-xs text-muted-foreground">Showing the last {MAX_DAYS} days of the range; narrow the dates to see earlier days.</p>}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Card className="p-4"><p className="text-xs text-muted-foreground">Sales into tills</p><p className="text-lg font-semibold tabular-nums">{formatMoney(sum((r) => N(r.sales)))}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Paid out (expenses, purchases)</p><p className="text-lg font-semibold tabular-nums">{formatMoney(sum((r) => N(r.expenses) + N(r.purchases)))}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Moved out (banked)</p><p className="text-lg font-semibold tabular-nums">{formatMoney(sum((r) => N(r.transfers_out)))}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Held in tills{lastDay ? ` (${formatDate(lastDay)})` : ""}</p><p className="text-lg font-semibold tabular-nums">{formatMoney(balance)}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Counts: over / short ({counted.length})</p>
          <p className={`text-lg font-semibold tabular-nums ${shortOver < 0 ? "text-destructive" : shortOver > 0 ? "text-warning" : ""}`}>{counted.length ? formatMoney(shortOver) : "—"}</p></Card>
      </div>

      {rows.length === 0 ? <EmptyState title="No till activity in this period" /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Till</TableHead>
              <TableHead className="text-right">Opening</TableHead><TableHead className="text-right">Sales</TableHead>
              <TableHead className="text-right">Other in</TableHead><TableHead className="text-right">Moved in</TableHead>
              <TableHead className="text-right">Expenses</TableHead><TableHead className="text-right">Purchases</TableHead>
              <TableHead className="text-right">Moved out</TableHead><TableHead className="text-right">Other out</TableHead>
              <TableHead className="text-right">Expected</TableHead><TableHead className="text-right">Counted</TableHead>
              <TableHead className="text-right">Over / short</TableHead>{canCount && <TableHead className="print-hide" />}
            </TableRow></TableHeader>
            <TableBody>
              {days.map((d) => {
                const dayRows = rows.filter((r) => r.day === d);
                return (
                  <Fragment key={d}>
                    <TableRow className="bg-muted/40 hover:bg-muted/40">
                      <TableCell colSpan={canCount ? 13 : 12} className="py-1.5 text-xs font-semibold">
                        {new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" })} {formatDate(d)}
                        <span className="ml-3 font-normal text-muted-foreground">sales {formatMoney(dayRows.reduce((a, r) => a + N(r.sales), 0))} · banked {formatMoney(dayRows.reduce((a, r) => a + N(r.transfers_out), 0))}</span>
                      </TableCell>
                    </TableRow>
                    {dayRows.map((r) => {
                      const cash = r.account_type === "cash";
                      const diff = r.difference === null ? null : N(r.difference);
                      const z = (v: number) => (v === 0 ? <span className="text-muted-foreground">—</span> : formatMoney(v));
                      return (
                        <TableRow key={`${d}:${r.account_id}`}>
                          <TableCell className="whitespace-nowrap text-sm">{r.account_name}</TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">{formatMoney(N(r.opening))}</TableCell>
                          <TableCell className="text-right tabular-nums">{z(N(r.sales))}</TableCell>
                          <TableCell className="text-right tabular-nums">{z(N(r.receipts) + N(r.other_in))}</TableCell>
                          <TableCell className="text-right tabular-nums">{z(N(r.transfers_in))}</TableCell>
                          <TableCell className="text-right tabular-nums">{z(N(r.expenses))}</TableCell>
                          <TableCell className="text-right tabular-nums">{z(N(r.purchases))}</TableCell>
                          <TableCell className="text-right tabular-nums">{z(N(r.transfers_out))}</TableCell>
                          <TableCell className="text-right tabular-nums">{z(N(r.other_out))}</TableCell>
                          <TableCell className="text-right font-medium tabular-nums">{formatMoney(N(r.closing))}</TableCell>
                          <TableCell className="text-right tabular-nums">{r.counted === null ? (cash ? <span className="text-muted-foreground">not counted</span> : "") : formatMoney(N(r.counted))}
                            {r.count_notes && <div className="text-[11px] text-muted-foreground">{r.count_notes}</div>}</TableCell>
                          <TableCell className="text-right tabular-nums">{diff === null ? "" : diff === 0
                            ? <Badge variant="success">Balanced</Badge>
                            : <Badge variant={diff < 0 ? "destructive" : "warning"}>{diff < 0 ? "Short " : "Over "}{formatMoney(Math.abs(diff))}</Badge>}</TableCell>
                          {canCount && <TableCell className="print-hide">{cash && (ctx.user.isOwner || ctx.user.branchIds.includes(r.branch_id)) &&
                            <CountCell accountId={r.account_id} date={r.day} counted={r.counted === null ? null : N(r.counted)} notes={r.count_notes} />}</TableCell>}
                        </TableRow>
                      );
                    })}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        Balances come from the posted journals of each till. &quot;Moved out&quot; is cash transfers out of the till (e.g. to NMB); &quot;Other&quot; covers openings, voids and adjustments. A count posts nothing; a difference is shown until it is explained or corrected with an entry.
      </p>
    </div>
  );
}
