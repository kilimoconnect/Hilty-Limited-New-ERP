import type { Metadata } from "next";
import Link from "next/link";
import {
  TrendingUp, HandCoins, Wallet, Boxes, AlertTriangle, Truck, Receipt, ShoppingBag, Banknote, Coins, Landmark,
} from "lucide-react";
import { requireActiveUser } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/batch";
import { getActiveContext, can } from "@/lib/context";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PayStatusBadge } from "@/components/common/doc-status-badge";
import { ParamSelect } from "@/components/reports/report-tools";
import { str } from "@/components/reports/pager";
import { formatMoney, formatDate, todayISO } from "@/lib/format";
import { addDays, reportBranches } from "@/lib/reports/scope";
import { profitAndLoss } from "@/lib/reports/queries";
import { receivablesAgeing, payablesAgeing, vatReport } from "@/lib/reports/subledger";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Dashboard" };

type SP = Record<string, string | string[] | undefined>;
const PERIODS = [
  { id: "today", label: "Today" }, { id: "yesterday", label: "Yesterday" }, { id: "week", label: "This week" },
  { id: "month", label: "This month" }, { id: "30d", label: "Last 30 days" },
] as const;
type PeriodId = (typeof PERIODS)[number]["id"];

/** Start and end (inclusive, company dates) of a dashboard period. Weeks start on Monday. */
function periodRange(id: PeriodId, today: string): { start: string; end: string } {
  switch (id) {
    case "yesterday": { const y = addDays(today, -1); return { start: y, end: y }; }
    case "week": { const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; return { start: addDays(today, -dow), end: today }; }
    case "month": return { start: `${today.slice(0, 8)}01`, end: today };
    case "30d": return { start: addDays(today, -29), end: today };
    default: return { start: today, end: today };
  }
}
const N = (v: unknown) => Number(v ?? 0);

