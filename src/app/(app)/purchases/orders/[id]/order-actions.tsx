"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2, PackageCheck, Pencil, Printer, RotateCcw, Trash2, XCircle } from "lucide-react";
import { confirmOrder, deleteOrder, reopenOrder, closeOrder } from "@/lib/purchases/order-actions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function OrderActions({ id, status, canOrder, canReceive, hasReceipts }: {
  id: string; status: string; canOrder: boolean; canReceive: boolean; hasReceipts: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const [dlg, setDlg] = React.useState<null | "delete" | "close">(null);

  async function run(fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, done: string) {
    setBusy(true);
    const r = await fn();
    setBusy(false);
    if (!r.ok) { toast.error(r.error ?? "Failed."); return; }
    toast.success(r.message ?? done);
    router.refresh();
  }

  const pending = status === "confirmed" || status === "partially_received";
  return (
    <div className="flex flex-wrap gap-2">
      {status !== "draft" && (
        <Button asChild variant="outline" size="sm"><a href={`/purchase-order/${id}`} target="_blank" rel="noreferrer"><Printer className="h-4 w-4" /> Print / PDF</a></Button>
      )}
      {canOrder && status === "draft" && <>
        <Button asChild variant="outline" size="sm"><Link href={`/purchases/orders/${id}?edit=1`}><Pencil className="h-4 w-4" /> Edit</Link></Button>
        <Button size="sm" disabled={busy} onClick={() => run(() => confirmOrder(id), "Order confirmed.")}><CheckCircle2 className="h-4 w-4" /> Confirm order</Button>
      </>}
      {pending && canReceive && (
        <Button asChild size="sm"><Link href={`/purchases/new?order=${id}`}><PackageCheck className="h-4 w-4" /> Receive goods</Link></Button>
      )}
      {canOrder && status === "confirmed" && !hasReceipts && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => run(() => reopenOrder(id), "Back to draft — edit and confirm again.")}><RotateCcw className="h-4 w-4" /> Change order</Button>
      )}
      {canOrder && status === "partially_received" && (
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setDlg("close")}><XCircle className="h-4 w-4" /> Close (stop waiting)</Button>
      )}
      {canOrder && ["draft", "confirmed"].includes(status) && !hasReceipts && (
        <Button variant="outline" size="sm" className="text-destructive" disabled={busy} onClick={() => setDlg("delete")}><Trash2 className="h-4 w-4" /> Delete</Button>
      )}

      <ConfirmDialog open={dlg === "delete"} onOpenChange={(o) => !o && setDlg(null)} destructive
        title="Delete this purchase order?" description="The order is removed. Purchases already saved as drafts from it stay, without the link." confirmLabel="Delete"
        onConfirm={async () => { const r = await deleteOrder(id); if (!r.ok) return r.error ?? "Failed."; toast.success("Order deleted."); router.push("/purchases/orders"); }} />
      <ConfirmDialog open={dlg === "close"} onOpenChange={(o) => !o && setDlg(null)} requireReason
        title="Close this order?" description="What was received stays; the remaining quantities are no longer expected." confirmLabel="Close order"
        onConfirm={async (reason) => { const r = await closeOrder(id, reason); if (!r.ok) return r.error ?? "Failed."; toast.success("Order closed."); router.refresh(); }} />
    </div>
  );
}
