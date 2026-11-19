"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ChevronDown, ClipboardList, Plus, Trash2 } from "lucide-react";
import { savePurchaseDraft, postPurchase, quickCreateSupplier, quickCreateProduct, type PurchaseDraftInput } from "@/lib/purchases/actions";
import { calcLine, calcTotals, round2 } from "@/lib/sales/calc";
import { formatMoney, formatDate, formatQuantity, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProductPicker } from "@/components/common/product-picker";
import { SearchSelect } from "@/components/common/search-select";

export interface ProductOpt {
  id: string; sku: string; barcode: string | null; name: string; tax_code_id: string | null;
  category: string | null; brand: string | null;
}
export interface TaxOpt { id: string; name: string; rate: number; is_inclusive: boolean }
export interface AccountOpt { id: string; name: string }
export interface SupplierOpt { id: string; code: string; name: string; phone?: string | null; payment_terms_days?: number | null }
export interface CurrencyOpt { code: string; name: string }
export interface TableRate { currency: string; date: string; rate: number }
export interface AdvanceOpt { id: string; supplier_id: string; currency_code: string; fc_remaining: number; label: string }
export interface RefOpt { id: string; name: string }
/** A confirmed purchase order being received. */
export interface OrderPrefill {
  id: string; number: string; supplierId: string;
  lines: { product_id: string; ordered: number; received: number }[];
}

