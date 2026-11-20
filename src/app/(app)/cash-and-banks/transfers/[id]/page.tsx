import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { postTransfer, deleteTransferDraft, voidTransfer } from "@/lib/cash/actions";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { TxnActions, EditDraftButton } from "@/components/common/txn-actions";
import { formatMoney, formatDate } from "@/lib/format";
import { isFeatureEnabled } from "@/lib/features";
import { AttachmentsPanel } from "@/components/common/attachments-panel";
import { PrintLink } from "@/components/print/print-link";

export const metadata: Metadata = { title: "Transfer" };
type Params = Promise<{ id: string }>;

export default async function TransferDetail(props: { params: Params }) {
  await requirePermissionPage("cash_transfers.view");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();
  const { data: t } = await admin.from("cash_transfers")
    .select("*, source:payment_accounts!cash_transfers_source_account_id_fkey(name), dest:payment_accounts!cash_transfers_destination_account_id_fkey(name)")
    .eq("id", id).maybeSingle();
  if (!t || t.company_id !== ctx.companyId) notFound();
  const v = t as Record<string, unknown> as { document_number: string | null; document_status: string; transfer_date: string; amount: number; fee: number; reference: string | null; description: string | null; void_reason: string | null; source: { name: string } | null; dest: { name: string } | null };

  return (
    <div>
      <PageHeader title={v.document_number ?? "Transfer (draft)"} description={`${v.source?.name} → ${v.dest?.name} · ${formatDate(v.transfer_date)}`}
        actions={<div className="flex items-center gap-2"><PrintLink kind="cash-transfer" id={id} />{can(ctx.user, "cash_transfers.edit_draft") && <EditDraftButton href={`/cash-and-banks/transfers/${id}/edit`} status={v.document_status} />}<TxnActions id={id} status={v.document_status} editHref={can(ctx.user, "cash_transfers.edit_draft") ? `/cash-and-banks/transfers/${id}/edit` : undefined} canPost={can(ctx.user, "cash_transfers.post")} canOwner={can(ctx.user, "transactions.void")} postAction={postTransfer} deleteAction={deleteTransferDraft} voidAction={voidTransfer} afterDeletePush="/cash-and-banks/transfers" postLabel="Post transfer" /></div>} />
      <Card className="max-w-lg"><CardContent className="space-y-2 p-5 text-sm">
        <div className="flex justify-between"><span className="text-muted-foreground">Status</span><DocStatusBadge status={v.document_status} /></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="tabular-nums font-semibold">{formatMoney(v.amount)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Fee</span><span className="tabular-nums">{formatMoney(v.fee)}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Source decreases by</span><span className="tabular-nums">{formatMoney(Number(v.amount) + Number(v.fee))}</span></div>
        <div className="flex justify-between"><span className="text-muted-foreground">Reference</span><span>{v.reference ?? "—"}</span></div>
        {v.description && <p className="text-muted-foreground">{v.description}</p>}
        {v.void_reason && <div className="flex justify-between"><span className="text-muted-foreground">Void reason</span><span>{v.void_reason}</span></div>}
      </CardContent></Card>
      {(await isFeatureEnabled(ctx.companyId, "attachments")) && (
        <div className="mt-4"><AttachmentsPanel ownerType="cash_transfer" ownerId={id} categories={["deposit_slip", "other"]} /></div>
      )}
    </div>
  );
}
