"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil, Plus } from "lucide-react";
import { createOpeningDraft, postOpening } from "@/lib/inventory/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { StockLineEditor, newLine, type ProductOption, type StockLine } from "@/components/inventory/stock-line-editor";
import { todayISO } from "@/lib/format";

/** A saved opening-balance draft, opened with "Edit draft". */
export interface OpeningDraft {
  id: string; branchId: string; date: string; reference: string; description: string;
  lines: { product_id: string; quantity: number; unit_cost: number }[];
}

export function NewOpeningButton({ products, branchId, draft }: { products: ProductOption[]; branchId: string; draft?: OpeningDraft }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [date, setDate] = React.useState(todayISO());
  const [reference, setReference] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [lines, setLines] = React.useState<StockLine[]>([newLine()]);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function reset() {
    if (draft) {
      setDate(draft.date); setReference(draft.reference); setDescription(draft.description);
      setLines(draft.lines.length ? draft.lines.map((l) => ({ ...newLine(), product_id: l.product_id, quantity: String(l.quantity), unit_cost: String(l.unit_cost) })) : [newLine()]);
      setError(null); setPending(false);
      return;
    }
    setDate(todayISO()); setReference(""); setDescription("");
    setLines([newLine()]); setError(null); setPending(false);
  }

  async function submit(post: boolean) {
    setError(null);
    const parsed = lines
      .filter((l) => l.product_id && l.quantity)
      .map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit_cost: Number(l.unit_cost || 0) }));
    if (parsed.length === 0) { setError("Add at least one product line."); return; }
    setPending(true);
    const res = await createOpeningDraft({ openingId: draft?.id, branchId: draft?.branchId ?? branchId, openingDate: date, reference, description, lines: parsed });
    if (!res.ok || !res.id) { setError(res.error ?? "Failed."); setPending(false); return; }
    if (post) {
      const p = await postOpening(res.id);
      if (!p.ok) { setError(p.error ?? "Posted draft saved but posting failed."); setPending(false); router.refresh(); return; }
      toast.success("Opening balance posted.");
    } else {
      toast.success(draft ? "Draft updated." : "Opening balance draft saved.");
    }
    setOpen(false); reset(); router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) reset(); }}>
      <DialogTrigger asChild>{draft
        ? <Button variant="outline" size="sm" className="h-8"><Pencil className="h-3.5 w-3.5" /> Edit draft</Button>
        : <Button><Plus className="h-4 w-4" /> New Opening</Button>}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{draft ? "Edit opening balance draft" : "Inventory opening balance"}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5"><Label>Opening date</Label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="space-y-1.5"><Label>Reference</Label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
          </div>
          <div className="space-y-1.5"><Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <StockLineEditor products={products} lines={lines} setLines={setLines} showCost />
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => submit(false)} disabled={pending}>{draft ? "Save changes" : "Save draft"}</Button>
            <Button onClick={() => submit(true)} disabled={pending}>{pending ? "Working..." : "Save & Post"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
