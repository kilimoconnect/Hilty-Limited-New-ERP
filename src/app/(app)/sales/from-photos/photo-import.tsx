"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera, CheckCircle2, AlertTriangle, Loader2, X, ExternalLink } from "lucide-react";
import { createPhotoDrafts, type PhotoDraftResult } from "@/lib/photo-sales/actions";
import { linesTotal, receiptIssues, round2, type PhotoReadResult, type ReadReceipt } from "@/lib/photo-sales/types";
import { formatMoney, formatDate, formatQuantity } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { SearchSelect } from "@/components/common/search-select";

interface ProductOpt { id: string; sku: string; name: string; price: number; brand: string | null; stock: number | null }
interface Photo { key: string; file: File; url: string; status: "waiting" | "reading" | "done" | "error"; error?: string }
type LinePatch = Partial<ReadReceipt["lines"][number]>;

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
 * Upload receipt photos -> each is read on the server -> review the items:
 * every item needs a quantity, an amount and a product (choose it where it was
 * not recognised; the choice is remembered). The complete receipts are
 * combined into one sale draft (one per date); payment is entered on the
 * draft before posting.
 */
export function PhotoImport({ branchId, products }: { branchId: string; products: ProductOpt[] }) {
  const router = useRouter();
  const [photos, setPhotos] = React.useState<Photo[]>([]);
  const [reading, setReading] = React.useState(false);
  const [receipts, setReceipts] = React.useState<ReadReceipt[]>([]);
  const [skip, setSkip] = React.useState<Record<string, boolean>>({});
  const [saving, setSaving] = React.useState(false);
  const [result, setResult] = React.useState<PhotoDraftResult | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const prodMap = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  // Search shows brand and stock: "Plascon · 12 in stock" / "Plascon · OUT OF STOCK".
  const productOptions = React.useMemo(() => products.map((p) => ({
    id: p.id, label: p.name,
    hint: [p.brand, p.stock === null ? null : p.stock > 0 ? `${formatQuantity(p.stock)} in stock` : "OUT OF STOCK"].filter(Boolean).join(" · "),
    search: `${p.sku} ${p.brand ?? ""}`,
  })), [products]);

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
    const all: ReadReceipt[] = [...receipts];
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
      for (const r of data.receipts) if (!all.some((x) => x.number && x.number === r.number)) all.push(r);
    }
    all.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
    setReceipts(all); setReading(false);
  }

  const editReceipt = (rk: string, fn: (r: ReadReceipt) => ReadReceipt) => setReceipts((rs) => rs.map((r) => (r.key === rk ? fn(r) : r)));
  const edit = {
    onLine: (rk: string, idx: number, patch: LinePatch) => editReceipt(rk, (r) => ({ ...r, lines: r.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)) })),
    onProduct: (rk: string, idx: number, pid: string) => editReceipt(rk, (r) => ({ ...r, lines: r.lines.map((l, i) => (i === idx ? { ...l, product_id: pid || null, match: pid ? "user" as const : null } : l)) })),
    onAdd: (rk: string) => editReceipt(rk, (r) => ({ ...r, lines: [...r.lines, { qty: 1, text: "", amount: 0, product_id: null, match: null }] })),
    onRemove: (rk: string, idx: number) => editReceipt(rk, (r) => ({ ...r, lines: r.lines.filter((_, i) => i !== idx) })),
    onDate: (rk: string, date: string) => editReceipt(rk, (r) => ({ ...r, date: date || null })),
  };

  const withIssues = receipts.map((r) => ({ r, issues: receiptIssues(r) }));
  // Quantity asked for per product over all receipts (they become one sale), against branch stock.
  const needed = new Map<string, number>();
  for (const r of receipts) if (!r.existing_sale_id) for (const l of r.lines) if (l.product_id) needed.set(l.product_id, (needed.get(l.product_id) ?? 0) + (l.qty || 0));
  const shortOf = (pid: string | null) => {
    const p = pid ? prodMap.get(pid) : null;
    return p && p.stock !== null && (needed.get(p.id) ?? 0) > p.stock ? p : null;
  };
  const shortList = Array.from(needed.keys()).map((pid) => shortOf(pid)).filter((p): p is ProductOpt => !!p);
  const fixable = withIssues.filter((x) => x.issues.length > 0 && !x.r.existing_sale_id);
  const already = withIssues.filter((x) => !!x.r.existing_sale_id);
  const readyAll = withIssues.filter((x) => x.issues.length === 0);
  const ready = readyAll.filter((x) => !skip[x.r.key]).map((x) => x.r);
  const readyDates = Array.from(new Set(ready.map((r) => r.date)));

  async function create() {
    setSaving(true);
    const res = await createPhotoDrafts({ branchId, receipts: ready });
    if (!res.ok) { setSaving(false); toast.error(res.error ?? "Failed."); return; }
    const created = res.drafts.filter((d) => d.id);
    // One draft and nothing failed: go straight to Edit draft to add the payment.
    if (created.length === 1 && res.drafts.length === 1) {
      toast.success(`Sale draft created from ${created[0].numbers.length} receipt${created[0].numbers.length === 1 ? "" : "s"}. Add the payment, then post.`);
      router.push(`/sales/${created[0].id}/edit`);
      return;
    }
    setSaving(false);
    setResult(res);
    const made = res.drafts.filter((d) => d.id).length;
    if (made) toast.success(`Sale draft created from ${res.drafts.filter((d) => d.id).reduce((n, d) => n + d.numbers.length, 0)} receipts. Add the payment, then post.`);
    else toast.error(res.drafts[0]?.error ?? res.refused[0]?.error ?? "No draft was created.");
  }

  if (result) {
    return (
      <Card><CardContent className="space-y-3 p-5">
        <h3 className="font-semibold">Sale draft created</h3>
        <p className="text-sm text-muted-foreground">Open the draft, check the items against the receipts, add the payment with Edit draft, then post it.</p>
        <ul className="space-y-1.5 text-sm">
          {result.drafts.map((d) => (
            <li key={d.date} className="flex flex-wrap items-center gap-2">
              {d.id ? <CheckCircle2 className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-destructive" />}
              <span className="font-medium">{formatDate(d.date)} · receipts {d.numbers.join(", ")}</span>
              {d.id ? <Link href={`/sales/${d.id}/edit`} className="inline-flex items-center gap-1 text-primary underline">Edit draft (add payment) <ExternalLink className="h-3 w-3" /></Link> : <span className="text-destructive">{d.error}</span>}
            </li>
          ))}
        </ul>
        {result.refused.length > 0 && <p className="text-sm text-destructive">Left out: {result.refused.map((r) => `receipt ${r.number} (${r.error})`).join("; ")}.</p>}
        {fixable.length > 0 && <p className="text-sm text-destructive">Not included (still needed correcting): receipt {fixable.map(({ r }) => r.number).join(", ")}.</p>}
        <div className="flex gap-2 pt-2">
          <Button asChild variant="outline"><Link href="/sales/history?status=draft">Sales drafts</Link></Button>
          <Button onClick={() => { setResult(null); setReceipts([]); setPhotos([]); setSkip({}); }}>Start again</Button>
        </div>
      </CardContent></Card>
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
        <p className="text-xs text-muted-foreground">Add the day&apos;s cash-sale receipt pages. Take each photo straight on, in good light, with the whole receipt in view.</p>
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

      {receipts.length > 0 && (
        <>
          <Card><CardContent className="space-y-3 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-semibold">2. Check the receipts</h3>
              <span className="text-xs text-muted-foreground">{readyAll.length} complete · {fixable.length} to correct{already.length ? ` · ${already.length} already entered` : ""}</span>
            </div>
            <p className="text-xs text-muted-foreground">Compare each receipt with the paper. Where something is shown in red, choose the product or correct the quantity or price; add a missed item with + Add line. Product choices are remembered for next time.</p>
            {/* Receipts stay in their order; each shows whether it is complete. */}
            {withIssues.map(({ r, issues }) => (
              <ReceiptCard key={r.key} r={r} issues={issues} prodMap={prodMap} productOptions={productOptions} needed={needed} {...edit}
                included={issues.length === 0 ? !skip[r.key] : undefined}
                onInclude={issues.length === 0 ? (v) => setSkip((x) => ({ ...x, [r.key]: !v })) : undefined} />
            ))}
          </CardContent></Card>

          <Card><CardContent className="flex flex-wrap items-center justify-between gap-2 p-5">
            <div className="text-sm text-muted-foreground">
              <p>{ready.length} receipt{ready.length === 1 ? "" : "s"} ({ready.map((r) => r.number).join(", ") || "none"}) will be combined into {readyDates.length > 1 ? `${readyDates.length} sale drafts, one per date` : "one sale draft"} for Walk-in · {formatMoney(round2(ready.reduce((s, r) => s + linesTotal(r), 0)))}.</p>
              <p className="text-xs">Every receipt line is kept as its own line, even the same product. Add the payment on the draft, then post.</p>
            </div>
            <Button onClick={create} disabled={saving || ready.length === 0}>{saving ? "Creating…" : "Create sale draft"}</Button>
            {shortList.length > 0 && (
              <div className="w-full rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
                <p className="font-medium text-destructive">⚠ Not enough stock at this branch for {shortList.length} product{shortList.length === 1 ? "" : "s"}:</p>
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {shortList.map((p) => <li key={p.id}>{p.name}{p.brand ? ` (${p.brand})` : ""}: receipts need {formatQuantity(needed.get(p.id) ?? 0)}, in stock {formatQuantity(p.stock ?? 0)}</li>)}
                </ul>
                <p className="mt-1 text-xs text-muted-foreground">The draft can be saved, but it cannot be posted until the stock is there (receive the purchase or transfer first), or the product is corrected.</p>
              </div>
            )}
          </CardContent></Card>
        </>
      )}
    </div>
  );
}

function ReceiptCard({ r, issues, prodMap, productOptions, needed, onProduct, onDate, onLine, onAdd, onRemove, included, onInclude }: {
  r: ReadReceipt; issues?: string[]; prodMap: Map<string, ProductOpt>; productOptions: { id: string; label: string; hint: string; search: string }[];
  onProduct: (rk: string, idx: number, pid: string) => void; onDate: (rk: string, d: string) => void;
  onLine: (rk: string, idx: number, patch: LinePatch) => void; onAdd: (rk: string) => void; onRemove: (rk: string, idx: number) => void;
  included?: boolean; onInclude?: (v: boolean) => void; needed: Map<string, number>;
}) {
  const num = (v: string) => (v === "" ? 0 : Number(v) || 0);
  return (
    <div className={`rounded-md border ${issues?.length ? "border-destructive/50" : "border-border"} ${included === false ? "opacity-50" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          {onInclude && <input type="checkbox" checked={included} onChange={(e) => onInclude(e.target.checked)} aria-label={`Include receipt ${r.number}`} />}
          <span className="font-semibold">Receipt {r.number}</span>
          {issues && issues.length > 0
            ? <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">{r.existing_sale_id ? "Already entered" : "To correct"}</span>
            : <span className="rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">Complete ✓</span>}
          <Input type="date" className={`h-7 w-36 ${r.date ? "" : "border-destructive"}`} value={r.date ?? ""} onChange={(e) => onDate(r.key, e.target.value)} aria-label="Receipt date" />
          {r.date && <span className="text-xs text-muted-foreground">{formatDate(r.date)}</span>}
        </div>
        <span className="tabular-nums font-semibold">{formatMoney(linesTotal(r))}</span>
      </div>
      {issues && issues.length > 0 && (
        <ul className="list-disc space-y-0.5 border-b border-border bg-destructive/5 py-1.5 pl-8 pr-3 text-xs text-destructive">{issues.map((x) => <li key={x}>{x}</li>)}</ul>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-[10px] uppercase text-muted-foreground">
            <tr><th className="px-3 pt-1.5 text-left">Qty</th><th className="px-2 pt-1.5 text-left">As written</th><th className="px-1 pt-1.5 text-left">Product</th><th className="px-2 pt-1.5 text-left">Brand</th><th className="px-1 pt-1.5 text-right">Price (each)</th><th className="px-2 pt-1.5 text-right">Amount</th><th /></tr>
          </thead>
          <tbody>
            {r.lines.map((l, i) => {
              const p = l.product_id ? prodMap.get(l.product_id) : null;
              const out = !!p && p.stock !== null && (needed.get(p.id) ?? 0) > p.stock;
              const unit = l.qty > 0 ? round2(l.amount / l.qty) : l.amount;
              // The price is what is corrected; the amount follows (qty x price).
              const setQty = (q: number) => onLine(r.key, i, { qty: q, amount: round2(unit * q) });
              const setPrice = (pr: number) => onLine(r.key, i, { amount: round2(pr * (l.qty > 0 ? l.qty : 1)) });
              return (
                <tr key={i} className="border-t border-border align-middle">
                  <td className="px-2 py-1"><Input aria-label="Quantity" type="number" min="0" step="any" className={`h-8 w-16 text-right tabular-nums ${l.qty > 0 ? "" : "border-destructive"}`}
                    value={l.qty || ""} onChange={(e) => setQty(num(e.target.value))} /></td>
                  <td className="px-2 py-1"><Input aria-label="Item as written" className="h-8 min-w-[130px] border-transparent bg-transparent italic text-muted-foreground hover:border-input focus:border-input"
                    placeholder="Item" value={l.text} onChange={(e) => onLine(r.key, i, { text: e.target.value })} /></td>
                  <td className="px-1 py-1 min-w-[240px]">
                    <SearchSelect value={l.product_id ?? ""} onChange={(v) => onProduct(r.key, i, v)} placeholder="Choose product…" options={productOptions}
                      className={l.product_id ? "" : "[&_button]:border-destructive"} />
                    {l.match === "memory" && <span className="text-[10px] text-muted-foreground">remembered</span>}
                    {p && p.stock !== null && (
                      <span className={`block text-[11px] ${out ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
                        {p.stock <= 0 ? "Out of stock" : out ? `Only ${formatQuantity(p.stock)} in stock (receipts need ${formatQuantity(needed.get(p.id) ?? 0)})` : `${formatQuantity(p.stock)} in stock`}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-xs text-muted-foreground">{p?.brand ?? "—"}</td>
                  <td className="px-1 py-1 text-right">
                    <Input aria-label="Price each" type="number" min="0" step="any" className={`ml-auto h-8 w-28 text-right tabular-nums ${unit > 0 ? "" : "border-destructive"}`}
                      value={unit || ""} onChange={(e) => setPrice(num(e.target.value))} />
                    {p && Math.abs(p.price - unit) > 0.5 && (
                      <button type="button" className="mt-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:underline" title="Use the list price"
                        onClick={() => setPrice(p.price)}>list {formatMoney(p.price)}</button>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1 text-right tabular-nums">{formatMoney(l.amount)}</td>
                  <td className="px-1 py-1 text-center"><button type="button" aria-label="Remove line" onClick={() => onRemove(r.key, i)} className="text-muted-foreground hover:text-destructive"><X className="h-4 w-4" /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border px-3 py-1.5 text-xs">
        <button type="button" onClick={() => onAdd(r.key)} className="font-medium text-primary hover:underline">+ Add line</button>
      </div>
    </div>
  );
}
