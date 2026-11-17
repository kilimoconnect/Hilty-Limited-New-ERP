import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { ListToolbar } from "@/components/common/list-toolbar";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { postManualJournal, deleteManualJournalDraft, voidManualJournal } from "@/lib/accounting/actions";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { TxnActions } from "@/components/common/txn-actions";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Journal Entries" };

export default async function JournalsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  await requirePermissionPage("accounting.view_journals");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canPost = can(ctx.user, "accounting.post_manual_journal");
  const canOwner = can(ctx.user, "transactions.void");

  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const term = q.replace(/[,()]/g, " ").trim();
  const status = typeof sp.status === "string" ? sp.status : "";
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  let query = admin.from("manual_journal_drafts")
    .select("id, document_number, journal_date, reference, description, total_debit, document_status, is_control_adjustment", { count: "exact" })
    .eq("company_id", ctx.companyId).order("created_at", { ascending: false }).order("id", { ascending: false })
      .range((page - 1) * size, page * size - 1);
  if (status) query = query.eq("document_status", status);
  if (from_) query = query.gte("journal_date", from_);
  if (to_) query = query.lte("journal_date", to_);
  if (term) query = query.or(`document_number.ilike.%${term}%,reference.ilike.%${term}%,description.ilike.%${term}%`);
  const { data: rows, count } = await query;
  const list = (rows ?? []) as unknown as Array<{ id: string; document_number: string | null; journal_date: string; reference: string | null; description: string | null; total_debit: number; document_status: string; is_control_adjustment: boolean }>;

  return (
    <div>
      <PageHeader title="Journal Entries" description="Manual journals. Automatic journals from operational modules appear in the General Ledger."
        actions={can(ctx.user, "accounting.create_manual_journal") ? <Button asChild><Link href="/accounting/journals/new">New Journal</Link></Button> : null} />
      <ListToolbar searchValue={q} searchPlaceholder="Search journal no / reference..."
        selects={[
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [{ value: "draft", label: "Draft" }, { value: "posted", label: "Posted" }, { value: "voided", label: "Voided" }] },
        ]}
        dates={{ from: from_, to: to_ }} />
      {list.length === 0 ? <EmptyState title="No manual journals yet" /> : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Journal</TableHead><TableHead>Date</TableHead><TableHead>Description</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead className="w-10 text-right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.document_number ?? <Badge variant="muted">Draft</Badge>}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.journal_date)}</TableCell>
                  <TableCell className="text-sm">{r.description ?? r.reference ?? "—"}{r.is_control_adjustment && <Badge variant="warning" className="ml-2">control</Badge>}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.total_debit)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right">
                    <TxnActions id={r.id} status={r.document_status} canPost={canPost} canOwner={canOwner}
                      postAction={postManualJournal} deleteAction={deleteManualJournalDraft} voidAction={voidManualJournal}
                      postLabel="Post journal" afterDeletePush="/accounting/journals"
                      extraItems={[{ label: "View", href: `/accounting/journals/${r.id}` }]} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager basePath="/accounting/journals" params={{ q, status, from: from_, to: to_ }} page={page} pageSize={size} total={count ?? 0} />
    </div>
  );
}
