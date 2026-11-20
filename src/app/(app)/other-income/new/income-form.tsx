"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { saveOtherIncomeDraft, postOtherIncome, type OtherIncomeDraftInput } from "@/lib/other-income/actions";
import { round2 } from "@/lib/sales/calc";
import { formatMoney, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface RefOpt { id: string; code?: string; name: string }
export interface TaxOpt { id: string; name: string; rate: number; is_inclusive: boolean }
export interface AccountOpt { id: string; name: string; code?: string }
const NONE = "__none__";

/** A saved draft loaded into the form (Edit draft). */
export interface IncomeInitial {
  incomeId: string; typeId: string; receivedFrom: string; documentDate: string; taxCodeId: string | null;
  amount: number; reference: string; description: string; receipts: { payment_account_id: string; amount: number }[];
}

export function IncomeForm({ branchId, types, taxCodes, accounts, initial }: { branchId: string; types: RefOpt[]; taxCodes: TaxOpt[]; accounts: AccountOpt[]; initial?: IncomeInitial }) {
  const router = useRouter();
  const editing = !!initial;
  const [typeId, setTypeId] = React.useState(initial?.typeId ?? "");
  const [receivedFrom, setReceivedFrom] = React.useState(initial?.receivedFrom ?? "");
  const [date, setDate] = React.useState(initial?.documentDate ?? todayISO());
  const [taxCodeId, setTaxCodeId] = React.useState(initial?.taxCodeId ?? NONE);
  const [amount, setAmount] = React.useState(initial ? String(initial.amount) : "");
  const [reference, setReference] = React.useState(initial?.reference ?? "");
  const [description, setDescription] = React.useState(initial?.description ?? "");
  // Split tender, as on Create Sale: an amount per payment method of the branch.
  const [paid, setPaid] = React.useState<Record<string, string>>(() => {
    const p: Record<string, string> = {};
    for (const r of initial?.receipts ?? []) p[r.payment_account_id] = String(round2(Number(p[r.payment_account_id] || 0) + r.amount));
    return p;
  });
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const tc = taxCodeId !== NONE ? taxCodes.find((t) => t.id === taxCodeId) : null;
  const amt = Number(amount || 0);
  let net = amt, tax = 0, grand = amt;
  if (tc && tc.rate > 0) {
    if (tc.is_inclusive) { grand = round2(amt); net = round2(grand / (1 + tc.rate / 100)); tax = round2(grand - net); }
    else { net = round2(amt); tax = round2(net * tc.rate / 100); grand = round2(net + tax); }
  }
  const received = round2(accounts.reduce((s, a) => s + Number(paid[a.id] || 0), 0));
  const balance = round2(grand - received);
  // Other income is fully received when posted: Post stays faint until it balances.
  const blockers: string[] = [];
  if (!typeId) blockers.push("Select an income type.");
  if (!(amt > 0)) blockers.push("Enter the amount.");
  if (amt > 0 && balance > 0.001) blockers.push("Income must be fully received. Allocate the amount across payment methods to balance.");
  if (balance < -0.001) blockers.push(`Received ${formatMoney(-balance)} more than the total.`);
  const canPost = blockers.length === 0;
  function fillRest(accountId: string) {
    const others = round2(accounts.filter((a) => a.id !== accountId).reduce((s, a) => s + Number(paid[a.id] || 0), 0));
    const rest = round2(grand - others);
    setPaid((p) => ({ ...p, [accountId]: rest > 0 ? String(rest) : "" }));
  }

  async function submit(post: boolean) {
    setError(null);
    if (!typeId) { setError("Select an income type."); return; }
    if (!(amt > 0)) { setError("Enter an amount."); return; }
    if (post && !canPost) { setError(blockers[0]); return; }
    const input: OtherIncomeDraftInput = {
      incomeId: initial?.incomeId,
      branchId, incomeTypeId: typeId, receivedFrom, description, documentDate: date,
      taxCodeId: taxCodeId === NONE ? null : taxCodeId, amount: amt, reference,
      receipts: accounts.filter((a) => Number(paid[a.id] || 0) > 0).map((a) => ({ payment_account_id: a.id, amount: Number(paid[a.id]) })),
    };
    setPending(true);
    const res = await saveOtherIncomeDraft(input);
    if (!res.ok || !res.id) { setError(res.error ?? "Failed."); setPending(false); return; }
    if (post) { const pr = await postOtherIncome(res.id); if (!pr.ok) { setError(pr.error ?? "Draft saved but posting failed."); setPending(false); return; } toast.success("Other income posted."); }
    else toast.success("Draft saved.");
    router.push(`/other-income/${res.id}`);
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-4">
        <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <div className="space-y-1.5"><Label>Income type *</Label>
            <Select value={typeId} onValueChange={setTypeId}><SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
              <SelectContent>{types.map((t) => <SelectItem key={t.id} value={t.id}>{t.code} — {t.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label>Received from</Label><Input value={receivedFrom} onChange={(e) => setReceivedFrom(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Reference</Label><Input value={reference} onChange={(e) => setReference(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Amount *</Label><Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Tax</Label>
            <Select value={taxCodeId} onValueChange={setTaxCodeId}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value={NONE}>No tax</SelectItem>{taxCodes.map((t) => <SelectItem key={t.id} value={t.id}>{t.name} ({t.rate}%)</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Description</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        </CardContent></Card>

        <Card><CardContent className="space-y-3 p-5">
          <h3 className="font-semibold">Payments (Split Tender)</h3>
          {accounts.length === 0 ? <p className="text-sm text-muted-foreground">No payment methods are assigned to this branch (Admin → Payment Methods &amp; Banks).</p> : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {accounts.map((a) => (
                <div key={a.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5">
                  <button type="button" onClick={() => fillRest(a.id)} className="w-20 shrink-0 text-left text-sm font-semibold hover:text-primary" title="Put the remaining balance here">{a.code ?? a.name}</button>
                  <Input aria-label={`${a.name} amount`} className="h-8 text-right tabular-nums" type="number" min="0" step="0.01" placeholder="0.00"
                    value={paid[a.id] ?? ""} onChange={(e) => setPaid((p) => ({ ...p, [a.id]: e.target.value }))} />
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">Tip: click a method name to put the remaining balance on it.</p>
          {amt > 0 && blockers.length > 0 && (
            <ul className="space-y-1 rounded-md bg-warning/15 px-3 py-2 text-sm">{blockers.map((b) => <li key={b}>⚠ {b}</li>)}</ul>
          )}
        </CardContent></Card>
      </div>

      <div><Card className="sticky top-20"><CardContent className="space-y-2 p-5 text-sm">
        <Row label="Net" value={formatMoney(net)} /><Row label="Tax" value={formatMoney(tax)} />
        <div className="my-1 border-t border-border" /><Row label="Total" value={formatMoney(grand)} bold /><Row label="Received" value={formatMoney(received)} />
        <div className={`flex items-center justify-between font-semibold ${Math.abs(balance) <= 0.001 ? "" : "text-destructive"}`}><span>Balance</span><span className="tabular-nums">{formatMoney(balance)}</span></div>
        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <div className="flex flex-col gap-2 pt-2">
          <Button onClick={() => submit(true)} disabled={pending || !canPost} className="disabled:opacity-40" title={canPost ? undefined : blockers[0]}>{pending ? "Working..." : "Post (Save)"}</Button>
          <Button variant="outline" onClick={() => submit(false)} disabled={pending}>{editing ? "Save changes" : "Save draft"}</Button>
          {editing && <Button variant="ghost" onClick={() => router.push(`/other-income/${initial!.incomeId}`)} disabled={pending}>Cancel edit</Button>}
        </div>
      </CardContent></Card></div>
    </div>
  );
}
function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return <div className="flex items-center justify-between"><span className={bold ? "font-medium" : "text-muted-foreground"}>{label}</span><span className={`tabular-nums ${bold ? "font-semibold" : ""}`}>{value}</span></div>;
}
