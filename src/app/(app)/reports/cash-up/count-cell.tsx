"use client";

import * as React from "react";
import { toast } from "sonner";
import { recordCashCount } from "@/lib/cash/count-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Inline end-of-day count for one till and day. */
export function CountCell({ accountId, date, counted, notes }: { accountId: string; date: string; counted: number | null; notes: string | null }) {
  const [editing, setEditing] = React.useState(false);
  const [amount, setAmount] = React.useState(counted === null ? "" : String(counted));
  const [note, setNote] = React.useState(notes ?? "");
  const [pending, startTransition] = React.useTransition();

  if (!editing) {
    return (
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs print-hide" onClick={() => setEditing(true)}>
        {counted === null ? "Count" : "Recount"}
      </Button>
    );
  }
  function save() {
    const value = Number(amount);
    if (amount.trim() === "" || !Number.isFinite(value)) { toast.error("Enter the amount counted."); return; }
    startTransition(async () => {
      const res = await recordCashCount({ accountId, date, counted: value, notes: note });
      if (!res.ok) { toast.error(res.error ?? "Could not save."); return; }
      const d = res.difference ?? 0;
      toast.success(d === 0 ? "Count saved: balanced." : `Count saved: ${d > 0 ? "over" : "short"} by ${Math.abs(d).toLocaleString("en-US")}.`);
      setEditing(false);
    });
  }
  return (
    <div className="flex min-w-[220px] flex-col gap-1 print-hide">
      <Input type="number" min={0} step="1" autoFocus placeholder="Counted" value={amount} className="h-7 text-right"
        onChange={(e) => setAmount(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} />
      <Input placeholder="Note (optional)" value={note} className="h-7" onChange={(e) => setNote(e.target.value)} />
      <div className="flex gap-1">
        <Button size="sm" className="h-7 px-2 text-xs" onClick={save} disabled={pending}>{pending ? "Saving..." : "Save"}</Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing(false)} disabled={pending}>Cancel</Button>
      </div>
    </div>
  );
}
