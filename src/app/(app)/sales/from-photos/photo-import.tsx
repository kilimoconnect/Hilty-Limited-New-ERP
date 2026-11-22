"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Camera, CheckCircle2, AlertTriangle, Loader2, X, ExternalLink } from "lucide-react";
import { createPhotoDrafts, type PhotoDraftResult } from "@/lib/photo-sales/actions";
import {
  linesTotal, receiptIssues, round2,
  type PhotoReadResult, type ReadNoteLine, type ReadReceipt,
} from "@/lib/photo-sales/types";
import { formatMoney, formatDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchSelect } from "@/components/common/search-select";

interface ProductOpt { id: string; sku: string; name: string; price: number }
interface AccountOpt { id: string; code: string; name: string }
interface CategoryOpt { id: string; name: string }
interface Photo { key: string; file: File; url: string; status: "waiting" | "reading" | "done" | "error"; error?: string }

const NONE = "__none__";
const key = () => Math.random().toString(36).slice(2);

/** Phone photos are large: scale to at most 2600 px (sharp enough for 4 receipts on one page) and send as JPEG. */
async function toDataUrl(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return canvas.toDataURL("image/jpeg", 0.9);
}

/**
 * Upload photos -> each is read on the server -> review: receipts whose items
 * add up to the written total (and whose products are all matched) become
 * sale drafts; the rest are listed for the user to enter by hand. Notebook
 * lines become the payments (shared out over the drafted receipts) and
 * expense drafts. Nothing is posted: the user checks each draft and posts it.
 */
