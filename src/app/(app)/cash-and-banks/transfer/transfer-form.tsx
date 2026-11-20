"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Paperclip, X } from "lucide-react";
import { saveTransferDraft, postTransfer } from "@/lib/cash/actions";
import { uploadAttachmentAction } from "@/lib/attachments/actions";
import { round2 } from "@/lib/sales/calc";
import { formatMoney, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** A payment method of the branch; balance = what it holds at this branch (bank: the branch's share). */
export interface AccountOpt { id: string; name: string; code?: string; balance?: number; available?: number }

/** Cash transfer between tills and banks: date, from, to, amount, reference, optional slip and note; a fee under "More options". */
/** A saved draft loaded into the form (Edit draft). */
export interface TransferInitial {
  transferId: string; date: string; source: string; dest: string; amount: number; fee: number; reference: string; note: string;
}

export function TransferForm({ accounts, branchId, slipsOn, initial }: { accounts: AccountOpt[]; branchId: string | null; slipsOn: boolean; initial?: TransferInitial }) {
  const router = useRouter();
  const editing = !!initial;
  const [date, setDate] = React.useState(initial?.date ?? todayISO());
  const [source, setSource] = React.useState(initial?.source ?? "");
  const [dest, setDest] = React.useState(initial?.dest ?? "");
  const [amount, setAmount] = React.useState(initial ? String(initial.amount) : "");
  const [reference, setReference] = React.useState(initial?.reference ?? "");
  const [note, setNote] = React.useState(initial?.note ?? "");
  const [file, setFile] = React.useState<File | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [more, setMore] = React.useState(!!initial && initial.fee > 0);
  const [fee, setFee] = React.useState(initial && initial.fee > 0 ? String(initial.fee) : "");
  const [pending, setPending] = React.useState(false);
  const [errors, setErrors] = React.useState<string[]>([]);

  const amt = Number(amount || 0);
  const fe = Number(fee || 0);
  const from = accounts.find((a) => a.id === source);
  const to = accounts.find((a) => a.id === dest);
  const short = from?.available !== undefined && amt + fe > from.available + 0.001;

  async function submit(post: boolean) {
    const missing: string[] = [];
    if (!source) missing.push("From account required.");
    if (!dest) missing.push("To account required.");
    if (source && dest && source === dest) missing.push("From and To must be different accounts.");
    if (!(amt > 0)) missing.push("Amount required.");
    if (fe < 0) missing.push("The fee cannot be negative.");
    setErrors(missing);
    if (missing.length) return;

    setPending(true);
    const res = await saveTransferDraft({ transferId: initial?.transferId, sourceAccountId: source, destinationAccountId: dest, transferDate: date, amount: amt, fee: fe, sourceBranchId: branchId, reference, description: note });
    if (!res.ok || !res.id) { setErrors([res.error ?? "Failed."]); setPending(false); return; }
    if (file) {
      const fd = new FormData();
      fd.set("ownerType", "cash_transfer"); fd.set("ownerId", res.id); fd.set("category", "deposit_slip"); fd.set("file", file);
      const up = await uploadAttachmentAction(fd);
      if (!up.ok) toast.error(`Attachment not saved: ${up.error ?? "upload failed"}. You can attach it on the transfer page.`);
    }
    if (post) {
      const pr = await postTransfer(res.id);
      if (!pr.ok) { toast.error(pr.error ?? "Saved as a draft; posting failed."); router.push(`/cash-and-banks/transfers/${res.id}`); return; }
      toast.success("Transfer posted.");
    } else toast.success("Draft saved.");
    router.push(`/cash-and-banks/transfers/${res.id}`);
  }

  return (
    <div className="max-w-2xl space-y-4">
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
        <div className="space-y-1.5 sm:col-span-2 sm:max-w-[50%] sm:pr-2"><Label htmlFor="ct-date">Date</Label>
          <Input id="ct-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>From <span className="text-destructive">*</span></Label>
          <Select value={source} onValueChange={setSource}><SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select>
            {from && from.balance !== undefined && (
              <p className="text-xs text-muted-foreground">Available: <span className={`font-medium tabular-nums ${from.balance < 0 ? "text-destructive" : "text-foreground"}`}>{formatMoney(from.balance)}</span>
                {from.available !== undefined && from.available !== from.balance && <> · with overdraft {formatMoney(from.available)}</>}</p>
            )}</div>
        <div className="space-y-1.5"><Label>To <span className="text-destructive">*</span></Label>
          <Select value={dest} onValueChange={setDest}><SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>{accounts.filter((a) => a.id !== source).map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select>
            {to && to.balance !== undefined && (
              <p className="text-xs text-muted-foreground">Balance: <span className={`font-medium tabular-nums ${to.balance < 0 ? "text-destructive" : "text-foreground"}`}>{formatMoney(to.balance)}</span>
                {to.available !== undefined && to.available !== to.balance && <> · with overdraft {formatMoney(to.available)}</>}</p>
            )}</div>
        <div className="space-y-1.5"><Label htmlFor="ct-amount">Amount <span className="text-destructive">*</span></Label>
          <Input id="ct-amount" type="number" min="0" step="0.01" className={`text-right tabular-nums ${short ? "border-destructive" : ""}`} value={amount} onChange={(e) => setAmount(e.target.value)} />
          {short && from && <p className="text-xs text-destructive">More than {from.name} has available at this branch ({formatMoney(from.available ?? 0)}).</p>}</div>
        <div className="space-y-1.5"><Label htmlFor="ct-ref">Reference</Label>
          <Input id="ct-ref" placeholder="Deposit slip / handover ref (optional)" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
        {slipsOn && (
          <div className="space-y-1.5 sm:col-span-2"><Label>Attachment (optional)</Label>
            <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" /> Choose file</Button>
              <span className="truncate text-sm text-muted-foreground">{file ? file.name : "No file chosen"}</span>
              {file && <button type="button" aria-label="Remove attachment" className="text-muted-foreground hover:text-destructive"
                onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }}><X className="h-4 w-4" /></button>}
            </div>
            <p className="text-[11px] text-muted-foreground">Deposit slip or photo; PDF or image, up to 10 MB.</p>
          </div>
        )}
        <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="ct-note">Note</Label>
          <Textarea id="ct-note" placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </CardContent></Card>

      <Card><CardContent className="p-0">
        <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}
          className="flex w-full items-center justify-between px-5 py-3 text-left hover:bg-muted/40">
          <span className="text-sm font-medium">More options <span className="ml-1 text-xs font-normal text-muted-foreground">bank or mobile-money fee</span></span>
          <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${more ? "rotate-180" : ""}`} />
        </button>
        {more && (
          <div className="space-y-3 px-5 pb-5 text-sm">
            <div className="max-w-xs space-y-1.5"><Label htmlFor="ct-fee">Transfer fee</Label>
              <Input id="ct-fee" type="number" min="0" step="0.01" placeholder="0" value={fee} onChange={(e) => setFee(e.target.value)} /></div>
            <div className="flex justify-between"><span className="text-muted-foreground">From account decreases by</span><span className="tabular-nums font-medium">{formatMoney(round2(amt + fe))}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">To account increases by</span><span className="tabular-nums">{formatMoney(amt)}</span></div>
          </div>
        )}
      </CardContent></Card>

      {errors.length > 0 && (
        <ul className="space-y-1 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{errors.map((e) => <li key={e}>⚠ {e}</li>)}</ul>
      )}
      <div className="flex justify-end gap-2">
        {editing && <Button variant="ghost" onClick={() => router.push(`/cash-and-banks/transfers/${initial!.transferId}`)} disabled={pending}>Cancel edit</Button>}
        <Button variant="outline" onClick={() => submit(false)} disabled={pending}>{editing ? "Save changes" : "Save draft"}</Button>
        <Button onClick={() => submit(true)} disabled={pending}>{pending ? "Working..." : "Post transfer"}</Button>
      </div>
    </div>
  );
}