export default async function DashboardPage(props: { searchParams: Promise<SP> }) {
  const user = await requireActiveUser();
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const companyId = ctx.companyId;
  const sp = await props.searchParams;
  // Cost of sales and gross profit are for the Owner only.
  const showSalesCost = user.isOwner;
  const showInvCost = can(user, "inventory.view_cost");
  const showBal = can(user, "cash_accounts.view_balance");

  const today = todayISO();
  const period: PeriodId = (PERIODS.find((p) => p.id === str(sp, "period"))?.id ?? "today");
  const { start, end } = periodRange(period, today);
  const branch = str(sp, "branch");
  const branches = reportBranches(ctx, branch);          // null = whole company
  const none = !!branches && branches.length === 0;
  // Adds the branch filter to a query when the dashboard is limited to branches.
  const scoped = <Q,>(q: Q): Q => (branches ? (q as unknown as { in: (c: string, v: string[]) => Q }).in("branch_id", branches) : q);
  const branchList = ctx.branches.filter((b) => !branches || branches.includes(b.id));

  const { data: company } = await admin.from("companies").select("name").eq("id", companyId).maybeSingle();

  type SalesRow = { key: string; label: string; docs: number; net: number; gross: number; cogs: number; collected: number };
  type PurRow = { key: string; gross: number };
  const rpc = <T,>(fn: string, args: Record<string, unknown>) => selectAll<T>(() => admin.rpc(fn, args));
  const base = { p_company: companyId, p_branches: branches, p_start: start, p_end: end };

  const [salesByBranch, collections, purByBranch, expenses, income, balances, arRows, apRows, accounts, recent] = none
    ? [[], [], [], [], [], [], [], [], [], []] as never
    : await Promise.all([
      rpc<SalesRow>("report_sales_summary", { ...base, p_group: "branch" }),
      rpc<SalesRow>("report_sales_summary", { ...base, p_group: "method" }),
      rpc<PurRow>("report_purchase_summary", { ...base, p_group: "branch" }),
      selectAll<{ branch_id: string; grand_total: number }>(() => scoped(admin.from("expenses").select("id, branch_id, grand_total")
        .eq("company_id", companyId).eq("document_status", "posted").gte("document_date", start).lte("document_date", end)).order("id")),
      selectAll<{ grand_total: number }>(() => scoped(admin.from("other_income_transactions").select("id, grand_total")
        .eq("company_id", companyId).eq("document_status", "posted").gte("document_date", start).lte("document_date", end)).order("id")),
      selectAll<{ branch_id: string; quantity: number; stock_value: number; qty_in_transit: number; product: { reorder_level: number } | null }>(() =>
        scoped(admin.from("stock_balances").select("id, branch_id, quantity, stock_value, qty_in_transit, product:products(reorder_level)").eq("company_id", companyId)).order("id")),
      selectAll<{ outstanding: number }>(() => scoped(admin.from("sales").select("id, outstanding")
        .eq("company_id", companyId).eq("document_status", "posted").gt("outstanding", 0)).order("id")),
      selectAll<{ outstanding: number }>(() => scoped(admin.from("supplier_payables").select("id, outstanding")
        .eq("company_id", companyId).in("status", ["open", "partial"])).order("id")),
      admin.from("payment_accounts").select("id, branch_id").eq("company_id", companyId).eq("is_active", true).then((r) => r.data ?? []),
      scoped(admin.from("sales").select("id, document_number, document_date, grand_total, payment_status, customer:customers(name), branch:branches(code)")
        .eq("company_id", companyId).eq("document_status", "posted")).order("document_date", { ascending: false }).order("created_at", { ascending: false }).limit(6)
        .then((r) => (r.data ?? []) as unknown as { id: string; document_number: string | null; document_date: string; grand_total: number; payment_status: string; customer: { name: string } | null; branch: { code: string } | null }[]),
    ]);

  const sales = salesByBranch.reduce((a: number, r: SalesRow) => a + N(r.gross), 0);
  const net = salesByBranch.reduce((a: number, r: SalesRow) => a + N(r.net), 0);
  const cogs = salesByBranch.reduce((a: number, r: SalesRow) => a + N(r.cogs), 0);
  const received = collections.reduce((a: number, r: SalesRow) => a + N(r.collected), 0);
  const purchases = purByBranch.reduce((a: number, r: PurRow) => a + N(r.gross), 0);
  const expenseTotal = expenses.reduce((a: number, r: { grand_total: number }) => a + N(r.grand_total), 0);
  const incomeTotal = income.reduce((a: number, r: { grand_total: number }) => a + N(r.grand_total), 0);
  const stockValue = balances.reduce((a: number, b: { stock_value: number }) => a + N(b.stock_value), 0);
  const inTransit = balances.reduce((a: number, b: { qty_in_transit: number }) => a + N(b.qty_in_transit), 0);
  const lowStock = balances.filter((b: { quantity: number; product: { reorder_level: number } | null }) => N(b.quantity) <= N(b.product?.reorder_level)).length;
  const ar = arRows.reduce((a: number, r: { outstanding: number }) => a + N(r.outstanding), 0);
  const ap = apRows.reduce((a: number, r: { outstanding: number }) => a + N(r.outstanding), 0);

  // Money held: one branch -> its tills; whole company -> every account (banks too).
  const cashByAccount = new Map<string, number>();
  if (showBal) {
    const shown = (accounts as { id: string; branch_id: string | null }[]).filter((a) => branches ? a.branch_id && branches.includes(a.branch_id) : true);
    const bals = await Promise.all(shown.map(async (a) => [a.id, N((await admin.rpc("payment_account_balance", { p_pa: a.id })).data)] as const));
    for (const [id, v] of bals) cashByAccount.set(id, v);
  }
  const cashTotal = Array.from(cashByAccount.values()).reduce((a, v) => a + v, 0);
  const tillsOf = (bid: string) => (accounts as { id: string; branch_id: string | null }[]).filter((a) => a.branch_id === bid)
    .reduce((s, a) => s + (cashByAccount.get(a.id) ?? 0), 0);

  const periodLabel = PERIODS.find((p) => p.id === period)!.label;
  const periodText = start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
  const flow: { label: string; value: string; icon: typeof TrendingUp; hidden?: boolean }[] = [
    { label: "Sales", value: formatMoney(sales), icon: TrendingUp },
    { label: "Received", value: formatMoney(received), icon: HandCoins },
    { label: "Cost of sales", value: formatMoney(cogs), icon: Receipt, hidden: !showSalesCost },
    { label: "Gross profit", value: `${formatMoney(net - cogs)}`, icon: TrendingUp, hidden: !showSalesCost },
    { label: "Purchases", value: formatMoney(purchases), icon: ShoppingBag },
    { label: "Expenses", value: formatMoney(expenseTotal), icon: Banknote },
    { label: "Other income", value: formatMoney(incomeTotal), icon: Coins },
  ].filter((s) => !s.hidden);
  const position: { label: string; value: string; icon: typeof TrendingUp; hidden?: boolean }[] = [
    { label: "Outstanding receivables", value: formatMoney(ar), icon: Wallet },
    { label: "Outstanding payables", value: formatMoney(ap), icon: Wallet },
    { label: "Stock value", value: formatMoney(stockValue), icon: Boxes, hidden: !showInvCost },
    { label: "Low-stock items", value: String(lowStock), icon: AlertTriangle },
    { label: "Stock in transit", value: String(inTransit), icon: Truck },
    { label: branches ? "Cash in branch tills" : "Cash & bank total", value: formatMoney(cashTotal), icon: Landmark, hidden: !showBal },
  ].filter((s) => !s.hidden);

  // Per-branch comparison (whole company or several branches).
  const perBranch = branchList.filter((b) => b.code !== "HQ" || salesByBranch.some((r: SalesRow) => r.key === b.id)).map((b) => {
    const s = salesByBranch.find((r: SalesRow) => r.key === b.id);
    return {
      id: b.id, code: b.code, name: b.name,
      sales: N(s?.gross), profit: N(s?.net) - N(s?.cogs), invoices: N(s?.docs),
      purchases: N(purByBranch.find((r: PurRow) => r.key === b.id)?.gross),
      expenses: expenses.filter((e: { branch_id: string }) => e.branch_id === b.id).reduce((a: number, e: { grand_total: number }) => a + N(e.grand_total), 0),
      cash: tillsOf(b.id),
      stock: balances.filter((x: { branch_id: string }) => x.branch_id === b.id).reduce((a: number, x: { stock_value: number }) => a + N(x.stock_value), 0),
    };
  });

  // Company financial summary for the period (whole company only: ledgers are company-wide).
  const showFin = can(user, "reports.view_profit_loss") && !branches;
  let fin: { label: string; value: string }[] = [];
  if (showFin) {
    const [pl, ara, apa, vat] = await Promise.all([
      profitAndLoss(companyId, start, end), receivablesAgeing(companyId, end), payablesAgeing(companyId, end), vatReport(companyId, start, end),
    ]);
    const overdueAr = ara.buckets.d1_30 + ara.buckets.d31_60 + ara.buckets.d61_90 + ara.buckets.d90;
    const overdueAp = apa.buckets.d1_30 + apa.buckets.d31_60 + apa.buckets.d61_90 + apa.buckets.d90;
    fin = [
      { label: "Revenue", value: formatMoney(pl.netSales) },
      ...(showSalesCost ? [{ label: "Gross profit", value: formatMoney(pl.grossProfit) }, { label: "Net profit", value: formatMoney(pl.netProfit) }] : []),
      { label: "VAT payable / (refund)", value: formatMoney(vat.netVat) },
      { label: "Accounts receivable", value: formatMoney(ara.total) }, { label: "Overdue receivables", value: formatMoney(overdueAr) },
      { label: "Accounts payable", value: formatMoney(apa.total) }, { label: "Overdue payables", value: formatMoney(overdueAp) },
    ];
  }

  const href = (p: PeriodId) => {
    const q = new URLSearchParams();
    if (p !== "today") q.set("period", p);
    if (branch) q.set("branch", branch);
    const s = q.toString();
    return s ? `/dashboard?${s}` : "/dashboard";
  };
  const selectedBranch = ctx.branches.find((b) => b.id === branch);

  return (
    <div>
      <PageHeader title={`Welcome${user.fullName ? `, ${user.fullName.split(" ")[0]}` : ""}`}
        description={`${company?.name ?? "Hilty ERP"} · ${selectedBranch ? `${selectedBranch.name} · ` : ""}${periodLabel}: ${periodText}`} />

      <div className="mb-4 flex flex-wrap items-center gap-2 print-hide">
        <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1">
          {PERIODS.map((p) => (
            <Link key={p.id} href={href(p.id)}
              className={cn("rounded-md px-3 py-1.5 text-sm", p.id === period ? "bg-primary text-primary-foreground" : "hover:bg-muted")}>
              {p.label}
            </Link>
          ))}
        </div>
        {ctx.branches.length > 1 && (
          <ParamSelect param="branch" value={branch} placeholder={user.isOwner ? "All branches" : "All my branches"}
            options={ctx.branches.map((b) => ({ id: b.id, label: `${b.code} - ${b.name}` }))} />
        )}
      </div>

      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{periodLabel}</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-7">
        {flow.map((s) => {
          const Icon = s.icon;
          return (
            <Card key={s.label} className="p-4">
              <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary"><Icon className="h-[18px] w-[18px]" /></div>
              <p className="break-words text-base font-semibold tabular-nums">{s.value}</p>
              <p className="text-xs text-muted-foreground">{s.label}</p>
            </Card>
          );
        })}
      </div>

      <h2 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Right now</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
        {position.map((s) => {
          const Icon = s.icon;
          return (
            <Card key={s.label} className="p-4">
              <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-md bg-muted text-muted-foreground"><Icon className="h-[18px] w-[18px]" /></div>
              <p className="break-words text-base font-semibold tabular-nums">{s.value}</p>
              <p className="text-xs text-muted-foreground">{s.label}</p>
            </Card>
          );
        })}
      </div>

      {perBranch.length > 1 && (
        <Card className="mt-5 overflow-x-auto">
          <CardContent className="p-0">
            <h2 className="px-5 pt-4 text-sm font-semibold">By branch · {periodLabel.toLowerCase()}</h2>
            <Table>
              <TableHeader><TableRow>
                <TableHead>Branch</TableHead><TableHead className="text-right">Invoices</TableHead><TableHead className="text-right">Sales</TableHead>
                {showSalesCost && <TableHead className="text-right">Gross profit</TableHead>}
                <TableHead className="text-right">Purchases</TableHead><TableHead className="text-right">Expenses</TableHead>
                {showBal && <TableHead className="text-right">Cash in tills</TableHead>}
                {showInvCost && <TableHead className="text-right">Stock value</TableHead>}
              </TableRow></TableHeader>
              <TableBody>
                {perBranch.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell><Link className="font-medium text-primary hover:underline" href={`/dashboard?${new URLSearchParams({ ...(period !== "today" && { period }), branch: b.id })}`}>{b.code}</Link>
                      <span className="ml-2 text-sm text-muted-foreground">{b.name}</span></TableCell>
                    <TableCell className="text-right tabular-nums">{b.invoices}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{formatMoney(b.sales)}</TableCell>
                    {showSalesCost && <TableCell className="text-right tabular-nums">{formatMoney(b.profit)}</TableCell>}
                    <TableCell className="text-right tabular-nums">{formatMoney(b.purchases)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(b.expenses)}</TableCell>
                    {showBal && <TableCell className="text-right tabular-nums">{formatMoney(b.cash)}</TableCell>}
                    {showInvCost && <TableCell className="text-right tabular-nums">{formatMoney(b.stock)}</TableCell>}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {fin.length > 0 && (
        <div className="mt-5">
          <h2 className="mb-2 text-sm font-semibold">Financial summary · {periodLabel.toLowerCase()}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {fin.map((s) => (
              <Card key={s.label} className="p-4">
                <p className="break-words text-base font-semibold tabular-nums">{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </Card>
            ))}
          </div>
        </div>
      )}

      <Card className="mt-6">
        <CardContent className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Recent posted sales</h2>
            <Link href="/sales/history" className="text-sm text-primary hover:underline">View all</Link>
          </div>
          {recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">No posted sales yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {recent.map((s: { id: string; document_number: string | null; document_date: string; grand_total: number; payment_status: string; customer: { name: string } | null; branch: { code: string } | null }) => (
                <Link key={s.id} href={`/sales/${s.id}`} className="flex items-center justify-between gap-3 py-2 text-sm hover:bg-muted/40">
                  <div className="min-w-0">
                    <span className="font-mono text-xs">{s.document_number}</span>
                    <span className="ml-2 text-muted-foreground">{s.customer?.name} · {s.branch?.code} · {formatDate(s.document_date)}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <PayStatusBadge status={s.payment_status} />
                    <span className="tabular-nums font-medium">{formatMoney(s.grand_total)}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