export function PhotoImport({ branchId, products, accounts, categories, canExpense }: {
  branchId: string; products: ProductOpt[]; accounts: AccountOpt[]; categories: CategoryOpt[]; canExpense: boolean;
}) {
  const [photos, setPhotos] = React.useState<Photo[]>([]);
  const [reading, setReading] = React.useState(false);
  const [receipts, setReceipts] = React.useState<ReadReceipt[]>([]);
  const [notebook, setNotebook] = React.useState<ReadNoteLine[]>([]);
  const [skip, setSkip] = React.useState<Record<string, boolean>>({});
  const [saving, setSaving] = React.useState(false);
  const [result, setResult] = React.useState<PhotoDraftResult | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const prodMap = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const accName = (id: string | null) => accounts.find((a) => a.id === id)?.code || accounts.find((a) => a.id === id)?.name || "—";
  const productOptions = React.useMemo(() => products.map((p) => ({ id: p.id, label: p.name, hint: p.sku, search: p.sku })), [products]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    const next = Array.from(list).filter((f) => f.type.startsWith("image/"))
      .map((file) => ({ key: key(), file, url: URL.createObjectURL(file), status: "waiting" as const }));
    setPhotos((p) => [...p, ...next]);
  }
  function removePhoto(k: string) {
    setPhotos((p) => p.filter((x) => { if (x.key === k) URL.revokeObjectURL(x.url); return x.key !== k; }));
  }

  async function readAll() {
    setReading(true); setResult(null);
    const allR: ReadReceipt[] = [...receipts];
    const allN: ReadNoteLine[] = [...notebook];
    // All photos are read at the same time: the wait is the slowest photo, not the sum.
    const results = await Promise.all(photos.map(async (ph, i): Promise<PhotoReadResult | null> => {
      if (ph.status === "done") return null;
      setPhotos((p) => p.map((x) => (x.key === ph.key ? { ...x, status: "reading", error: undefined } : x)));
      try {
        const image = await toDataUrl(ph.file);
        const res = await fetch("/api/photo-sales/read", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branchId, photo: i, image }),
        });
        const json = await res.json().catch(() => ({ error: res.status === 504 ? "The server stopped waiting. Try again." : "The server did not answer." }));
        if (!res.ok) throw new Error(json.error ?? "Could not read the photo.");
        setPhotos((p) => p.map((x) => (x.key === ph.key ? { ...x, status: "done" } : x)));
        return json as PhotoReadResult;
      } catch (e) {
        setPhotos((p) => p.map((x) => (x.key === ph.key ? { ...x, status: "error", error: e instanceof Error ? e.message : "Failed." } : x)));
        return null;
      }
    }));
    for (const data of results) {
      if (!data) continue;
      // The same receipt photographed twice: keep the first reading.
      for (const r of data.receipts) if (!allR.some((x) => x.number && x.number === r.number)) allR.push(r);
      allN.push(...data.notebook);
    }
    allR.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
    setReceipts(allR); setNotebook(allN); setReading(false);
  }

  const setLineProduct = (rk: string, idx: number, product_id: string) =>
    setReceipts((rs) => rs.map((r) => (r.key !== rk ? r : { ...r, lines: r.lines.map((l, i) => (i === idx ? { ...l, product_id: product_id || null, match: product_id ? "user" : null } : l)) })));
  const editReceipt = (rk: string, fn: (r: ReadReceipt) => ReadReceipt) => setReceipts((rs) => rs.map((r) => (r.key === rk ? fn(r) : r)));
  const setLine = (rk: string, idx: number, patch: Partial<ReadReceipt["lines"][number]>) =>
    editReceipt(rk, (r) => ({ ...r, lines: r.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)) }));
  const addLine = (rk: string) => editReceipt(rk, (r) => ({ ...r, lines: [...r.lines, { qty: 1, text: "", amount: 0, product_id: null, match: null }] }));
  const removeLine = (rk: string, idx: number) => editReceipt(rk, (r) => ({ ...r, lines: r.lines.filter((_, i) => i !== idx) }));
  const setTotal = (rk: string, v: string) => editReceipt(rk, (r) => ({ ...r, written_total: v === "" ? null : round2(Number(v) || 0) }));
  const cardEdit = { onLine: setLine, onAdd: addLine, onRemove: removeLine, onTotal: setTotal };
  const setReceiptDate = (rk: string, date: string) => setReceipts((rs) => rs.map((r) => (r.key === rk ? { ...r, date: date || null } : r)));
  const setNote = (nk: string, patch: Partial<ReadNoteLine>) => setNotebook((ns) => ns.map((n) => (n.key === nk ? { ...n, ...patch } : n)));

  // Ready = no issues (a receipt with only unmatched products is fixable here).
  const withIssues = receipts.map((r) => ({ r, issues: receiptIssues(r) }));
  const ready = withIssues.filter((x) => x.issues.length === 0 && !skip[x.r.key]).map((x) => x.r);
  // Everything that does not add up (or has an unmatched item) is corrected on the page.
  const fixable = withIssues.filter((x) => x.issues.length > 0 && !x.r.existing_sale_id);
  const already = withIssues.filter((x) => !!x.r.existing_sale_id);
  const manual = withIssues.filter((x) => x.issues.length > 0);
  const payLines = notebook.filter((n) => n.kind === "payment");
  const expLines = notebook.filter((n) => n.kind === "expense");

  // Share the day's payments over the drafted receipts, method by method in the notebook's order.
  const allocation = (() => {
    const pools = payLines.filter((p) => p.account_id).map((p) => ({ account_id: p.account_id!, left: p.amount }));
    const per: Record<string, { payment_account_id: string; amount: number }[]> = {};
    for (const r of ready) {
      let need = linesTotal(r);
      per[r.key] = [];
      for (const pool of pools) {
        if (need <= 0.001) break;
        const take = round2(Math.min(need, pool.left));
        if (take <= 0) continue;
        pool.left = round2(pool.left - take); need = round2(need - take);
        const same = per[r.key].find((x) => x.payment_account_id === pool.account_id);
        if (same) same.amount = round2(same.amount + take); else per[r.key].push({ payment_account_id: pool.account_id, amount: take });
      }
    }
    const leftover = new Map<string, number>();
    for (const p of pools) if (p.left > 0.001) leftover.set(p.account_id, round2((leftover.get(p.account_id) ?? 0) + p.left));
    return { per, leftover };
  })();

  const salesTotal = round2(receipts.reduce((s, r) => s + (r.written_total ?? linesTotal(r)), 0));
  const moneyTotal = round2(payLines.reduce((s, n) => s + n.amount, 0) + expLines.reduce((s, n) => s + n.amount, 0));
  const unpaidReady = ready.filter((r) => round2((allocation.per[r.key] ?? []).reduce((s, p) => s + p.amount, 0)) < linesTotal(r) - 0.001);
  const expReady = canExpense ? expLines.filter((e) => e.category_id && e.paid_from_account_id && (e.date || ready[0]?.date)) : [];
  const unmappedPay = payLines.filter((p) => !p.account_id);

  async function create() {
    setSaving(true);
    const res = await createPhotoDrafts({
      branchId,
      receipts: ready.map((r) => ({ ...r, payments: allocation.per[r.key] ?? [] })),
      expenses: expReady.map((e) => ({ key: e.key, date: (e.date ?? ready[0]?.date)!, label: e.label, amount: e.amount, category_id: e.category_id!, paid_from_account_id: e.paid_from_account_id! })),
    });
    setSaving(false);
    if (!res.ok) { toast.error(res.error ?? "Failed."); return; }
    setResult(res);
    const made = res.receipts.filter((r) => r.id).length + res.expenses.filter((e) => e.id).length;
    toast.success(`${made} draft${made === 1 ? "" : "s"} created. Check each one, then post it.`);
  }

  if (result) {
    return (
      <div className="space-y-4">
        <Card><CardContent className="space-y-3 p-5">
          <h3 className="font-semibold">Drafts created</h3>
          <p className="text-sm text-muted-foreground">Open each draft, check it against the receipt, then post it. Use Edit draft to correct anything.</p>
          <ul className="space-y-1.5 text-sm">
            {result.receipts.map((r) => (
              <li key={r.key} className="flex items-center gap-2">
                {r.id ? <CheckCircle2 className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-destructive" />}
                <span className="font-medium">Receipt {r.number}</span>
                {r.id ? <Link href={`/sales/${r.id}`} className="inline-flex items-center gap-1 text-primary underline">Open sale draft <ExternalLink className="h-3 w-3" /></Link> : <span className="text-destructive">{r.error}</span>}
              </li>
            ))}
            {result.expenses.map((e) => (
              <li key={e.key} className="flex items-center gap-2">
                {e.id ? <CheckCircle2 className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-destructive" />}
                <span className="font-medium">Expense: {e.label}</span>
                {e.id ? <Link href={`/expenses/${e.id}`} className="inline-flex items-center gap-1 text-primary underline">Open expense draft <ExternalLink className="h-3 w-3" /></Link> : <span className="text-destructive">{e.error}</span>}
              </li>
            ))}
          </ul>
          {manual.length > 0 && <ManualList manual={manual} branchId={branchId} leftover={allocation.leftover} accName={accName} />}
          <div className="flex gap-2 pt-2">
            <Button asChild variant="outline"><Link href="/sales/history?status=draft">Sales drafts</Link></Button>
            <Button onClick={() => { setResult(null); setReceipts([]); setNotebook([]); setPhotos([]); setSkip({}); }}>Start again</Button>
          </div>
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">1. Photos</h3>
          <div className="flex gap-2">
            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={reading}><Camera className="h-4 w-4" /> Add photos</Button>
            <Button onClick={readAll} disabled={reading || photos.length === 0 || photos.every((p) => p.status === "done")}>
              {reading ? <><Loader2 className="h-4 w-4 animate-spin" /> Reading…</> : "Read photos"}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">Add the receipt pages and the notebook page for the day. Take each photo straight on, in good light, with the whole page in view.</p>
        {photos.length > 0 && (
          <div className="flex flex-wrap gap-3">
            {photos.map((p, i) => (
              <div key={p.key} className="relative w-28">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.url} alt={`Photo ${i + 1}`} className="h-36 w-28 rounded-md border border-border object-cover" />
                <span className={`mt-1 block text-[11px] ${p.status === "error" ? "text-destructive" : "text-muted-foreground"}`}>
                  {p.status === "waiting" ? "Waiting" : p.status === "reading" ? "Reading… (up to 3 min)" : p.status === "done" ? "Read ✓" : p.error}
                </span>
                {!reading && p.status !== "reading" && (
                  <button type="button" aria-label="Remove photo" onClick={() => removePhoto(p.key)} className="absolute right-1 top-1 rounded-full bg-background/90 p-0.5 hover:text-destructive"><X className="h-3.5 w-3.5" /></button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent></Card>

      {(receipts.length > 0 || notebook.length > 0) && (
        <>
          <Card><CardContent className="grid grid-cols-2 gap-3 p-5 text-sm sm:grid-cols-4">
            <Stat label="Receipts read" value={String(receipts.length)} />
            <Stat label="Ready for drafts" value={String(ready.length)} good />
            <Stat label="To correct" value={String(fixable.length)} bad={fixable.length > 0} />
            <Stat label="Day check" value={notebook.length === 0 ? "No notebook" : Math.abs(salesTotal - moneyTotal) < 1 ? "Balances ✓" : `Off by ${formatMoney(round2(salesTotal - moneyTotal))}`}
              good={notebook.length > 0 && Math.abs(salesTotal - moneyTotal) < 1} bad={notebook.length > 0 && Math.abs(salesTotal - moneyTotal) >= 1} />
            <p className="col-span-2 text-xs text-muted-foreground sm:col-span-4">Receipts total {formatMoney(salesTotal)} · notebook money and expenses {formatMoney(moneyTotal)}.</p>
          </CardContent></Card>

          {fixable.length > 0 && (
            <Card><CardContent className="space-y-3 p-5">
              <h3 className="font-semibold">2. Correct these receipts</h3>
              <p className="text-xs text-muted-foreground">Look at the paper receipt and correct what is shown in red: the quantity, amount, product or total. Add a missed line with + Add line. When the items add up to the total and every item has a product, the receipt moves to Ready. Product choices are remembered for next time.</p>
              {fixable.map(({ r, issues }) => <ReceiptCard key={r.key} r={r} issues={issues} prodMap={prodMap} productOptions={productOptions} onProduct={setLineProduct} onDate={setReceiptDate} {...cardEdit} />)}
            </CardContent></Card>
          )}
          {already.length > 0 && (
            <p className="rounded-md bg-muted px-4 py-2 text-sm">Already entered, skipped: receipt {already.map(({ r }) => r.number).join(", ")}.</p>
          )}

          <Card><CardContent className="space-y-3 p-5">
            <h3 className="font-semibold">{fixable.length ? "3" : "2"}. Ready: check each receipt</h3>
            {withIssues.filter((x) => x.issues.length === 0).length === 0 ? <p className="text-sm text-muted-foreground">No receipt is ready yet.</p> :
              withIssues.filter((x) => x.issues.length === 0).map(({ r }) => (
                <ReceiptCard key={r.key} r={r} prodMap={prodMap} productOptions={productOptions} onProduct={setLineProduct} onDate={setReceiptDate} {...cardEdit}
                  included={!skip[r.key]} onInclude={(v) => setSkip((s) => ({ ...s, [r.key]: !v }))}
                  payments={(allocation.per[r.key] ?? []).map((p) => `${accName(p.payment_account_id)} ${formatMoney(p.amount)}`).join(" + ") || "No payment allocated"} />
              ))}
          </CardContent></Card>

          {notebook.length > 0 && (
            <Card><CardContent className="space-y-3 p-5">
              <h3 className="font-semibold">Notebook: payments and expenses</h3>
              <p className="text-xs text-muted-foreground">Payments are shared out over the ready receipts in this order. Expenses become expense drafts.</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                    <tr><th className="px-2 py-2 text-left">As written</th><th className="px-2 py-2 text-right">Amount</th><th className="px-2 py-2 text-left">Is</th><th className="px-2 py-2 text-left">Method / category</th><th className="px-2 py-2 text-left">Paid from</th><th className="px-2 py-2 text-left">Date</th></tr>
                  </thead>
                  <tbody>
                    {notebook.map((n) => (
                      <tr key={n.key} className="border-t border-border align-middle">
                        <td className="px-2 py-1.5">{n.label}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{formatMoney(n.amount)}</td>
                        <td className="px-1 py-1 min-w-[120px]">
                          <Select value={n.kind} onValueChange={(v) => setNote(n.key, { kind: v as ReadNoteLine["kind"] })}>
                            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value="payment">Payment</SelectItem>{canExpense && <SelectItem value="expense">Expense</SelectItem>}<SelectItem value="ignore">Ignore</SelectItem></SelectContent>
                          </Select></td>
                        <td className="px-1 py-1 min-w-[200px]">
                          {n.kind === "payment" && (
                            <Select value={n.account_id ?? NONE} onValueChange={(v) => setNote(n.key, { account_id: v === NONE ? null : v })}>
                              <SelectTrigger className={`h-8 ${n.account_id ? "" : "border-destructive"}`}><SelectValue /></SelectTrigger>
                              <SelectContent><SelectItem value={NONE}>Choose method…</SelectItem>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
                            </Select>)}
                          {n.kind === "expense" && (
                            <Select value={n.category_id ?? NONE} onValueChange={(v) => setNote(n.key, { category_id: v === NONE ? null : v })}>
                              <SelectTrigger className={`h-8 ${n.category_id ? "" : "border-destructive"}`}><SelectValue /></SelectTrigger>
                              <SelectContent><SelectItem value={NONE}>Choose category…</SelectItem>{categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                            </Select>)}
                        </td>
                        <td className="px-1 py-1 min-w-[140px]">
                          {n.kind === "expense" && (
                            <Select value={n.paid_from_account_id ?? NONE} onValueChange={(v) => setNote(n.key, { paid_from_account_id: v === NONE ? null : v })}>
                              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                              <SelectContent><SelectItem value={NONE}>Choose…</SelectItem>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
                            </Select>)}
                        </td>
                        <td className="px-1 py-1">{n.kind === "expense" && <Input type="date" className="h-8 w-40" value={n.date ?? ""} onChange={(e) => setNote(n.key, { date: e.target.value || null })} />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {allocation.leftover.size > 0 && (
                <p className="text-sm">Payments not yet used (they go to receipts once corrected): <span className="font-medium">{Array.from(allocation.leftover).map(([id, amt]) => `${accName(id)} ${formatMoney(amt)}`).join(", ")}</span></p>
              )}
            </CardContent></Card>
          )}

          <Card><CardContent className="space-y-2 p-5">
            {fixable.length > 0 && <p className="text-sm text-destructive">⚠ {fixable.length} receipt{fixable.length === 1 ? " still needs" : "s still need"} correcting ({fixable.map(({ r }) => r.number).join(", ")}). Correct them above, or create drafts for the ready ones now and enter the rest later.</p>}
            {unmappedPay.length > 0 && <p className="text-sm text-destructive">⚠ Choose the payment method for: {unmappedPay.map((p) => p.label).join(", ")}.</p>}
            {unpaidReady.length > 0 && <p className="rounded-md bg-warning/15 px-3 py-2 text-sm">⚠ Not fully paid from the notebook: receipt {unpaidReady.map((r) => r.number).join(", ")}. The draft is saved with what was allocated; complete the payment before posting.</p>}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">{ready.length} sale draft{ready.length === 1 ? "" : "s"} and {expReady.length} expense draft{expReady.length === 1 ? "" : "s"} will be created. Nothing is posted.</p>
              <Button onClick={create} disabled={saving || (ready.length === 0 && expReady.length === 0)}>{saving ? "Creating…" : "Create drafts"}</Button>
            </div>
          </CardContent></Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, good, bad }: { label: string; value: string; good?: boolean; bad?: boolean }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className={`text-lg font-semibold ${good ? "text-success" : bad ? "text-destructive" : ""}`}>{value}</p></div>;
}

type LinePatch = Partial<ReadReceipt["lines"][number]>;

function ReceiptCard({ r, issues, prodMap, productOptions, onProduct, onDate, onLine, onAdd, onRemove, onTotal, included, onInclude, payments }: {
  r: ReadReceipt; issues?: string[]; prodMap: Map<string, ProductOpt>; productOptions: { id: string; label: string; hint: string; search: string }[];
  onProduct: (rk: string, idx: number, pid: string) => void; onDate: (rk: string, d: string) => void;
  onLine: (rk: string, idx: number, patch: LinePatch) => void; onAdd: (rk: string) => void; onRemove: (rk: string, idx: number) => void;
  onTotal: (rk: string, v: string) => void;
  included?: boolean; onInclude?: (v: boolean) => void; payments?: string;
}) {
  const sum = linesTotal(r);
  const off = r.written_total !== null && Math.abs(sum - r.written_total) > 0.5;
  const num = (v: string) => (v === "" ? 0 : Number(v) || 0);
  return (
    <div className={`rounded-md border ${issues?.length ? "border-destructive/50" : "border-border"} ${included === false ? "opacity-50" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          {onInclude && <input type="checkbox" checked={included} onChange={(e) => onInclude(e.target.checked)} aria-label={`Include receipt ${r.number}`} />}
          <span className="font-semibold">Receipt {r.number}</span>
          <Input type="date" className={`h-7 w-36 ${r.date ? "" : "border-destructive"}`} value={r.date ?? ""} onChange={(e) => onDate(r.key, e.target.value)} aria-label="Receipt date" />
          {r.date && <span className="text-xs text-muted-foreground">{formatDate(r.date)}</span>}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">Receipt total
          <Input aria-label="Receipt total" type="number" min="0" step="1" className={`h-7 w-32 text-right font-semibold tabular-nums ${off || r.written_total === null ? "border-destructive" : ""}`}
            value={r.written_total ?? ""} onChange={(e) => onTotal(r.key, e.target.value)} />
        </label>
      </div>
      {issues && issues.length > 0 && (
        <ul className="list-disc space-y-0.5 border-b border-border bg-destructive/5 py-1.5 pl-8 pr-3 text-xs text-destructive">{issues.map((x) => <li key={x}>{x}</li>)}</ul>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase text-muted-foreground">
            <tr><th className="px-3 pt-1.5 text-left">Qty</th><th className="px-2 pt-1.5 text-left">As written</th><th className="px-1 pt-1.5 text-left">Product</th><th className="px-2 pt-1.5 text-right">Each</th><th className="px-1 pt-1.5 text-right">Amount</th><th /></tr>
          </thead>
          <tbody>
            {r.lines.map((l, i) => {
              const p = l.product_id ? prodMap.get(l.product_id) : null;
              const unit = l.qty > 0 ? round2(l.amount / l.qty) : 0;
              return (
                <tr key={i} className="border-t border-border align-middle">
                  <td className="px-2 py-1"><Input aria-label="Quantity" type="number" min="0" step="any" className={`h-8 w-16 text-right tabular-nums ${l.qty > 0 ? "" : "border-destructive"}`}
                    value={l.qty || ""} onChange={(e) => onLine(r.key, i, { qty: num(e.target.value) })} /></td>
                  <td className="px-2 py-1"><Input aria-label="Item as written" className="h-8 min-w-[130px] border-transparent bg-transparent italic text-muted-foreground hover:border-input focus:border-input"
                    placeholder="Item" value={l.text} onChange={(e) => onLine(r.key, i, { text: e.target.value })} /></td>
                  <td className="px-1 py-1 min-w-[240px]">
                    <SearchSelect value={l.product_id ?? ""} onChange={(v) => onProduct(r.key, i, v)} placeholder="Choose product…" options={productOptions}
                      className={l.product_id ? "" : "[&_button]:border-destructive"} />
                    {l.match === "memory" && <span className="text-[10px] text-muted-foreground">remembered</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums text-xs text-muted-foreground" title="Unit price = amount ÷ qty">
                    {formatMoney(unit)}{p && Math.abs(p.price - unit) > 0.5 ? <span className="block">list {formatMoney(p.price)}</span> : null}
                  </td>
                  <td className="px-1 py-1"><Input aria-label="Amount" type="number" min="0" step="1" className={`ml-auto h-8 w-28 text-right tabular-nums ${l.amount > 0 ? "" : "border-destructive"}`}
                    value={l.amount || ""} onChange={(e) => onLine(r.key, i, { amount: round2(num(e.target.value)) })} /></td>
                  <td className="px-1 py-1 text-center"><button type="button" aria-label="Remove line" onClick={() => onRemove(r.key, i)} className="text-muted-foreground hover:text-destructive"><X className="h-4 w-4" /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-1.5 text-xs">
        <button type="button" onClick={() => onAdd(r.key)} className="font-medium text-primary hover:underline">+ Add line</button>
        <span className={`tabular-nums ${off ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
          Items add up to {formatMoney(sum)}{off ? ` · difference ${formatMoney(round2((r.written_total ?? 0) - sum))}` : r.written_total !== null ? " ✓" : ""}
        </span>
      </div>
      {payments && <p className="border-t border-border px-3 py-1.5 text-xs text-muted-foreground">Payment: {payments}</p>}
    </div>
  );
}

function ManualList({ manual, branchId, leftover, accName }: {
  manual: { r: ReadReceipt; issues: string[] }[]; branchId: string; leftover: Map<string, number>; accName: (id: string | null) => string;
}) {
  return (
    <div className="space-y-2">
      <h3 className="font-semibold text-destructive">Enter these receipts by hand</h3>
      <p className="text-xs text-muted-foreground">They were not drafted because something does not match. Check the paper receipt and enter it on Create Sale.
        {leftover.size > 0 && <> Use the payments left over: {Array.from(leftover).map(([id, amt]) => `${accName(id)} ${formatMoney(amt)}`).join(", ")}.</>}</p>
      <ul className="space-y-2">
        {manual.map(({ r, issues }) => (
          <li key={r.key} className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">Receipt {r.number || "(no number)"}{r.date ? ` · ${formatDate(r.date)}` : ""}</span>
              <Button asChild size="sm" variant="outline"><Link href={`/sales/new?branch=${branchId}`} target="_blank">Enter by hand</Link></Button>
            </div>
            <ul className="mt-1 list-disc pl-5 text-xs text-destructive">{issues.map((x) => <li key={x}>{x}</li>)}</ul>
            <p className="mt-1 text-xs text-muted-foreground">As read: {r.lines.map((l) => `${l.qty} ${l.text} ${formatMoney(l.amount)}`).join(" · ")}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
