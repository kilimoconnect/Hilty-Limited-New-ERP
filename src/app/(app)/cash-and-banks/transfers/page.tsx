import type { Metadata } from "next";
import Link from "next/link";
import { ClickableRow } from "@/components/common/clickable-row";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { ListToolbar } from "@/components/common/list-toolbar";
import { postTransfer, deleteTransferDraft, voidTransfer } from "@/lib/cash/actions";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { TxnActions } from "@/components/common/txn-actions";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { pageBranch } from "@/lib/branch-filter";

export const metadata: Metadata = { title: "Transfers" };

export default async function TransfersPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  await requirePermissionPage("cash_transfers.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canPost = can(ctx.user, "cash_transfers.post");
  const canOwner = can(ctx.user, "transactions.void");
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  const term = q.replace(/[,()]/g, " ").trim();
  const account = typeof sp.account === "string" ? sp.account : "";
  const { data: accounts } = await admin.from("payment_accounts").select("id, name").eq("company_id", ctx.companyId).order("name");

  let query = admin.from("cash_transfers")
    .select("id, document_number, transfer_date, amount, fee, document_status, reference, source:payment_accounts!cash_transfers_source_account_id_fkey(name), dest:payment_accounts!cash_transfers_destination_account_id_fkey(name)", { count: "exact" })
    .eq("company_id", ctx.companyId).order("transfer_date", { ascending: false }).order("created_at", { ascending: false })
    .range((page - 1) * size, page * size - 1);
  if (status) query = query.eq("document_status", status);
  if (branch) query = query.eq("source_branch_id", branch);
  if (account) query = query.or(`source_account_id.eq.${account},destination_account_id.eq.${account}`);
  if (from_) query = query.gte("transfer_date", from_);
  if (to_) query = query.lte("transfer_date", to_);
  if (term) query = query.or(`document_number.ilike.%${term}%,reference.ilike.%${term}%,description.ilike.%${term}%`);
  const { data: rows, count } = await query;
  const total = count ?? 0;
  const list = (rows ?? []) as unknown as Array<{ id: string; document_number: string | null; transfer_date: string; amount: number; fee: number; document_status: string; reference: string | null; source: { name: string } | null; dest: { name: string } | null }>;

  return (
    <div>
      <PageHeader title="Cash Transfers" actions={<Button asChild><Link href="/cash-and-banks/transfer">New Transfer</Link></Button>} />
      <ListToolbar searchValue={q} searchPlaceholder="Search transfer no / reference..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branchParam, width: "w-[140px]", options: ctx.branches.map((b) => ({ value: b.id, label: b.code })) },
          { name: "account", placeholder: "All accounts", value: account, width: "w-[200px]", options: (accounts ?? []).map((a) => ({ value: a.id, label: a.name })) },
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [{ value: "draft", label: "Draft" }, { value: "posted", label: "Posted" }, { value: "voided", label: "Voided" }] },
        ]}
        dates={{ from: from_, to: to_ }} />
      {list.length === 0 ? <EmptyState title="No transfers yet" /> : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Document</TableHead><TableHead>Date</TableHead><TableHead>From → To</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Fee</TableHead><TableHead>Status</TableHead><TableHead className="w-10 text-right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>
              {list.map((r) => (
                <ClickableRow key={r.id} href={`/cash-and-banks/transfers/${r.id}`}>
                  <TableCell className="font-mono text-xs">{r.document_number ?? <Badge variant="muted">Draft</Badge>}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.transfer_date)}</TableCell>
                  <TableCell className="text-sm">{r.source?.name} → {r.dest?.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.amount)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{formatMoney(r.fee)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right">
                    <TxnActions id={r.id} status={r.document_status} canPost={canPost} canOwner={canOwner}
                      editHref={can(ctx.user, "cash_transfers.edit_draft") ? `/cash-and-banks/transfers/${r.id}/edit` : undefined}
                      postAction={postTransfer} deleteAction={deleteTransferDraft} voidAction={voidTransfer} afterDeletePush="/cash-and-banks/transfers"
                      postLabel="Post transfer" extraItems={[{ label: "View", href: `/cash-and-banks/transfers/${r.id}` }]} />
                  </TableCell>
                </ClickableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager basePath="/cash-and-banks/transfers" params={{ q, status, branch: branchParam, account, from: from_, to: to_ }} page={page} pageSize={size} total={total} />
    </div>
  );
}
