import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { ListToolbar } from "@/components/common/list-toolbar";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { formatMoney, formatDate } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ReceiptActions } from "./receipt-actions";
import { pageBranch } from "@/lib/branch-filter";

export const metadata: Metadata = { title: "Customer Payments" };

export default async function CustomerPaymentsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  await requirePermissionPage("sales.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canVoid = can(ctx.user, "transactions.void");
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  const term = q.replace(/[,()]/g, " ").trim();
  const customer = typeof sp.customer === "string" ? sp.customer : "";
  const { data: customers } = await admin.from("customers").select("id, name").eq("company_id", ctx.companyId).order("name");

  let query = admin.from("customer_receipts")
    .select("id, document_number, document_date, amount, reference, document_status, customer:customers(name), branch:branches(code), account:payment_accounts(name)", { count: "exact" })
    .eq("company_id", ctx.companyId).order("document_date", { ascending: false }).order("created_at", { ascending: false })
    .range((page - 1) * size, page * size - 1);
  if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  if (status) query = query.eq("document_status", status);
  if (branch) query = query.eq("branch_id", branch);
  if (customer) query = query.eq("customer_id", customer);
  if (from_) query = query.gte("document_date", from_);
  if (to_) query = query.lte("document_date", to_);
  if (term) query = query.or(`document_number.ilike.%${term}%,reference.ilike.%${term}%`);
  const { data: rows, count } = await query;
  const total = count ?? 0;
  const list = (rows ?? []) as unknown as Array<{
    id: string; document_number: string | null; document_date: string; amount: number; reference: string | null;
    document_status: string; customer: { name: string } | null; branch: { code: string } | null; account: { name: string } | null;
  }>;

  return (
    <div>
      <PageHeader
        title="Customer Payments"
        description="Receipts against outstanding invoices."
        actions={can(ctx.user, "sales.receive_payment") && <Button asChild><Link href="/sales/customer-payments/new">Receive Payment</Link></Button>}
      />
      <ListToolbar searchValue={q} searchPlaceholder="Search receipt no / reference..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branchParam, width: "w-[140px]", options: ctx.branches.map((b) => ({ value: b.id, label: b.code })) },
          { name: "customer", placeholder: "All customers", value: customer, width: "w-[200px]", options: (customers ?? []).map((x) => ({ value: x.id, label: x.name })) },
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [{ value: "draft", label: "Draft" }, { value: "posted", label: "Posted" }, { value: "voided", label: "Voided" }] },
        ]}
        dates={{ from: from_, to: to_ }} />
      {list.length === 0 ? (
        <EmptyState title="No receipts yet" />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Receipt</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Account</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.document_number ?? "—"}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.document_date)}</TableCell>
                  <TableCell className="text-sm">{r.customer?.name}</TableCell>
                  <TableCell className="text-sm">{r.branch?.code}</TableCell>
                  <TableCell className="text-sm">{r.account?.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.amount)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right"><ReceiptActions id={r.id} status={r.document_status} canVoid={canVoid} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager basePath="/sales/customer-payments" params={{ q, status, branch: branchParam, customer, from: from_, to: to_ }} page={page} pageSize={size} total={total} />
    </div>
  );
}
