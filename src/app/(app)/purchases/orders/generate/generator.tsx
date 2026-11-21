"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Info, Sparkles, Trash2, X } from "lucide-react";
import {
  suggestOrder, createOrdersFromSuggestion, saveReorderLevels, type Basis, type SuggestionRow,
} from "@/lib/purchases/order-actions";
import { formatQuantity } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ProductPicker, type PickerProduct } from "@/components/common/product-picker";
import { SearchSelect } from "@/components/common/search-select";
import { followPageBranch, useBranchFollow } from "@/lib/branch-sync";

type Opt = { id: string; name: string; hint?: string | null };
interface Row extends SuggestionRow { key: string; qty: string; supplier: string }
const NO_SUP = "__none__";
const key = () => Math.random().toString(36).slice(2);
const q = (v: number | null) => (v === null ? "—" : formatQuantity(v));

/** Several values picked from a searchable list, shown as chips. */
function MultiPick({ label, options, value, onChange, placeholder }: { label: string; options: Opt[]; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const map = new Map(options.map((o) => [o.id, o]));
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <SearchSelect value="" onChange={(id) => id && !value.includes(id) && onChange([...value, id])} placeholder={value.length ? `${value.length} selected — add more` : placeholder}
        options={options.filter((o) => !value.includes(o.id)).map((o) => ({ id: o.id, label: o.name, hint: o.hint }))} />
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
              {map.get(id)?.name ?? "?"}
              <button type="button" aria-label="Remove" onClick={() => onChange(value.filter((x) => x !== id))}><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function OrderGenerator({ branches, defaultBranchId, suppliers, brands, categories, products, canSaveLevels }: {
  branches: { id: string; code: string; name: string }[]; defaultBranchId: string;
  suppliers: Opt[]; brands: Opt[]; categories: Opt[]; products: PickerProduct[]; canSaveLevels: boolean;
}) {
  const router = useRouter();
  const [branchId, setBranchId] = React.useState(defaultBranchId);
  const [supplierIds, setSupplierIds] = React.useState<string[]>([]);
  const [brandIds, setBrandIds] = React.useState<string[]>([]);
  const [categoryIds, setCategoryIds] = React.useState<string[]>([]);
  const [productIds, setProductIds] = React.useState<string[]>([]);
  const [months, setMonths] = React.useState<6 | 9 | 12>(12);
  const [basis, setBasis] = React.useState<Basis>("sales");
  // Defaults: suppliers deliver in 3 days; an order covers 14 days of demand.
  const [lead, setLead] = React.useState("3");
  const [safety, setSafety] = React.useState("7");
  const [cover, setCover] = React.useState("14");
  const [rows, setRows] = React.useState<Row[] | null>(null);
  // The header branch and this picker stay in step (a new branch needs a new calculation).
  useBranchFollow((id) => { if (branches.some((b) => b.id === id)) { setBranchId(id); setRows(null); } });
  const [showAll, setShowAll] = React.useState(false);
  const [expected, setExpected] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [remember, setRemember] = React.useState(true);
  const [busy, setBusy] = React.useState<null | "gen" | "create" | "levels" | "add">(null);
  const [error, setError] = React.useState<string | null>(null);
  const supName = new Map(suppliers.map((s) => [s.id, s.name]));
  const productOpts = products.map((p) => ({ id: p.id, name: p.name, hint: p.sku }));

  const params = () => ({
    months, basis, leadDays: Number(lead || 0), safetyDays: Number(safety || 0), coverDays: Number(cover || 0),
  });
  const toRow = (r: SuggestionRow, qty?: number): Row => ({ ...r, key: key(), qty: String(qty ?? r.suggested), supplier: r.supplier_id ?? NO_SUP });

  async function generate() {
    setError(null); setBusy("gen");
    const res = await suggestOrder({ branchId, ...params(), supplierIds, brandIds, categoryIds, productIds });
    setBusy(null);
    if (!res.ok) { setError(res.error); return; }
    setRows(res.rows.map((r) => toRow(r)));
    const need = res.rows.filter((r) => r.suggested > 0).length;
    toast.success(need ? `${need} product${need === 1 ? "" : "s"} need ordering.` : "Nothing needs ordering with these settings.");
  }

  async function addProduct(id: string) {
    if (!id || !rows) return;
    const existing = rows.find((r) => r.product_id === id);
    if (existing) { if (Number(existing.qty) <= 0) setRow(existing.key, { qty: "1" }); setShowAll(true); toast.info("Already on the list."); return; }
    setBusy("add");
    const res = await suggestOrder({ branchId, ...params(), productIds: [id] });
    setBusy(null);
    if (!res.ok || res.rows.length === 0) { toast.error(res.ok ? "This product cannot be ordered (inactive or not stocked)." : res.error); return; }
    setRows([...rows, toRow(res.rows[0], Math.max(res.rows[0].suggested, res.rows[0].min_last5 ?? 1, 1))]);
  }

  const setRow = (k: string, patch: Partial<Row>) => setRows((rs) => rs && rs.map((r) => (r.key === k ? { ...r, ...patch } : r)));
  const visible = (rows ?? []).filter((r) => showAll || Number(r.qty) > 0 || r.suggested > 0);
  const ordering = (rows ?? []).filter((r) => Number(r.qty) > 0);
  const noSupplier = ordering.filter((r) => r.supplier === NO_SUP);
  const supplierCount = new Set(ordering.filter((r) => r.supplier !== NO_SUP).map((r) => r.supplier)).size;

  // Group the visible lines by the supplier they will be ordered from.
  const byGroup = new Map<string, Row[]>();
  for (const r of visible) byGroup.set(r.supplier, [...(byGroup.get(r.supplier) ?? []), r]);
  const groups = Array.from(byGroup.entries())
    .sort(([a], [b]) => (a === NO_SUP ? -1 : b === NO_SUP ? 1 : (supName.get(a) ?? "").localeCompare(supName.get(b) ?? "")));

  async function create() {
    setError(null);
    if (ordering.length === 0) { setError("Nothing to order: every quantity is zero."); return; }
    if (noSupplier.length) { setError(`Choose a supplier for ${noSupplier.length} product${noSupplier.length === 1 ? "" : "s"} (shown first).`); return; }
    if (ordering.some((r) => !Number.isFinite(Number(r.qty)) || Number(r.qty) < 0)) { setError("Quantities must be numbers."); return; }
    setBusy("create");
    const res = await createOrdersFromSuggestion({
      branchId, params: params(), expectedDate: expected || null, notes, rememberSuppliers: remember,
      lines: ordering.map((r) => ({
        product_id: r.product_id, supplier_id: r.supplier, quantity: Number(r.qty),
        avg_monthly: r.avg_monthly, reorder_level: r.reorder_level, on_hand: r.on_hand, suggested_qty: r.suggested,
      })),
    });
    setBusy(null);
    if (!res.ok) { setError(res.error); return; }
    toast.success(`${res.ids.length} draft purchase order${res.ids.length === 1 ? "" : "s"} created — check and confirm ${res.ids.length === 1 ? "it" : "each"}.`);
    router.push(res.ids.length === 1 ? `/purchases/orders/${res.ids[0]}` : "/purchases/orders?status=draft");
  }

  async function saveLevels() {
    if (!rows) return;
    setBusy("levels");
    const res = await saveReorderLevels(rows.filter((r) => r.reorder_level !== r.current_reorder_level).map((r) => ({ product_id: r.product_id, reorder_level: r.reorder_level })));
    setBusy(null);
    if (!res.ok) toast.error(res.error ?? "Failed."); else {
      toast.success(res.message ?? "Saved.");
      setRows(rows.map((r) => ({ ...r, current_reorder_level: r.reorder_level })));
    }
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="space-y-4 p-5">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <div className="space-y-1.5"><Label>Branch</Label>
            <Select value={branchId} onValueChange={(v) => { setBranchId(v); setRows(null); followPageBranch(v, router.refresh); }}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.code} — {b.name}</SelectItem>)}</SelectContent></Select></div>
          <MultiPick label="Supplier" options={suppliers} value={supplierIds} onChange={setSupplierIds} placeholder="All suppliers" />
          <MultiPick label="Brand" options={brands} value={brandIds} onChange={setBrandIds} placeholder="All brands" />
          <MultiPick label="Category" options={categories} value={categoryIds} onChange={setCategoryIds} placeholder="All categories" />
          <div className="md:col-span-4"><MultiPick label="Products (optional)" options={productOpts} value={productIds} onChange={setProductIds} placeholder="All products matching the filters" /></div>
        </div>
        <div className="grid grid-cols-2 gap-4 border-t border-border pt-4 md:grid-cols-5">
          <div className="space-y-1.5"><Label>Average over</Label>
            <Select value={String(months)} onValueChange={(v) => setMonths(Number(v) as 6 | 9 | 12)}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="6">6 months</SelectItem><SelectItem value="9">9 months</SelectItem><SelectItem value="12">12 months</SelectItem></SelectContent></Select></div>
          <div className="space-y-1.5"><Label>Based on</Label>
            <Select value={basis} onValueChange={(v) => setBasis(v as Basis)}><SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="sales">Sales (what goes out)</SelectItem><SelectItem value="purchases">Past purchases (what was ordered)</SelectItem></SelectContent></Select></div>
          <div className="space-y-1.5"><Label htmlFor="g-lead">Lead time (days)</Label><Input id="g-lead" type="number" min="0" step="1" value={lead} onChange={(e) => setLead(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="g-safety">Safety stock (days)</Label><Input id="g-safety" type="number" min="0" step="1" value={safety} onChange={(e) => setSafety(e.target.value)} /></div>
          <div className="space-y-1.5"><Label htmlFor="g-cover">Order covers (days)</Label><Input id="g-cover" type="number" min="0" step="1" value={cover} onChange={(e) => setCover(e.target.value)} /></div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="flex max-w-3xl items-start gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Average per month = quantity over the period ÷ months (shorter when the product has less history at this branch). Reorder level = daily average × (lead time + safety stock).
            Suggested = daily average × (lead + safety + cover) − on hand − in transit − already on open orders, rounded up; when something is needed it is never below the smallest quantity of the last 5 purchases.</p>
          <Button onClick={generate} disabled={busy !== null || !branchId}><Sparkles className="h-4 w-4" /> {busy === "gen" ? "Calculating..." : rows ? "Recalculate" : "Generate order"}</Button>
        </div>
      </CardContent></Card>

      {rows && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{ordering.length}</span> products to order from <span className="font-medium text-foreground">{supplierCount}</span> supplier{supplierCount === 1 ? "" : "s"}
              {noSupplier.length > 0 && <span className="text-destructive"> · {noSupplier.length} without a supplier</span>}
              {" "}· {rows.length} checked
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show products that need no order</label>
              <div className="w-72"><ProductPicker products={products} value="" onChange={addProduct} placeholder={busy === "add" ? "Adding..." : "+ Add a product"} /></div>
            </div>
          </div>

          {groups.length === 0 ? (
            <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Nothing needs ordering. Tick “Show products that need no order” or add products by hand.</CardContent></Card>
          ) : groups.map(([sid, list]) => (
            <Card key={sid} className={sid === NO_SUP ? "border-destructive/40" : ""}>
              <CardContent className="p-0">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
                  <p className="font-semibold">{sid === NO_SUP ? <span className="text-destructive">No supplier yet — choose one per line</span> : supName.get(sid) ?? "Supplier"}</p>
                  <p className="text-xs text-muted-foreground">{list.filter((r) => Number(r.qty) > 0).length} lines · {formatQuantity(list.reduce((a, r) => a + (Number(r.qty) || 0), 0))} units</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40 text-[11px] uppercase text-muted-foreground">
                      <tr>
                        <th className="px-2 py-2 text-left">Product</th>
                        <th className="px-2 py-2 text-right" title="Average per month">Avg 6m</th>
                        <th className="px-2 py-2 text-right">Avg 9m</th>
                        <th className="px-2 py-2 text-right">Avg 12m</th>
                        <th className="px-2 py-2 text-right">Avg used</th>
                        <th className="px-2 py-2 text-right">Reorder lvl</th>
                        <th className="px-2 py-2 text-right">On hand</th>
                        <th className="px-2 py-2 text-right">In transit</th>
                        <th className="px-2 py-2 text-right">On order</th>
                        <th className="px-2 py-2 text-right">Suggested</th>
                        <th className="px-2 py-2 text-right">Order qty</th>
                        <th className="px-2 py-2 text-left">Supplier</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r) => {
                        const low = r.on_hand + r.in_transit + r.on_order <= r.reorder_level && r.reorder_level > 0;
                        return (
                          <tr key={r.key} className="border-t border-border">
                            <td className="px-2 py-1.5 min-w-[200px]"><span className="font-medium">{r.name}</span>
                              <span className="block text-[11px] text-muted-foreground">{[r.sku, r.brand, r.category].filter(Boolean).join(" · ")}{r.history_months < months ? ` · ${r.history_months} mo history` : ""}</span></td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{q(r.avg_6)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{q(r.avg_9)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{q(r.avg_12)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums font-medium" title={`Over ${r.months_used} months`}>{q(r.avg_monthly)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums" title={`Saved on product: ${formatQuantity(r.current_reorder_level)}`}>{q(r.reorder_level)}
                              {r.current_reorder_level !== r.reorder_level && <span className="block text-[10px] text-muted-foreground">now {formatQuantity(r.current_reorder_level)}</span>}</td>
                            <td className={`px-2 py-1.5 text-right tabular-nums ${low ? "font-medium text-destructive" : ""}`}>{q(r.on_hand)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{q(r.in_transit)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{q(r.on_order)}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums" title={r.min_last5 !== null ? `Smallest of the last 5 purchases: ${formatQuantity(r.min_last5)}` : "Not bought at this branch before"}>{q(r.suggested)}
                              {r.suggested > r.need && <span className="block text-[10px] text-muted-foreground">need {formatQuantity(r.need)} · last-5 min {formatQuantity(r.min_last5 ?? 0)}</span>}</td>
                            <td className="px-1 py-1"><Input aria-label={`Order quantity for ${r.name}`} className="ml-auto h-8 w-20 text-right tabular-nums" type="number" min="0" step="1"
                              value={r.qty} onChange={(e) => setRow(r.key, { qty: e.target.value })} /></td>
                            <td className="px-1 py-1 min-w-[170px]">
                              <Select value={r.supplier} onValueChange={(v) => setRow(r.key, { supplier: v })}>
                                <SelectTrigger className={`h-8 ${r.supplier === NO_SUP ? "border-destructive/60" : ""}`}><SelectValue /></SelectTrigger>
                                <SelectContent><SelectItem value={NO_SUP}>— Choose supplier —</SelectItem>{suppliers.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
                              </Select>
                            </td>
                            <td className="px-1 py-1 text-center"><button type="button" aria-label={`Remove ${r.name}`} onClick={() => setRows((rs) => rs && rs.filter((x) => x.key !== r.key))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          ))}

          <Card><CardContent className="grid grid-cols-1 gap-4 p-5 md:grid-cols-[200px_1fr]">
            <div className="space-y-1.5"><Label htmlFor="g-exp">Expected delivery</Label><Input id="g-exp" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
            <div className="space-y-1.5"><Label htmlFor="g-notes">Notes to supplier</Label><Textarea id="g-notes" rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional; printed on every order" /></div>
            <label className="flex items-center gap-2 text-sm md:col-span-2"><input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember the chosen supplier for these products next time</label>
          </CardContent></Card>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {error && <p className="mr-auto rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
            {canSaveLevels && <Button variant="outline" onClick={saveLevels} disabled={busy !== null}>{busy === "levels" ? "Saving..." : "Save reorder levels to products"}</Button>}
            <Button onClick={create} disabled={busy !== null || ordering.length === 0}>{busy === "create" ? "Creating..." : `Create ${Math.max(supplierCount, 1)} purchase order${supplierCount === 1 ? "" : "s"}`}</Button>
          </div>
        </>
      )}
    </div>
  );
}
