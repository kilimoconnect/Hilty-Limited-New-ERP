"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, Paperclip, X } from "lucide-react";
import { saveExpenseDraft, postExpense, type ExpenseDraftInput } from "@/lib/expenses/actions";
import { uploadAttachmentAction } from "@/lib/attachments/actions";
import { round2 } from "@/lib/sales/calc";
import { formatMoney, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface RefOpt { id: string; code?: string; name: string; description?: string | null }
export interface TaxOpt { id: string; name: string; rate: number; is_inclusive: boolean }
export interface AccountOpt { id: string; name: string }
const NONE = "__none__";

/**
 * Record Expense as a petty-cash voucher: date, payment method, category,
 * payee, amount, description and an optional receipt. Supplier, VAT and
 * paying later (on credit) sit under "More options".
 */
export interface ExpenseInitial {
  expenseId: string; documentDate: string; accountId: string; categoryId: string; amount: number; description: string;
  supplierId: string | null; taxCodeId: string | null; reference: string; onCredit: boolean; dueDate: string;
}

export function ExpenseForm({ branchId, categories, suppliers, taxCodes, accounts, receiptsOn, initial }: {
  branchId: string; categories: RefOpt[]; suppliers: RefOpt[]; taxCodes: TaxOpt[]; accounts: AccountOpt[];
  /** Attachments are switched on and the user may upload. */
  receiptsOn: boolean;
  /** A saved draft loaded into the form (Edit draft). */
  initial?: ExpenseInitial;
}) {
  const router = useRouter();
  const editing = !!initial;
  const [date, setDate] = React.useState(initial?.documentDate ?? todayISO());
  const [accountId, setAccountId] = React.useState(initial?.accountId ?? "");
  const [categoryId, setCategoryId] = React.useState(initial?.categoryId ?? "");
  const [payee, setPayee] = React.useState("");
  const [amount, setAmount] = React.useState(initial ? String(initial.amount) : "");
  const [description, setDescription] = React.useState(initial?.description ?? "");
  const [file, setFile] = React.useState<File | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  // More options
  const [more, setMore] = React.useState(!!initial && (!!initial.supplierId || !!initial.taxCodeId || !!initial.reference || initial.onCredit));
  const [supplierId, setSupplierId] = React.useState(initial?.supplierId ?? NONE);
  const [taxCodeId, setTaxCodeId] = React.useState(initial?.taxCodeId ?? NONE);
  const [reference, setReference] = React.useState(initial?.reference ?? "");
  const [onCredit, setOnCredit] = React.useState(initial?.onCredit ?? false);
  const [dueDate, setDueDate] = React.useState(initial?.dueDate ?? "");
  const [pending, setPending] = React.useState(false);
  const [errors, setErrors] = React.useState<string[]>([]);

  const tc = taxCodeId !== NONE ? taxCodes.find((t) => t.id === taxCodeId) : null;
  const amt = Number(amount || 0);
  let net = amt, tax = 0, grand = amt;
  if (tc && tc.rate > 0) {
    if (tc.is_inclusive) { grand = round2(amt); net = round2(grand / (1 + tc.rate / 100)); tax = round2(grand - net); }
    else { net = round2(amt); tax = round2(net * tc.rate / 100); grand = round2(net + tax); }
  }

  async function submit(post: boolean) {
    const missing: string[] = [];
    if (!onCredit && !accountId) missing.push("Payment method required.");
    if (!categoryId) missing.push("Expense category required.");
    if (!(amt > 0)) missing.push("Amount required.");
    if (onCredit && supplierId === NONE) missing.push("A supplier is required when the expense is not paid yet.");
    if (onCredit && post && !dueDate) missing.push("A due date is required when the expense is not paid yet.");
    setErrors(missing);
    if (missing.length) return;

    const input: ExpenseDraftInput = {
      expenseId: initial?.expenseId,
      branchId, categoryId, supplierId: supplierId === NONE ? null : supplierId, documentDate: date, reference,
      description: [payee.trim(), description.trim()].filter(Boolean).join(" - "),
      taxCodeId: taxCodeId === NONE ? null : taxCodeId, amount: amt, dueDate: onCredit ? dueDate || null : null,
      payments: onCredit ? [] : [{ payment_account_id: accountId, amount: grand }],
    };
    setPending(true);
    const res = await saveExpenseDraft(input);
    if (!res.ok || !res.id) { setErrors([res.error ?? "Failed."]); setPending(false); return; }
    if (file) {
      const fd = new FormData();
      fd.set("ownerType", "expense"); fd.set("ownerId", res.id); fd.set("category", "receipt"); fd.set("file", file);
      const up = await uploadAttachmentAction(fd);
      if (!up.ok) toast.error(`Receipt not attached: ${up.error ?? "upload failed"}. You can attach it on the expense page.`);
    }
    if (post) {
      const pr = await postExpense(res.id);
      if (!pr.ok) { toast.error(pr.error ?? "Saved as a draft; posting failed."); router.push(`/expenses/${res.id}`); return; }
      toast.success("Expense posted.");
    } else toast.success("Draft saved.");
    router.push(`/expenses/${res.id}`);
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="exp-date">Date</Label>
            <Input id="exp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Payment method {!onCredit && <span className="text-destructive">*</span>}</Label>
            <Select value={accountId} onValueChange={setAccountId} disabled={onCredit}>
              <SelectTrigger><SelectValue placeholder={onCredit ? "Not paid yet" : "Select…"} /></SelectTrigger>
              <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-1.5 sm:col-span-2"><Label>Expense category <span className="text-destructive">*</span></Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger><SelectValue placeholder="Select expense category…" /></SelectTrigger>
              <SelectContent>{categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.name}{c.description ? <span className="ml-2 text-xs text-muted-foreground">{c.description}</span> : null}</SelectItem>
              ))}</SelectContent></Select></div>
          <div className="space-y-1.5"><Label htmlFor="exp-payee">Payee</Label>
            <Input id="exp-payee" placeholder="Optional payee name" value={payee} onChange={(e) => setPayee(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="exp-amount">Amount <span className="text-destructive">*</span></Label>
            <Input id="exp-amount" type="number" min="0" step="0.01" className="text-right tabular-nums" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="exp-desc">Description</Label>
            <Textarea id="exp-desc" placeholder="What was this expense for?" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          {receiptsOn && (
            <div className="space-y-1.5 sm:col-span-2"><Label>Receipt (optional)</Label>
              <input ref={fileRef} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Paperclip className="h-4 w-4" /> Choose receipt</Button>
                <span className="truncate text-sm text-muted-foreground">{file ? file.name : "No file chosen"}</span>
                {file && <button type="button" aria-label="Remove receipt" className="text-muted-foreground hover:text-destructive"
                  onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ""; }}><X className="h-4 w-4" /></button>}
              </div>
              <p className="text-[11px] text-muted-foreground">PDF or photo, up to 10 MB.</p>
            </div>
          )}
        </CardContent></Card>

        <Card><CardContent className="p-0">
          <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}
            className="flex w-full items-center justify-between px-5 py-3 text-left hover:bg-muted/40">
            <span className="text-sm font-medium">More options <span className="ml-1 text-xs font-normal text-muted-foreground">supplier, VAT, reference, pay later</span></span>
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${more ? "rotate-180" : ""}`} />
          </button>
          {more && (
            <div className="grid grid-cols-1 gap-4 px-5 pb-5 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>Supplier</Label>
                <Select value={supplierId} onValueChange={setSupplierId}><SelectTrigger><SelectValue placeholder="Optional" /></SelectTrigger>
                  <SelectContent><SelectItem value={NONE}>— None —</SelectItem>{suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1.5"><Label>VAT</Label>
                <Select value={taxCodeId} onValueChange={setTaxCodeId}><SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value={NONE}>No VAT</SelectItem>{taxCodes.map((t) => <SelectItem key={t.id} value={t.id}>{t.name} ({t.rate}%)</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-1.5"><Label htmlFor="exp-ref">Reference</Label><Input id="exp-ref" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" checked={onCredit} onChange={(e) => setOnCredit(e.target.checked)} /> Not paid yet (on credit)
              </label>
              {onCredit && <div className="space-y-1.5"><Label htmlFor="exp-due">Due date <span className="text-destructive">*</span></Label>
                <Input id="exp-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>}
            </div>
          )}
        </CardContent></Card>
      </div>

      <div><Card className="sticky top-20"><CardContent className="space-y-2 p-5 text-sm">
        {tax > 0 && <><Row label="Net" value={formatMoney(net)} /><Row label="VAT" value={formatMoney(tax)} /><div className="my-1 border-t border-border" /></>}
        <Row label="Total" value={formatMoney(grand)} bold />
        <Row label={onCredit ? "Paid now" : "Paid from"} value={onCredit ? formatMoney(0) : (accounts.find((a) => a.id === accountId)?.name ?? "—")} />
        {errors.length > 0 && (
          <ul className="space-y-1 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {errors.map((e) => <li key={e}>⚠ {e}</li>)}
          </ul>
        )}
        <div className="flex flex-col gap-2 pt-2">
          <Button onClick={() => submit(true)} disabled={pending}>{pending ? "Working..." : "Post expense"}</Button>
          <Button variant="outline" onClick={() => submit(false)} disabled={pending}>{editing ? "Save changes" : "Save draft"}</Button>
          {editing && <Button variant="ghost" onClick={() => router.push(`/expenses/${initial!.expenseId}`)} disabled={pending}>Cancel edit</Button>}
        </div>
      </CardContent></Card></div>
    </div>
  );
}
function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return <div className="flex items-center justify-between gap-2"><span className={bold ? "font-medium" : "text-muted-foreground"}>{label}</span><span className={`truncate tabular-nums ${bold ? "font-semibold" : ""}`}>{value}</span></div>;
}