interface Line { key: string; product_id: string; quantity: string; unit_cost: string; tax_code_id: string }
type PayMode = "paid" | "partial" | "credit";
const NONE = "__none__";
const key = () => Math.random().toString(36).slice(2);
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export function PurchaseForm({
  branchId, products: initialProducts, taxCodes, accounts, suppliers: initialSuppliers, currencies = [], fxAllowed = false,
  tableRates = [], advances = [], categories = [], brands = [], units = [], lastCosts = {}, order,
}: {
  branchId: string; products: ProductOpt[]; taxCodes: TaxOpt[]; accounts: AccountOpt[]; suppliers: SupplierOpt[];
  currencies?: CurrencyOpt[]; fxAllowed?: boolean; tableRates?: TableRate[]; advances?: AdvanceOpt[];
  categories?: RefOpt[]; brands?: RefOpt[]; units?: RefOpt[];
  /** Latest posted unit cost per product (shown as a hint). */
  lastCosts?: Record<string, number>;
  order?: OrderPrefill;
}) {
  const router = useRouter();
  const [products, setProducts] = React.useState(initialProducts);
  const [suppliers, setSuppliers] = React.useState(initialSuppliers);
  const prodMap = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const taxMap = new Map(taxCodes.map((t) => [t.id, t]));
  const orderLine = new Map((order?.lines ?? []).map((l) => [l.product_id, l]));

  const [supplierId, setSupplierId] = React.useState(order?.supplierId ?? "");
  const [date, setDate] = React.useState(todayISO());
  const [invNo, setInvNo] = React.useState("");
  const [invDate, setInvDate] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [dueDate, setDueDate] = React.useState("");
  const [lines, setLines] = React.useState<Line[]>(() => (order?.lines ?? [])
    .filter((l) => l.ordered - l.received > 0)
    .map((l) => ({ key: key(), product_id: l.product_id, quantity: String(round2(l.ordered - l.received)), unit_cost: "", tax_code_id: initialProducts.find((p) => p.id === l.product_id)?.tax_code_id ?? NONE })));
  const [mode, setMode] = React.useState<PayMode>("credit");
  const [accountId, setAccountId] = React.useState("");
  const [partAmount, setPartAmount] = React.useState("");
  const [more, setMore] = React.useState(false);
  const [currency, setCurrency] = React.useState("TZS");
  const [rate, setRate] = React.useState("");
  const [rateSource, setRateSource] = React.useState<"manual" | "rate_table">("manual");
  const [rateRef, setRateRef] = React.useState("");
  const [advApply, setAdvApply] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const [errors, setErrors] = React.useState<string[]>([]);
  const [newSupplier, setNewSupplier] = React.useState(false);
  const [newProduct, setNewProduct] = React.useState(false);

  const isFc = currency !== "TZS";
  const fxRate = isFc ? Number(rate || 0) : 1;
  const setLine = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));
  const supplier = suppliers.find((s) => s.id === supplierId);
  const tableRate = isFc
    ? tableRates.filter((r) => r.currency === currency && r.date <= date).sort((a, b) => (a.date < b.date ? 1 : -1))[0]
    : undefined;
  const supplierAdvances = advances.filter((a) => a.supplier_id === supplierId && a.currency_code === currency);

  const calcIn = (l: Line) => {
    const tc = l.tax_code_id !== NONE ? taxMap.get(l.tax_code_id) : null;
    return { quantity: Number(l.quantity || 0), unitPrice: Number(l.unit_cost || 0), discount: 0, taxRate: tc ? tc.rate : 0, taxInclusive: tc ? tc.is_inclusive : false };
  };
  const computed = lines.map((l) => calcLine(calcIn(l)));
  const totals = calcTotals(lines.map(calcIn));
  const vatLabel = (() => {
    const rates = Array.from(new Set(lines.map((l) => (l.tax_code_id !== NONE ? taxMap.get(l.tax_code_id)?.rate : undefined)).filter((r): r is number => !!r)));
    return rates.length === 1 ? `VAT ${rates[0]}%` : "VAT";
  })();
  const advTotal = round2(supplierAdvances.reduce((s, a) => s + Number(advApply[a.id] || 0), 0));
  const effMode: PayMode = isFc ? "credit" : mode;
  const paid = effMode === "paid" ? round2(totals.grand - advTotal) : effMode === "partial" ? round2(Number(partAmount || 0)) : 0;
  const outstanding = round2(totals.grand - paid - advTotal);

  function chooseSupplier(id: string) {
    setSupplierId(id); setAdvApply({});
    const s = suppliers.find((x) => x.id === id);
    if (s?.payment_terms_days && !dueDate) setDueDate(addDays(date, s.payment_terms_days));
  }
  function addProduct(id: string) {
    if (!id) return;
    const existing = lines.find((l) => l.product_id === id);
    if (existing) { toast.info("Already on the list — change its quantity."); return; }
    setLines((ls) => [...ls, { key: key(), product_id: id, quantity: "1", unit_cost: "", tax_code_id: prodMap.get(id)?.tax_code_id ?? NONE }]);
  }
  function changeCurrency(c: string) {
    setCurrency(c); setAdvApply({});
    if (c === "TZS") { setRate(""); setRateSource("manual"); }
  }

  async function submit(post: boolean) {
    const missing: string[] = [];
    if (!supplierId) missing.push("Supplier required.");
    const valid = lines.filter((l) => l.product_id && Number(l.quantity) > 0);
    if (valid.length === 0) missing.push("Add at least one product line with a quantity.");
    if (post && valid.some((l) => l.unit_cost.trim() === "")) missing.push("Enter the unit cost on every line.");
    if (isFc && !(fxRate > 0)) missing.push(`Exchange rate required (TZS per 1 ${currency}).`);
    if (effMode !== "credit" && !accountId) missing.push("Choose the account the payment is made from.");
    if (effMode === "partial" && !(paid > 0)) missing.push("Enter the amount paid now.");
    if (effMode === "partial" && paid >= totals.grand - advTotal) missing.push("A partial payment must be less than the total; choose Paid Now instead.");
    if (post && outstanding > 0 && !dueDate) missing.push("Due date required for the unpaid balance.");
    if (advTotal > totals.grand + 0.001) missing.push("Advances applied exceed the invoice total.");
    setErrors(missing);
    if (missing.length) return;

    const input: PurchaseDraftInput = {
      branchId, supplierId, documentDate: date, supplierInvoiceDate: invDate || null, supplierInvoiceNumber: invNo,
      internalReference: reference, dueDate: outstanding > 0 ? dueDate || null : null,
      lines: valid.map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit_cost: Number(l.unit_cost || 0), discount: 0, tax_code_id: l.tax_code_id === NONE ? null : l.tax_code_id })),
      payments: effMode === "credit" || paid <= 0 ? [] : [{ payment_account_id: accountId, amount: paid }],
      currencyCode: currency, exchangeRate: fxRate,
      rateSource: isFc ? rateSource : undefined, rateReference: isFc ? rateRef : undefined,
      advanceApplications: supplierAdvances.map((a) => ({ advance_id: a.id, fc_amount: Number(advApply[a.id] || 0) })).filter((a) => a.fc_amount > 0),
      purchaseOrderId: order?.id ?? null,
    };
    setPending(true);
    const res = await savePurchaseDraft(input);
    if (!res.ok || !res.id) { setErrors([res.error ?? "Failed."]); setPending(false); return; }
    if (post) {
      const pr = await postPurchase(res.id);
      if (!pr.ok) { toast.error(pr.error ?? "Saved as a draft; posting failed."); router.push(`/purchases/${res.id}`); return; }
      toast.success("Purchase posted.");
    } else toast.success("Draft saved.");
    router.push(`/purchases/${res.id}`);
  }

  return (
    <div className="space-y-4">
      {order && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm">
          <ClipboardList className="h-4 w-4 text-primary" />
          <span>Receiving goods for purchase order <Link href={`/purchases/orders/${order.id}`} className="font-medium underline">{order.number}</Link>.
            Enter the quantity received and the unit cost, then post.</span>
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5"><Label htmlFor="pur-date">Date</Label>
          <Input id="pur-date" type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => submit(false)} disabled={pending}>Save draft</Button>
          <Button onClick={() => submit(true)} disabled={pending}>{pending ? "Working..." : "Post (Save)"}</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
            <div className="space-y-1.5"><Label>Supplier <span className="text-destructive">*</span></Label>
              <SearchSelect value={supplierId} onChange={chooseSupplier} disabled={!!order}
                placeholder="Search supplier by name/phone" emptyText="No supplier found — add a new one"
                options={suppliers.map((s) => ({ id: s.id, label: s.name, hint: s.phone || s.code, search: `${s.code} ${s.phone ?? ""}` }))} /></div>
            <Button type="button" variant="outline" onClick={() => setNewSupplier(true)} disabled={!!order}><Plus className="h-4 w-4" /> New Supplier</Button>
            <div className="space-y-1.5"><Label htmlFor="pur-bill">Supplier Bill/Ref</Label>
              <Input id="pur-bill" placeholder="Supplier invoice or delivery note no." value={invNo} onChange={(e) => setInvNo(e.target.value)} /></div>
          </CardContent></Card>

          <Card><CardContent className="space-y-3 p-4">
            <div className="flex flex-col gap-2 sm:flex-row">
              <ProductPicker products={products} value="" onChange={addProduct} placeholder="Search products (existing)" className="flex-1" />
              <Button type="button" variant="outline" onClick={() => setNewProduct(true)}><Plus className="h-4 w-4" /> New Product</Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 text-left">Product</th>
                    {order && <th className="px-2 py-2 text-right">Pending</th>}
                    <th className="px-2 py-2 text-left">VAT</th>
                    <th className="px-2 py-2 text-right">{order ? "Qty received" : "Qty"}</th>
                    <th className="px-2 py-2 text-right">Unit Cost{isFc ? ` (${currency})` : ""}</th>
                    <th className="px-2 py-2 text-right">Line Total</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr><td colSpan={order ? 7 : 6} className="px-2 py-8 text-center text-muted-foreground">Search or create a product to add lines</td></tr>
                  )}
                  {lines.map((l, i) => {
                    const p = prodMap.get(l.product_id);
                    const ol = orderLine.get(l.product_id);
                    const last = lastCosts[l.product_id];
                    return (
                      <tr key={l.key} className="border-t border-border align-middle">
                        <td className="px-2 py-1.5"><span className="font-medium">{p?.name ?? "—"}</span><span className="block text-xs text-muted-foreground">{[p?.sku, p?.brand].filter(Boolean).join(" · ")}</span></td>
                        {order && <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{ol ? formatQuantity(Math.max(ol.ordered - ol.received, 0)) : "not ordered"}</td>}
                        <td className="px-1 py-1 min-w-[120px]">
                          <Select value={l.tax_code_id} onValueChange={(v) => setLine(l.key, { tax_code_id: v })}>
                            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value={NONE}>No VAT</SelectItem>{taxCodes.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
                          </Select>
                        </td>
                        <td className="px-1 py-1"><Input aria-label="Quantity" className="ml-auto h-8 w-24 text-right tabular-nums" type="number" min="0" step="0.0001" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} /></td>
                        <td className="px-1 py-1 text-right"><Input aria-label="Unit cost" className="ml-auto h-8 w-32 text-right tabular-nums" type="number" min="0" step="0.01" value={l.unit_cost}
                          onChange={(e) => setLine(l.key, { unit_cost: e.target.value })} />
                          {last !== undefined && !isFc && (
                            <button type="button" className="mt-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:underline" title="Use the last cost"
                              onClick={() => setLine(l.key, { unit_cost: String(last) })}>last {last.toLocaleString("en-US", { maximumFractionDigits: 2 })}</button>
                          )}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatMoney(computed[i].lineTotal)}</td>
                        <td className="px-1 py-1 text-center"><button type="button" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent></Card>

          <Card><CardContent className="space-y-4 p-5">
            <Label>Payment at Posting</Label>
            {isFc ? (
              <p className="text-sm text-muted-foreground">{currency} invoices are settled through <span className="font-medium text-foreground">Supplier Payments</span>.</p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {([["paid", "Paid Now"], ["partial", "Partial"], ["credit", "Credit (Unpaid)"]] as const).map(([m, label]) => (
                    <button key={m} type="button" onClick={() => setMode(m)} aria-pressed={mode === m}
                      className={`rounded-md border px-3 py-2 text-sm transition-colors ${mode === m ? "border-primary bg-primary/10 font-medium text-primary" : "border-border hover:bg-muted/50"}`}>{label}</button>
                  ))}
                </div>
                {mode !== "credit" && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5"><Label>Paid from <span className="text-destructive">*</span></Label>
                      <Select value={accountId} onValueChange={setAccountId}><SelectTrigger><SelectValue placeholder="Select account…" /></SelectTrigger>
                        <SelectContent>{accounts.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent></Select></div>
                    {mode === "partial"
                      ? <div className="space-y-1.5"><Label htmlFor="pur-part">Amount paid now <span className="text-destructive">*</span></Label>
                          <Input id="pur-part" type="number" min="0" step="0.01" className="text-right tabular-nums" value={partAmount} onChange={(e) => setPartAmount(e.target.value)} /></div>
                      : <div className="space-y-1.5"><Label>Amount</Label><p className="pt-2 text-right font-medium tabular-nums">{formatMoney(paid)}</p></div>}
                  </div>
                )}
              </>
            )}
            {outstanding > 0 && (
              <div className="max-w-xs space-y-1.5"><Label htmlFor="pur-due">Due date <span className="text-destructive">*</span></Label>
                <Input id="pur-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                {supplier?.payment_terms_days ? <p className="text-[11px] text-muted-foreground">Supplier terms: {supplier.payment_terms_days} days.</p> : null}
              </div>
            )}
          </CardContent></Card>

          {supplierAdvances.length > 0 && (
            <Card><CardContent className="p-5">
              <Label>Apply supplier advances ({currency})</Label>
              <p className="mb-2 text-xs text-muted-foreground">The prepaid part of the goods is costed at each advance&apos;s historical TZS, so no exchange gain or loss arises.</p>
              <div className="space-y-2">
                {supplierAdvances.map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">{a.label} · open {currency} {formatMoney(a.fc_remaining)}</span>
                    <Input className="h-8 w-32 text-right tabular-nums" type="number" min="0" max={a.fc_remaining} step="0.01"
                      value={advApply[a.id] ?? ""} onChange={(e) => setAdvApply({ ...advApply, [a.id]: e.target.value })} />
                  </div>
                ))}
              </div>
            </CardContent></Card>
          )}

          <Card><CardContent className="p-0">
            <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}
              className="flex w-full items-center justify-between px-5 py-3 text-left hover:bg-muted/40">
              <span className="text-sm font-medium">More details <span className="ml-1 text-xs font-normal text-muted-foreground">invoice date, internal reference{fxAllowed ? ", currency" : ""}</span></span>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${more ? "rotate-180" : ""}`} />
            </button>
            {more && (
              <div className="grid grid-cols-1 gap-4 px-5 pb-5 sm:grid-cols-2">
                <div className="space-y-1.5"><Label htmlFor="pur-invdate">Supplier invoice date</Label><Input id="pur-invdate" type="date" value={invDate} onChange={(e) => setInvDate(e.target.value)} /></div>
                <div className="space-y-1.5"><Label htmlFor="pur-ref">Internal reference</Label><Input id="pur-ref" value={reference} onChange={(e) => setReference(e.target.value)} /></div>
                {fxAllowed && (
                  <div className="space-y-1.5"><Label>Invoice currency</Label>
                    <Select value={currency} onValueChange={changeCurrency}><SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="TZS">TZS — Tanzanian Shilling</SelectItem>
                        {currencies.map((c) => <SelectItem key={c.code} value={c.code}>{c.code} — {c.name}</SelectItem>)}</SelectContent></Select></div>
                )}
                {isFc && (
                  <>
                    <div className="space-y-1.5"><Label>Exchange rate (TZS per 1 {currency}) *</Label>
                      <Input type="number" min="0" step="0.000001" value={rate} onChange={(e) => { setRate(e.target.value); setRateSource("manual"); }} />
                      <p className="text-xs text-muted-foreground">
                        {tableRate
                          ? <>Rate table: {tableRate.rate} on {formatDate(tableRate.date)}{" "}
                              <button type="button" className="underline" onClick={() => { setRate(String(tableRate.rate)); setRateSource("rate_table"); }}>use it</button></>
                          : "No table rate on or before this date — enter the authorised rate."}
                        {" "}Source: {rateSource === "rate_table" ? "rate table" : "manual"}.
                      </p></div>
                    <div className="space-y-1.5"><Label>Rate reference</Label>
                      <Input value={rateRef} onChange={(e) => setRateRef(e.target.value)} placeholder="e.g. BOT mean rate, bank deal ref" /></div>
                  </>
                )}
              </div>
            )}
          </CardContent></Card>
        </div>

        <div>
          <Card className="sticky top-20"><CardContent className="space-y-2 p-5 text-sm">
            <p className="font-semibold">Totals{isFc ? ` (${currency})` : ""}</p>
            <Row label="Net" value={formatMoney(totals.net)} />
            <Row label={vatLabel} value={formatMoney(totals.tax)} />
            <div className="my-1 border-t border-border" />
            <Row label="Grand Total" value={formatMoney(totals.grand)} bold />
            {advTotal > 0 && <Row label="Advances applied" value={formatMoney(advTotal)} />}
            {!isFc && <Row label="Paid now" value={formatMoney(paid)} />}
            <Row label="AP Created" value={formatMoney(Math.max(outstanding, 0))} bold />
            {isFc && fxRate > 0 && (
              <div className="mt-2 space-y-1 rounded-md bg-muted/50 p-2 text-xs">
                <p className="font-medium">TZS at {fxRate} (preview)</p>
                <Row label="Invoice" value={formatMoney(round2(totals.grand * fxRate))} />
                <p className="text-muted-foreground">Final TZS amounts are calculated and locked when posted.</p>
              </div>
            )}
            {errors.length > 0 && (
              <ul className="space-y-1 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{errors.map((e) => <li key={e}>⚠ {e}</li>)}</ul>
            )}
            <div className="flex flex-col gap-2 pt-2">
              <Button onClick={() => submit(true)} disabled={pending}>{pending ? "Working..." : "Post (Save)"}</Button>
              <Button variant="outline" onClick={() => submit(false)} disabled={pending}>Save draft</Button>
            </div>
          </CardContent></Card>
        </div>
      </div>

      <NewSupplierDialog open={newSupplier} onOpenChange={setNewSupplier} onCreated={(s) => { setSuppliers((x) => [...x, s].sort((a, b) => a.name.localeCompare(b.name))); chooseSupplier(s.id); }} />
      <NewProductDialog open={newProduct} onOpenChange={setNewProduct} categories={categories} brands={brands} units={units} taxCodes={taxCodes} supplierId={supplierId}
        onCreated={(p) => { setProducts((x) => [...x, p]); setLines((ls) => [...ls, { key: key(), product_id: p.id, quantity: "1", unit_cost: "", tax_code_id: p.tax_code_id ?? NONE }]); }} />
    </div>
  );
}

function NewSupplierDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (s: SupplierOpt) => void }) {
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    const r = await quickCreateSupplier({ name, phone });
    setBusy(false);
    if (!r.ok || !r.id) { setError(r.error ?? "Failed."); return; }
    onCreated({ id: r.id, code: r.code ?? "", name: name.trim(), phone: phone.trim() || null });
    toast.success("Supplier added."); setName(""); setPhone(""); onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>New supplier</DialogTitle><DialogDescription>Address, TIN and payment terms can be completed later in Admin → Suppliers.</DialogDescription></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5"><Label htmlFor="ns-name">Supplier name <span className="text-destructive">*</span></Label><Input id="ns-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          <div className="space-y-1.5"><Label htmlFor="ns-phone">Phone</Label><Input id="ns-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} disabled={busy || !name.trim()}>{busy ? "Saving..." : "Add supplier"}</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NewProductDialog({ open, onOpenChange, onCreated, categories, brands, units, taxCodes, supplierId }: {
  open: boolean; onOpenChange: (o: boolean) => void; onCreated: (p: ProductOpt) => void;
  categories: RefOpt[]; brands: RefOpt[]; units: RefOpt[]; taxCodes: TaxOpt[]; supplierId: string;
}) {
  const [name, setName] = React.useState("");
  const [cat, setCat] = React.useState(NONE);
  const [brand, setBrand] = React.useState(NONE);
  const [unit, setUnit] = React.useState(NONE);
  const [tax, setTax] = React.useState(taxCodes.find((t) => t.rate > 0)?.id ?? NONE);
  const [price, setPrice] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const v = (x: string) => (x === NONE ? null : x);
  async function save() {
    setBusy(true); setError(null);
    const r = await quickCreateProduct({ name, categoryId: v(cat), brandId: v(brand), unitId: v(unit), taxCodeId: v(tax), sellingPrice: Number(price || 0), supplierId: supplierId || null });
    setBusy(false);
    if (!r.ok || !r.id) { setError(r.error ?? "Failed."); return; }
    onCreated({ id: r.id, sku: r.sku ?? "", barcode: null, name: name.trim(), tax_code_id: v(tax),
      category: categories.find((c) => c.id === cat)?.name ?? null, brand: brands.find((b) => b.id === brand)?.name ?? null });
    toast.success("Product added to the list."); setName(""); setPrice(""); onOpenChange(false);
  }
  const pick = (label: string, value: string, set: (x: string) => void, opts: RefOpt[]) => (
    <div className="space-y-1.5"><Label>{label}</Label>
      <Select value={value} onValueChange={set}><SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value={NONE}>— None —</SelectItem>{opts.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent></Select></div>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>New product</DialogTitle><DialogDescription>The product is created and added to this purchase. Other details can be completed later in Admin → Products.</DialogDescription></DialogHeader>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="np-name">Product name <span className="text-destructive">*</span></Label><Input id="np-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
          {pick("Category", cat, setCat, categories)}
          {pick("Brand", brand, setBrand, brands)}
          {pick("Unit", unit, setUnit, units)}
          {pick("VAT", tax, setTax, taxCodes.map((t) => ({ id: t.id, name: t.name })))}
          <div className="space-y-1.5"><Label htmlFor="np-price">Selling price</Label><Input id="np-price" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} /></div>
          {error && <p className="text-sm text-destructive sm:col-span-2">{error}</p>}
          <div className="flex justify-end gap-2 sm:col-span-2"><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} disabled={busy || !name.trim()}>{busy ? "Saving..." : "Add product"}</Button></div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return <div className="flex items-center justify-between"><span className={bold ? "font-medium" : "text-muted-foreground"}>{label}</span><span className={`tabular-nums ${bold ? "font-semibold" : ""}`}>{value}</span></div>;
}
