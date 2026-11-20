import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { postOtherIncome, deleteOtherIncomeDraft, voidOtherIncome } from "@/lib/other-income/actions";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ListToolbar } from "@/components/common/list-toolbar";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { TxnActions } from "@/components/common/txn-actions";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pageBranch } from "@/lib/branch-filter";

export const metadata: Metadata = { title: "Other Income History" };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function IncomeHistoryPage(props: { searchParams: SP }) {
  await requirePermissionPage("other_income.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canPost = can(ctx.user, "other_income.post");
  const canOwner = can(ctx.user, "transactions.void");
  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  const status = typeof sp.status === "string" ? sp.status : "";
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const type = typeof sp.type === "string" ? sp.type : "";
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  const term = q.replace(/[,()]/g, " ").trim();
  const { data: types } = await admin.from("other_income_types").select("id, name").eq("company_id", ctx.companyId).order("name");

  let query = admin.from("other_income_transactions")
    .select("id, document_number, document_date, net_total, tax_total, grand_total, received_from, document_status, income_type:other_income_types(name), branch:branches(code)", { count: "exact" })
    .eq("company_id", ctx.companyId).order("document_date", { ascending: false }).order("created_at", { ascending: false })
    .range((page - 1) * size, page * size - 1);
  if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  if (status) query = query.eq("document_status", status);
  if (branch) query = query.eq("branch_id", branch);
  if (type) query = query.eq("income_type_id", type);
  if (from_) query = query.gte("document_date", from_);
  if (to_) query = query.lte("document_date", to_);
  if (term) query = query.or(`document_number.ilike.%${term}%,received_from.ilike.%${term}%`);
  const { data: found, count } = await query;
  const total = count ?? 0;
  const rows = (found ?? []) as unknown as Array<{ id: string; document_number: string | null; document_date: string; net_total: number; tax_total: number; grand_total: number; received_from: string | null; document_status: string; income_type: { name: string } | null; branch: { code: string } | null }>;

  return (
    <div>
      <PageHeader title="Other Income History" actions={<Button asChild><Link href="/other-income/new">New Income</Link></Button>} />
      <ListToolbar searchValue={q} searchPlaceholder="Search income no / received from..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branchParam, width: "w-[140px]", options: ctx.branches.map((b) => ({ value: b.id, label: b.code })) },
          { name: "type", placeholder: "All income types", value: type, width: "w-[200px]", options: (types ?? []).map((t) => ({ value: t.id, label: t.name })) },
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [{ value: "draft", label: "Draft" }, { value: "posted", label: "Posted" }, { value: "voided", label: "Voided" }] },
        ]}
        dates={{ from: from_, to: to_ }} />
      {rows.length === 0 ? <EmptyState title="No income records found" /> : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Document</TableHead><TableHead>Type</TableHead><TableHead>From</TableHead><TableHead className="text-right">Net</TableHead><TableHead className="text-right">Tax</TableHead><TableHead className="text-right">Total</TableHead><TableHead>Status</TableHead><TableHead className="w-10 text-right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-sm">{formatDate(r.document_date)}</TableCell>
                  <TableCell className="font-mono text-xs">{r.document_number ?? <Badge variant="muted">Draft</Badge>}</TableCell>
                  <TableCell className="text-sm">{r.income_type?.name}</TableCell>
                  <TableCell className="text-sm">{r.received_from ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.net_total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.tax_total)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.grand_total)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right">
                    <TxnActions id={r.id} status={r.document_status} canPost={canPost} canOwner={canOwner}
                      editHref={can(ctx.user, "other_income.edit_draft") ? `/other-income/${r.id}/edit` : undefined}
                      postAction={postOtherIncome} deleteAction={deleteOtherIncomeDraft} voidAction={voidOtherIncome} afterDeletePush="/other-income/history"
                      extraItems={[{ label: "View", href: `/other-income/${r.id}` }]} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager basePath="/other-income/history" params={{ q, status, branch: branchParam, type, from: from_, to: to_ }} page={page} pageSize={size} total={total} />
    </div>
  );
}
