import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { ListToolbar } from "@/components/common/list-toolbar";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { can } from "@/lib/context";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Bank Reconciliation" };

export default async function ReconciliationListPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  await requirePermissionPage("reconciliation.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const status = typeof sp.status === "string" ? sp.status : "";
  const account = typeof sp.account === "string" ? sp.account : "";
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  const { data: accountOptions } = await admin.from("payment_accounts").select("id, name").eq("company_id", ctx.companyId).order("name");
  let query = admin.from("bank_reconciliations")
    .select("id, statement_start, statement_end, statement_closing, status, account:payment_accounts(name)", { count: "exact" })
    .eq("company_id", ctx.companyId).order("created_at", { ascending: false }).order("id", { ascending: false })
      .range((page - 1) * size, page * size - 1);
  if (status) query = query.eq("status", status);
  if (account) query = query.eq("payment_account_id", account);
  if (from_) query = query.gte("statement_end", from_);
  if (to_) query = query.lte("statement_end", to_);
  const { data: rows, count } = await query;
  const list = (rows ?? []) as unknown as Array<{ id: string; statement_start: string; statement_end: string; statement_closing: number; status: string; account: { name: string } | null }>;
  const variant = (s: string) => s === "finalized" ? "success" : s === "reopened" ? "warning" : "muted";

  return (
    <div>
      <PageHeader title="Bank & Mobile-Money Reconciliation" description="Match statement lines to posted ERP entries."
        actions={can(ctx.user, "reconciliation.create") ? <Button asChild><Link href="/cash-and-banks/reconciliation/new">New Reconciliation</Link></Button> : null} />
      <ListToolbar searchPlaceholder="Search..."
        selects={[
          { name: "account", placeholder: "All accounts", value: account, width: "w-[190px]", options: (accountOptions ?? []).map((o) => ({ value: o.id, label: o.name })) },
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [{ value: "draft", label: "Draft" }, { value: "finalized", label: "Finalized" }] },
        ]}
        dates={{ from: from_, to: to_ }} />
      {list.length === 0 ? <EmptyState title="No reconciliations yet" /> : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Account</TableHead><TableHead>Period</TableHead><TableHead className="text-right">Closing</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Open</TableHead></TableRow></TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-sm font-medium">{r.account?.name}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.statement_start)} → {formatDate(r.statement_end)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.statement_closing)}</TableCell>
                  <TableCell><Badge variant={variant(r.status)}>{r.status.replace("_", " ")}</Badge></TableCell>
                  <TableCell className="text-right"><Link href={`/cash-and-banks/reconciliation/${r.id}`} className="text-sm font-medium text-primary hover:underline">Open</Link></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager basePath="/cash-and-banks/reconciliation" params={{ status, account, from: from_, to: to_ }} page={page} pageSize={size} total={count ?? 0} />
    </div>
  );
}
