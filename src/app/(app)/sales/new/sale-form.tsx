"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { saveSaleDraft, postSale, type SaleDraftInput } from "@/lib/sales/actions";
import { calcLine, calcTotals, round2 } from "@/lib/sales/calc";
import { formatMoney, formatQuantity, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProductPicker } from "@/components/common/product-picker";
import { SearchSelect } from "@/components/common/search-select";
import { ChosenBranch } from "@/components/layout/branch-choice";

export interface ProductOpt {
  id: string; sku: string; barcode: string | null; name: string; selling_price: number; tax_code_id: string | null;
  track_inventory: boolean; category: string | null; brand: string | null;
}
export interface TaxOpt { id: string; name: string; rate: number; is_inclusive: boolean }
export interface AccountOpt { id: string; code: string; name: string }
export interface CustomerOpt { id: string; code: string; name: string; is_protected: boolean; phone?: string | null }

interface Line { key: string; product_id: string; quantity: string; unit_price: string; tax_code_id: string }
const NONE = "__none__";
const key = () => Math.random().toString(36).slice(2);

/** "19 Nov 2026 19:35 EAT", refreshed every 20 seconds (rendered on the client only). */
function subscribeClock(cb: () => void) { const t = window.setInterval(cb, 20000); return () => window.clearInterval(t); }
function clockNow() {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Dar_es_Salaam", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
    .format(new Date()).replace(",", "") + " EAT";
}
function Clock() {
  const now = React.useSyncExternalStore(subscribeClock, clockNow, () => "");
  return <span className="tabular-nums">{now}</span>;
}

/**
 * Create Sale in the old system's layout: customer type (walk-in pays in full,
 * a registered customer may buy on credit), product search, payments split
 * across the branch's payment methods. Post (Save) stays faint until the sale
 * can be posted; for a walk-in that means paid = total.
 */
