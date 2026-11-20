import type { Metadata } from "next";
import Link from "next/link";
import { ClickableRow } from "@/components/common/clickable-row";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListToolbar } from "@/components/common/list-toolbar";
import { DocStatusBadge, PayStatusBadge } from "@/components/common/doc-status-badge";
import { formatMoney, formatDate } from "@/lib/format";
import { pageBranch } from "@/lib/branch-filter";
import { backOf, selfPath, withBack } from "@/lib/back-link";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Sales History" };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function SalesHistoryPage(props: { searchParams: SP }) {
  await requirePermissionPage("sales.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();

  const sp = await props.searchParams;
  // Opened documents can come back to this exact list (filters and page).
  const here = selfPath("/sales/history", sp);
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  const pay = typeof sp.pay === "string" ? sp.pay : "";
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  const from = (page - 1) * size, to = from + size - 1;

  let query = admin.from("sales")
    .select("id, document_number, document_date, net_total, tax_total, grand_total, amount_paid, outstanding, payment_status, document_status, customer:customers(name), branch:branches(code)", { count: "exact" })
    .eq("company_id", ctx.companyId)
    .order("document_date", { ascending: false }).order("created_at", { ascending: false })
    .range(from, to);
  if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  if (branch) query = query.eq("branch_id", branch);
  if (status) query = query.eq("document_status", status);
  if (pay) query = query.eq("payment_status", pay);
  if (q) query = query.ilike("document_number", `%${q}%`);
  if (from_) query = query.gte("document_date", from_);
  if (to_) query = query.lte("document_date", to_);

  const { data, count } = await query;
  const rows = (data ?? []) as unknown as Array<{
    id: string; document_number: string | null; document_date: string; net_total: number; tax_total: number;
    grand_total: number; amount_paid: number; outstanding: number; payment_status: string; document_status: string;
    customer: { name: string } | null; branch: { code: string } | null;
  }>;
  const total = count ?? 0;

  return (
    <div>
      <PageHeader
        title="Sales History"
        description="Posted, draft and voided sales."
        actions={<Button asChild><Link href="/sales/new">New Sale</Link></Button>}
      />
      <ListToolbar
        searchValue={q}
        searchPlaceholder="Search invoice number..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branchParam, width: "w-[150px]", options: ctx.branches.map((b) => ({ value: b.id, label: b.code })) },
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [
            { value: "draft", label: "Draft" }, { value: "posted", label: "Posted" }, { value: "voided", label: "Voided" }] },
          { name: "pay", placeholder: "All payments", value: pay, width: "w-[160px]", options: [
            { value: "unpaid", label: "Unpaid" }, { value: "partially_paid", label: "Partial" }, { value: "paid", label: "Paid" },
            { value: "partially_refunded", label: "Part. refunded" }, { value: "refunded", label: "Refunded" }] },
        ]}
        dates={{ from: from_, to: to_ }}
      />

      {rows.length === 0 ? (
        <EmptyState title="No sales found" />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Open</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <ClickableRow key={r.id} href={withBack(`/sales/${r.id}`, here, "Sales History")}>
                  <TableCell className="text-sm">{formatDate(r.document_date)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.document_number ?? <Badge variant="muted">Draft</Badge>}</TableCell>
                  <TableCell className="text-sm">{r.branch?.code}</TableCell>
                  <TableCell className="text-sm">{r.customer?.name ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.grand_total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.outstanding)}</TableCell>
                  <TableCell><PayStatusBadge status={r.payment_status} /></TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right">
                    <Link href={`/sales/${r.id}`} className="text-sm font-medium text-primary hover:underline">Open</Link>
                  </TableCell>
                </ClickableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Pager basePath="/sales/history" params={{ q, status, pay, branch: branchParam, from: from_, to: to_ }} page={page} pageSize={size} total={total} />
    </div>
  );
}
