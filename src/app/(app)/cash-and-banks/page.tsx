import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ParamSelect } from "@/components/reports/report-tools";
import { formatMoney } from "@/lib/format";
import { OverdraftButton } from "./overdraft-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Cash and Banks" };

const TYPE_LABEL: Record<string, string> = { cash: "Cash", bank: "Bank", mobile_money: "Mobile money" };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function CashAndBanksPage(props: { searchParams: SP }) {
  await requirePermissionPage("cash_accounts.view");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const admin = createAdminClient();
  const showBal = can(ctx.user, "cash_accounts.view_balance");
  const showLedger = can(ctx.user, "cash_accounts.view_ledger");
  const isOwner = ctx.user.isOwner;

  // Which branch: the active one by default; "all" compares every branch the user works in.
  const mine = ctx.branches;
  const asked = typeof sp.branch === "string" ? sp.branch : "";
  const all = asked === "all" && mine.length > 1;
  const branch = all ? null : mine.find((b) => b.id === asked) ?? mine.find((b) => b.id === ctx.branchId) ?? mine[0] ?? null;
  const branchIds = all ? mine.map((b) => b.id) : branch ? [branch.id] : [];

  const [{ data: methods }, { data: rows }] = await Promise.all([
    admin.from("payment_methods").select("id, code, name, method_type, per_branch, sort_order").eq("company_id", ctx.companyId).order("sort_order").order("code"),
    branchIds.length ? admin.rpc("report_branch_method_balances", { p_company: ctx.companyId, p_branches: branchIds }) : Promise.resolve({ data: [] }),
  ]);
  type Bal = { branch_id: string; payment_method_id: string; payment_account_id: string; assigned: boolean; balance: number };
  const bal = ((rows ?? []) as Bal[]).map((r) => ({ ...r, balance: Number(r.balance) }));
  const mList = (methods ?? []).filter((m) => bal.some((r) => r.payment_method_id === m.id));
  const cell = (b: string, m: string) => bal.find((r) => r.branch_id === b && r.payment_method_id === m);
  const ledgerHref = (r: Bal, perBranch: boolean) => `/cash-and-banks/accounts/${r.payment_account_id}${perBranch ? "" : `?branch=${r.branch_id}`}`;
  const total = bal.reduce((s, r) => s + r.balance, 0);
  const shownBranches = mine.filter((b) => branchIds.includes(b.id));

  // The Owner also sees every account of the company (overdraft settings, inactive ones).
  const accounts = isOwner ? (await admin.from("payment_accounts")
    .select("id, code, name, account_type, provider, allow_negative, overdraft_limit, is_active")
    .eq("company_id", ctx.companyId).order("code")).data ?? [] : [];
  const withBal = await Promise.all(accounts.map(async (a) => {
    const { data } = showBal ? await admin.rpc("payment_account_balance", { p_pa: a.id }) : { data: 0 };
    const balance = Number(data ?? 0);
    return { ...a, balance, available: balance + (a.allow_negative ? Number(a.overdraft_limit) : 0) };
  }));

  return (
    <div className="space-y-4">
      <PageHeader title="Cash and Banks"
        description="Balance of each payment method for the branch: cash and mobile money in the branch's own account; for banks, the branch's own deposits and payments. Derived from posted journal entries — never edited directly." />

      <div className="flex flex-wrap items-center gap-3">
        <ParamSelect param="branch" value={all ? "all" : branch?.id ?? ""} placeholder="Branch"
          options={[...mine.map((b) => ({ id: b.id, label: `${b.code} — ${b.name}` })), ...(mine.length > 1 ? [{ id: "all", label: "All my branches (compare)" }] : [])]} />
      </div>

      {showBal && branchIds.length > 0 && (
        <Card><CardContent className="p-5">
          <p className="text-xs uppercase text-muted-foreground">{all ? "Total, all my branches" : `Total — ${branch?.code} ${branch?.name}`}</p>
          <p className="text-2xl font-semibold tabular-nums">{formatMoney(total)}</p>
        </CardContent></Card>
      )}

      {mList.length === 0 ? <EmptyState title="No payment methods for this branch" description="Assign them in Admin → Payment Methods & Banks." /> : !all ? (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Payment method</TableHead><TableHead>Type</TableHead>
              {showBal && <TableHead className="text-right">Balance at {branch?.code}</TableHead>}
              <TableHead className="text-right">Ledger</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {mList.map((m) => {
                const r = cell(branch!.id, m.id)!;
                return (
                  <TableRow key={m.id}>
                    <TableCell><div className="font-medium">{m.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">{m.code}{!r.assigned && " · no longer assigned"}</div></TableCell>
                    <TableCell className="text-sm">{TYPE_LABEL[m.method_type]}<span className="block text-xs text-muted-foreground">{m.per_branch ? "branch account" : "branch share of the bank"}</span></TableCell>
                    {showBal && <TableCell className={`text-right tabular-nums font-medium ${r.balance < 0 ? "text-destructive" : ""}`}>{formatMoney(r.balance)}</TableCell>}
                    <TableCell className="text-right">{showLedger && <Link href={ledgerHref(r, m.per_branch)} className="text-sm font-medium text-primary hover:underline">Ledger</Link>}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      ) : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Payment method</TableHead>
              {shownBranches.map((b) => <TableHead key={b.id} className="text-right">{b.code}</TableHead>)}
              <TableHead className="text-right">Total</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {mList.map((m) => (
                <TableRow key={m.id}>
                  <TableCell className="font-medium">{m.name}</TableCell>
                  {shownBranches.map((b) => {
                    const r = cell(b.id, m.id);
                    return <TableCell key={b.id} className={`text-right tabular-nums ${r && r.balance < 0 ? "text-destructive" : ""}`}>
                      {!r ? <span className="text-muted-foreground">—</span> : showLedger
                        ? <Link href={ledgerHref(r, m.per_branch)} className="hover:underline">{showBal ? formatMoney(r.balance) : "Ledger"}</Link>
                        : showBal ? formatMoney(r.balance) : ""}
                    </TableCell>;
                  })}
                  <TableCell className="text-right font-semibold tabular-nums">{showBal ? formatMoney(bal.filter((r) => r.payment_method_id === m.id).reduce((s, r) => s + r.balance, 0)) : ""}</TableCell>
                </TableRow>
              ))}
              {showBal && (
                <TableRow className="border-t-2 font-semibold">
                  <TableCell>Total</TableCell>
                  {shownBranches.map((b) => <TableCell key={b.id} className="text-right tabular-nums">{formatMoney(bal.filter((r) => r.branch_id === b.id).reduce((s, r) => s + r.balance, 0))}</TableCell>)}
                  <TableCell className="text-right tabular-nums">{formatMoney(total)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      {isOwner && withBal.length > 0 && (
        <div className="pt-4">
          <h3 className="mb-1 font-semibold">All accounts (company)</h3>
          <p className="mb-2 text-xs text-muted-foreground">Every account behind the payment methods, with the full balance of each bank. Owner only.</p>
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader><TableRow>
                <TableHead>Account</TableHead><TableHead>Type</TableHead><TableHead>Provider</TableHead>
                {showBal && <TableHead className="text-right">Balance</TableHead>}
                {showBal && <TableHead className="text-right">Available</TableHead>}
                <TableHead>Status</TableHead><TableHead className="text-right">Ledger</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {withBal.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell><div className="font-medium">{a.name}</div><div className="font-mono text-xs text-muted-foreground">{a.code}</div></TableCell>
                    <TableCell className="text-sm capitalize">{a.account_type.replace("_", " ")}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{a.provider ?? "—"}</TableCell>
                    {showBal && <TableCell className="text-right tabular-nums">{formatMoney(a.balance)}</TableCell>}
                    {showBal && <TableCell className="text-right tabular-nums text-muted-foreground">{formatMoney(a.available)}</TableCell>}
                    <TableCell><Badge variant={a.is_active ? "success" : "muted"}>{a.is_active ? "Active" : "Inactive"}</Badge></TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-3">
                        <OverdraftButton account={{ id: a.id, name: a.name, allow_negative: a.allow_negative, overdraft_limit: Number(a.overdraft_limit) }} />
                        {showLedger && <Link href={`/cash-and-banks/accounts/${a.id}`} className="text-sm font-medium text-primary hover:underline">Ledger</Link>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </div>
  );
}
