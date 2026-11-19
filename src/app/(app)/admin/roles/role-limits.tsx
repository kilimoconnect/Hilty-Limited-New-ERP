"use client";

import * as React from "react";
import { toast } from "sonner";
import { setRoleLimits } from "@/lib/admin/roles-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface RoleLimitValues {
  backdate_days: number | null;
  max_discount_pct: number | null;
  petty_cash_cap: number | null;
}

const toText = (v: number | null) => (v === null || v === undefined ? "" : String(v));
const toNum = (v: string) => (v.trim() === "" ? null : Number(v));

/** Role limits; an empty field means no limit. Keyed by role, so it resets when another role is chosen. */
export function RoleLimits({ roleId, values }: { roleId: string; values: RoleLimitValues }) {
  const [days, setDays] = React.useState(toText(values.backdate_days));
  const [disc, setDisc] = React.useState(toText(values.max_discount_pct));
  const [cap, setCap] = React.useState(toText(values.petty_cash_cap));
  const [pending, startTransition] = React.useTransition();

  function save() {
    startTransition(async () => {
      const res = await setRoleLimits(roleId, { backdateDays: toNum(days), maxDiscountPct: toNum(disc), pettyCashCap: toNum(cap) });
      if (res.ok) toast.success("Limits saved."); else toast.error(res.error ?? "Could not save.");
    });
  }

  return (
    <div className="mb-5 rounded-md border border-border p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Limits</h3>
          <p className="text-xs text-muted-foreground">Leave a field empty for no limit. Checked when a document is posted.</p>
        </div>
        <Button size="sm" variant="outline" onClick={save} disabled={pending}>{pending ? "Saving..." : "Save limits"}</Button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="lim-days">Back-dating (days)</Label>
          <Input id="lim-days" type="number" min={0} step={1} placeholder="No limit" value={days} onChange={(e) => setDays(e.target.value)} />
          <p className="text-[11px] text-muted-foreground">0 = today only. Future dates are refused when set.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="lim-disc">Max discount (%)</Label>
          <Input id="lim-disc" type="number" min={0} max={100} step="0.1" placeholder="No limit" value={disc} onChange={(e) => setDisc(e.target.value)} />
          <p className="text-[11px] text-muted-foreground">Below the item&apos;s price, per sale line.</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="lim-cap">Petty-cash cap (TZS)</Label>
          <Input id="lim-cap" type="number" min={0} step="1" placeholder="No limit" value={cap} onChange={(e) => setCap(e.target.value)} />
          <p className="text-[11px] text-muted-foreground">Largest expense paid from a cash till.</p>
        </div>
      </div>
    </div>
  );
}
