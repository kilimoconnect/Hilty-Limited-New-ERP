"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { postPurchaseAdjustment } from "@/lib/costs/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { todayISO } from "@/lib/format";

const rid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}-adj`);
const today = () => todayISO();
function useRun() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) => {
    setPending(true);
    const res = await fn();
    setPending(false);
    if (res.ok) { toast.success(msg); router.refresh(); return true; }
    toast.error(res.error ?? "Failed."); return false;
  };
  return { pending, run };
}

export function PriceAdjustmentForm({ purchaseId, lines }: { purchaseId: string; lines: { id: string; label: string }[] }) {
  const { pending, run } = useRun();
  const [kind, setKind] = React.useState<"credit_note" | "debit_note">("credit_note");
  const [date, setDate] = React.useState(today());
  const [reference, setReference] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const [requestId, setRequestId] = React.useState(rid);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1"><Label className="text-xs">Supplier document</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as never)}><SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="credit_note">Credit note (price lower)</SelectItem><SelectItem value="debit_note">Debit note (price higher)</SelectItem></SelectContent></Select></div>
        <div className="space-y-1"><Label className="text-xs">Date</Label><Input className="h-8 w-36" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1"><Label className="text-xs">Supplier reference</Label><Input className="h-8 w-36" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        <div className="space-y-1"><Label className="text-xs">Reason *</Label><Input className="h-8 w-64" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      {lines.map((l) => (
        <div key={l.id} className="flex items-center gap-2 text-sm">
          <span className="w-72 truncate">{l.label}</span>
          <Input className="h-8 w-36 text-right" type="number" min="0" step="0.01" placeholder="TZS" value={amounts[l.id] ?? ""} onChange={(e) => setAmounts({ ...amounts, [l.id]: e.target.value })} />
        </div>
      ))}
      <Button size="sm" disabled={pending} onClick={async () => {
        const ok = await run(() => postPurchaseAdjustment({ purchaseId, kind, date, reference, reason, requestId,
          lines: lines.map((l) => ({ purchase_line_id: l.id, amount: Number(amounts[l.id] || 0) })) }), kind === "credit_note" ? "Credit note posted." : "Debit note posted.");
        if (ok) { setAmounts({}); setReason(""); setReference(""); setRequestId(rid()); }
      }}>Post {kind === "credit_note" ? "credit" : "debit"} note</Button>
      <p className="text-xs text-muted-foreground">The supplier balance changes once; the cost difference follows the goods (stock still held, cost of sales for units sold, other branches and stock in transit). A credit beyond the open balance becomes a supplier credit that can be used or refunded.</p>
    </div>
  );
}