export function SaleForm({
  branchId, branchLabel, canChangeBranch = false, products, taxCodes, accounts, customers, stock, wac, canViewCost, walkInId,
}: {
  branchId: string; branchLabel: string; canChangeBranch?: boolean; products: ProductOpt[]; taxCodes: TaxOpt[]; accounts: AccountOpt[];
  customers: CustomerOpt[]; stock: Record<string, number>; wac: Record<string, number>; canViewCost: boolean; walkInId: string | null;
}) {
  const router = useRouter();
  const [walkIn, setWalkIn] = React.useState(!!walkInId);
  const [customerId, setCustomerId] = React.useState("");
  const [walkInName, setWalkInName] = React.useState("");
  const [date, setDate] = React.useState(todayISO());
  const [dueDate, setDueDate] = React.useState("");
  const [lines, setLines] = React.useState<Line[]>([]);
  const [paid, setPaid] = React.useState<Record<string, string>>({});
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const taxMap = new Map(taxCodes.map((t) => [t.id, t]));
  const prodMap = new Map(products.map((p) => [p.id, p]));
  const registered = customers.filter((c) => !c.is_protected);
  const setLine = (k: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === k ? { ...l, ...patch } : l)));

  function addProduct(pid: string) {
    if (!pid) return;
    const existing = lines.find((l) => l.product_id === pid);
    if (existing) { setLine(existing.key, { quantity: String(Number(existing.quantity || 0) + 1) }); return; }
    const p = prodMap.get(pid);
    setLines((ls) => [...ls, { key: key(), product_id: pid, quantity: "1", unit_price: p ? String(p.selling_price) : "", tax_code_id: p?.tax_code_id ?? NONE }]);
  }

  const calcIn = (l: Line) => {
    const tc = l.tax_code_id !== NONE ? taxMap.get(l.tax_code_id) : null;
    return { quantity: Number(l.quantity || 0), unitPrice: Number(l.unit_price || 0), discount: 0, taxRate: tc ? tc.rate : 0, taxInclusive: tc ? tc.is_inclusive : false };
  };
  const computed = lines.map((l) => calcLine(calcIn(l)));
  const totals = calcTotals(lines.map(calcIn));
  const paidTotal = round2(accounts.reduce((s, a) => s + Number(paid[a.id] || 0), 0));
  const balance = round2(totals.grand - paidTotal);

  // Stock: what each tracked product asks for must be on hand (the server re-checks).
  const short = lines.filter((l) => prodMap.get(l.product_id)?.track_inventory !== false && Number(l.quantity || 0) > (stock[l.product_id] ?? 0));
  const validLines = lines.filter((l) => l.product_id && Number(l.quantity) > 0);

  // Why Post is not available yet (shown under the payments).
  const blockers: string[] = [];
  if (validLines.length === 0) blockers.push("Add at least one product.");
  if (lines.some((l) => !(Number(l.quantity) > 0))) blockers.push("Every line needs a quantity.");
  if (short.length) blockers.push(`Not enough stock: ${short.map((l) => `${prodMap.get(l.product_id)?.name} (have ${formatQuantity(stock[l.product_id] ?? 0)})`).join(", ")}.`);
  if (!walkIn && !customerId) blockers.push("Choose the customer.");
  if (balance < -0.001) blockers.push(`Paid ${formatMoney(-balance)} more than the total.`);
  if (walkIn && validLines.length > 0 && Math.abs(balance) > 0.001 && balance > 0) blockers.push("Walk-in must be fully paid. Allocate payment across methods to balance.");
  if (!walkIn && balance > 0.001 && !dueDate) blockers.push("Set the due date for the unpaid balance.");
  const canPost = blockers.length === 0 && totals.grand > 0;

  function fillRest(accountId: string) {
    const others = round2(accounts.filter((a) => a.id !== accountId).reduce((s, a) => s + Number(paid[a.id] || 0), 0));
    const rest = round2(totals.grand - others);
    setPaid((p) => ({ ...p, [accountId]: rest > 0 ? String(rest) : "" }));
  }

  async function submit(post: boolean) {
    setError(null);
    if (post && !canPost) return;
    if (validLines.length === 0) { setError("Add at least one product."); return; }
    if (!walkIn && !customerId) { setError("Choose the customer."); return; }
    const input: SaleDraftInput = {
      branchId, documentDate: date, dueDate: !walkIn && balance > 0 ? dueDate || null : null,
      customerId: walkIn ? walkInId! : customerId,
      customerReference: walkIn ? walkInName.trim() : "",
      notes: walkIn && walkInName.trim() ? `Walk-in: ${walkInName.trim()}` : "",
      lines: validLines.map((l) => ({
        product_id: l.product_id, quantity: Number(l.quantity), unit_price: Number(l.unit_price || 0), discount: 0,
        tax_code_id: l.tax_code_id === NONE ? null : l.tax_code_id,
      })),
      payments: accounts.filter((a) => Number(paid[a.id] || 0) > 0).map((a) => ({ payment_account_id: a.id, amount: Number(paid[a.id]), payment_date: date })),
    };
    setPending(true);
    const res = await saveSaleDraft(input);
    if (!res.ok || !res.id) { setError(res.error ?? "Failed."); setPending(false); return; }
    if (post) {
      const p = await postSale(res.id);
      if (!p.ok) { toast.error(p.error ?? "Saved as a draft; posting failed."); router.push(`/sales/${res.id}`); return; }
      toast.success("Sale posted.");
    } else toast.success("Draft saved.");
    router.push(`/sales/${res.id}`);
  }

  const postButton = (
    <Button onClick={() => submit(true)} disabled={pending || !canPost} className="disabled:opacity-40"
      title={canPost ? undefined : blockers[0]}>{pending ? "Working..." : "Post (Save)"}</Button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground"><ChosenBranch branch={{ code: branchLabel.split(" — ")[0] ?? "", name: branchLabel.split(" — ")[1] ?? "" }} canChange={canChangeBranch} /> · <Clock /></p>
          <div className="flex items-end gap-3">
            <div className="space-y-1.5"><Label htmlFor="sale-date">Date</Label>
              <Input id="sale-date" type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} /></div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline" size="sm"><Link href={`/sales/new?branch=${branchId}`} onClick={() => { setLines([]); setPaid({}); }}>Create New Sale</Link></Button>
          <Button asChild variant="outline" size="sm"><Link href="/sales/history">Sales History</Link></Button>
          {postButton}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-4">
          <Card><CardContent className="space-y-4 p-5">
            <h3 className="font-semibold">Customer Information</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5"><Label>Customer Type</Label>
                <Select value={walkIn ? "walkin" : "registered"} onValueChange={(v) => { setWalkIn(v === "walkin"); setError(null); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {walkInId && <SelectItem value="walkin">Walk-in (No Credit)</SelectItem>}
                    <SelectItem value="registered">Registered customer (credit allowed)</SelectItem>
                  </SelectContent>
                </Select></div>
              {walkIn ? (
                <div className="space-y-1.5"><Label htmlFor="walkin-name">Walk-in Name</Label>
                  <Input id="walkin-name" placeholder="Optional" value={walkInName} onChange={(e) => setWalkInName(e.target.value)} /></div>
              ) : (
                <div className="space-y-1.5"><Label>Customer <span className="text-destructive">*</span></Label>
                  <SearchSelect value={customerId} onChange={setCustomerId} placeholder="Search customer by name/phone"
                    options={registered.map((c) => ({ id: c.id, label: c.name, hint: c.phone || c.code, search: `${c.code} ${c.phone ?? ""}` }))} /></div>
              )}
            </div>
          </CardContent></Card>

          <Card><CardContent className="space-y-3 p-4">
            <h3 className="px-1 font-semibold">Products</h3>
            <ProductPicker products={products} value="" onChange={addProduct} available={stock} placeholder="Search products" />
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-2 py-2 text-left">Product</th>
                    <th className="px-2 py-2 text-left">VAT</th>
                    <th className="px-2 py-2 text-right">Qty</th>
                    <th className="px-2 py-2 text-right">Stock</th>
                    <th className="px-2 py-2 text-right">Price</th>
                    {canViewCost && <th className="px-2 py-2 text-right" title="Weighted average cost at this branch">WAC*</th>}
                    <th className="px-2 py-2 text-right">Total</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 && (
                    <tr><td colSpan={canViewCost ? 8 : 7} className="px-2 py-8 text-center text-muted-foreground">Search and select products to add lines</td></tr>
                  )}
                  {lines.map((l, i) => {
                    const p = prodMap.get(l.product_id);
                    const tracked = p?.track_inventory !== false;
                    const isShort = short.includes(l);
                    const cost = wac[l.product_id];
                    const below = canViewCost && cost !== undefined && Number(l.unit_price || 0) > 0 && Number(l.unit_price) < cost;
                    return (
                      <tr key={l.key} className="border-t border-border align-middle">
                        <td className="px-2 py-1.5 min-w-[200px]"><span className="font-medium">{p?.name}</span><span className="block text-xs text-muted-foreground">{[p?.sku, p?.brand].filter(Boolean).join(" · ")}</span></td>
                        <td className="px-1 py-1 min-w-[110px]">
                          <Select value={l.tax_code_id} onValueChange={(v) => setLine(l.key, { tax_code_id: v })}>
                            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                            <SelectContent><SelectItem value={NONE}>No VAT</SelectItem>{taxCodes.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
                          </Select>
                        </td>
                        <td className="px-1 py-1"><Input aria-label="Quantity" className={`ml-auto h-8 w-20 text-right tabular-nums ${isShort ? "border-destructive" : ""}`} type="number" min="0" step="0.0001"
                          value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} /></td>
                        <td className={`px-2 py-1.5 text-right tabular-nums ${isShort ? "font-medium text-destructive" : "text-muted-foreground"}`}>{tracked ? formatQuantity(stock[l.product_id] ?? 0) : "n/a"}</td>
                        <td className="px-1 py-1"><Input aria-label="Price" className={`ml-auto h-8 w-28 text-right tabular-nums ${below ? "border-warning" : ""}`} type="number" min="0" step="0.01"
                          value={l.unit_price} onChange={(e) => setLine(l.key, { unit_price: e.target.value })} title={below ? "Below cost" : undefined} /></td>
                        {canViewCost && <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-muted-foreground">{cost !== undefined ? formatMoney(cost) : "—"}</td>}
                        <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{formatMoney(computed[i].lineTotal)}</td>
                        <td className="px-1 py-1 text-center"><button type="button" aria-label="Remove line" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {canViewCost && lines.length > 0 && <p className="px-1 text-[11px] text-muted-foreground">* WAC: weighted average cost at this branch (Owner only).</p>}
          </CardContent></Card>

          <Card><CardContent className="space-y-3 p-5">
            <h3 className="font-semibold">Payments (Split Tender)</h3>
            {accounts.length === 0 ? <p className="text-sm text-muted-foreground">No payment methods are assigned to this branch (Admin → Payment Methods &amp; Banks).</p> : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {accounts.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5">
                    <button type="button" onClick={() => fillRest(a.id)} className="w-20 shrink-0 text-left text-sm font-semibold hover:text-primary" title="Put the remaining balance here">{a.code}</button>
                    <Input aria-label={`${a.name} amount`} className="h-8 text-right tabular-nums" type="number" min="0" step="0.01" placeholder="0.00"
                      value={paid[a.id] ?? ""} onChange={(e) => setPaid((p) => ({ ...p, [a.id]: e.target.value }))} />
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">Tip: click a method name to put the remaining balance on it.</p>
            {!walkIn && balance > 0.001 && (
              <div className="max-w-xs space-y-1.5"><Label htmlFor="sale-due">Due date for the balance <span className="text-destructive">*</span></Label>
                <Input id="sale-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
            )}
            {lines.length > 0 && blockers.length > 0 && (
              <ul className="space-y-1 rounded-md bg-warning/15 px-3 py-2 text-sm">{blockers.map((b) => <li key={b}>⚠ {b}</li>)}</ul>
            )}
          </CardContent></Card>
        </div>

        <div>
          <Card className="sticky top-20"><CardContent className="space-y-2 p-5 text-sm">
            <p className="font-semibold">Totals</p>
            <Row label="Net" value={formatMoney(totals.net)} />
            <Row label="VAT" value={formatMoney(totals.tax)} />
            <div className="my-1 border-t border-border" />
            <Row label="Total" value={formatMoney(totals.grand)} bold />
            <Row label="Paid" value={formatMoney(paidTotal)} />
            <div className={`flex items-center justify-between font-semibold ${Math.abs(balance) <= 0.001 ? "" : "text-destructive"}`}>
              <span>Balance</span><span className="tabular-nums">{formatMoney(balance)}</span>
            </div>
            {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            <div className="flex flex-col gap-2 pt-2">
              {postButton}
              <Button variant="outline" onClick={() => submit(false)} disabled={pending || validLines.length === 0}>Save draft</Button>
            </div>
          </CardContent></Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return <div className="flex items-center justify-between"><span className={bold ? "font-medium" : "text-muted-foreground"}>{label}</span><span className={`tabular-nums ${bold ? "font-semibold" : ""}`}>{value}</span></div>;
}
