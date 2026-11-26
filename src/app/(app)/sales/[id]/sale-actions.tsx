"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send, Ban, Trash2, Printer, RotateCcw, HandCoins, Pencil, FilePen } from "lucide-react";
import { postSale, voidSale, deleteSaleDraft, createSaleCorrection } from "@/lib/sales/actions";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function SaleActions({
  id, status, outstanding, customerId, canPost, canEdit = false, canVoid, canDelete, canReceive, canReturn, canEditPosted = false, isCorrection = false,
}: {
  id: string; status: string; outstanding: number; customerId: string;
  canPost: boolean; canEdit?: boolean; canVoid: boolean; canDelete: boolean; canReceive: boolean; canReturn: boolean;
  /** Owner: may open a correction of this posted sale. */
  canEditPosted?: boolean;
  /** This draft corrects a posted sale: posting replaces it. */
  isCorrection?: boolean;
}) {
  const router = useRouter();
  const [confirm, setConfirm] = React.useState<null | "delete" | "void">(null);
  const [pending, setPending] = React.useState(false);

  async function doPost() {
    setPending(true);
    const res = await postSale(id);
    setPending(false);
    if (res.ok) { toast.success(isCorrection ? "Corrected sale posted; it replaces the original and keeps its number." : "Sale posted."); router.refresh(); } else toast.error(res.error ?? "Failed.");
  }
  async function editPosted() {
    setPending(true);
    const res = await createSaleCorrection(id);
    if (!res.ok || !res.id) { setPending(false); toast.error(res.error ?? "Failed."); return; }
    router.push(`/sales/${res.id}/edit`);
  }
  async function onConfirm(reason: string) {
    const res = confirm === "delete" ? await deleteSaleDraft(id, reason) : await voidSale(id, reason);
    if (!res.ok) return res.error ?? "Failed.";
    toast.success(confirm === "delete" ? "Draft deleted." : "Sale voided.");
    if (confirm === "delete") router.push("/sales/history"); else router.refresh();
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "draft" && canPost && <Button onClick={doPost} disabled={pending}><Send className="h-4 w-4" /> {isCorrection ? "Post correction" : "Post"}</Button>}
      {status === "draft" && canEdit && (
        <Button asChild variant="outline"><Link href={`/sales/${id}/edit`}><Pencil className="h-4 w-4" /> Edit draft</Link></Button>
      )}
      {status === "draft" && canDelete && (
        <Button variant="outline" onClick={() => setConfirm("delete")}><Trash2 className="h-4 w-4" /> Delete draft</Button>
      )}
      {status === "posted" && (
        <Button asChild variant="outline"><Link href={`/print/sale/${id}`} target="_blank"><Printer className="h-4 w-4" /> Print</Link></Button>
      )}
      {status === "posted" && outstanding > 0 && canReceive && (
        <Button asChild variant="outline"><Link href={`/sales/customer-payments/new?customer=${customerId}&sale=${id}`}><HandCoins className="h-4 w-4" /> Receive payment</Link></Button>
      )}
      {status === "posted" && canReturn && (
        <Button asChild variant="outline"><Link href={`/sales/${id}/return`}><RotateCcw className="h-4 w-4" /> Return</Link></Button>
      )}
      {status === "posted" && canEditPosted && (
        <Button variant="outline" onClick={editPosted} disabled={pending} title="Owner only: correct this sale; it keeps its number">
          <FilePen className="h-4 w-4" /> {pending ? "Opening..." : "Edit posted sale"}
        </Button>
      )}
      {status === "posted" && canVoid && (
        <Button variant="outline" onClick={() => setConfirm("void")}><Ban className="h-4 w-4" /> Void</Button>
      )}

      <ConfirmDialog
        open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === "delete" ? "Delete this draft?" : "Void this sale?"}
        description={confirm === "delete"
          ? "The draft is permanently removed and recorded in the audit log."
          : "Reversing stock and accounting entries are created. The original invoice stays visible."}
        confirmLabel={confirm === "delete" ? "Delete" : "Void"} destructive requireReason onConfirm={onConfirm}
      />
    </div>
  );
}
