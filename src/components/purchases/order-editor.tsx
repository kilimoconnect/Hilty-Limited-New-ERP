"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { saveOrder } from "@/lib/purchases/order-actions";
import { formatQuantity, todayISO } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { ProductPicker, type PickerProduct } from "@/components/common/product-picker";
import { SearchSelect } from "@/components/common/search-select";

export interface EditorLine { product_id: string; quantity: number; note?: string | null; avg_monthly?: number | null; on_hand?: number | null; suggested_qty?: number | null }
interface Row { key: string; product_id: string; quantity: string; note: string; avg_monthly: number | null; on_hand: number | null; suggested_qty: number | null }
const key = () => Math.random().toString(36).slice(2);

/** Create or edit a draft purchase order by hand: quantities only, no prices. */
export function OrderEditor({ branchId, suppliers, products, initial }: {
  branchId: string;
  suppliers: { id: string; code: string; name: string; phone?: string | null }[];
  products: (PickerProduct & { unit?: string | null })[];
  initial?: { id: string; supplierId: string; orderDate: string; expectedDate: string | null; reference: string | null; notes: string | null; lines: EditorLine[] };
}) {
  const router = useRouter();
  const pMap = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const [supplierId, setSupplierId] = React.useState(initial?.supplierId ?? "");
  const [orderDate, setOrderDate] = React.useState(initial?.orderDate ?? todayISO());
  const [expected, setExpected] = React.useState(initial?.expectedDate ?? "");
  const [reference, setReference] = React.useState(initial?.reference ?? "");
  const [notes, setNotes] = React.useState(initial?.notes ?? "");
  const [rows, setRows] = React.useState<Row[]>(() => (initial?.lines ?? []).map((l) => ({
    key: key(), product_id: l.product_id, quantity: String(l.quantity), note: l.note ?? "",
    avg_monthly: l.avg_monthly ?? null, on_hand: l.on_hand ?? null, suggested_qty: l.suggested_qty ?? null,
  })));
  const [pending, setPending] = React.useState(false);
  const [errors, setErrors] = React.useState<string[]>([]);
  const hasSuggestion = rows.some((r) => r.avg_monthly !== null);
  const set = (k: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === k ? { ...r, ...patch } : r)));

  function add(id: string) {
    if (!id) return;
    if (rows.some((r) => r.product_id === id)) { toast.info("Already on the order — change its quantity."); return; }
    setRows((rs) => [...rs, { key: key(), product_id: id, quantity: "1", note: "", avg_monthly: null, on_hand: null, suggested_qty: null }]);
  }

  async function save() {
    const missing: string[] = [];
    if (!supplierId) missing.push("Supplier required.");
    if (rows.length === 0) missing.push("Add at least one product.");
    if (rows.some((r) => !(Number(r.quantity) > 0))) missing.push("Every quantity must be greater than zero (remove lines you do not need).");
    setErrors(missing);
    if (missing.length) return;
    setPending(true);
    const res = await saveOrder({
      orderId: initial?.id, branchId, supplierId, orderDate, expectedDate: expected || null, reference, notes,
      lines: rows.map((r) => ({ product_id: r.product_id, quantity: Number(r.quantity), note: r.note })),
    });
    setPending(false);
    if (!res.ok || !res.id) { setErrors([res.error ?? "Failed."]); return; }
    toast.success("Order saved.");
    router.push(`/purchases/orders/${res.id}`);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <Card><CardContent className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-4">
        <div className="space-y-1.5 sm:col-span-2"><Label>Supplier <span className="text-destructive">*</span></Label>
          <SearchSelect value={supplierId} onChange={setSupplierId} placeholder="Search supplier by name/phone"
            options={suppliers.map((s) => ({ id: s.id, label: s.name, hint: s.phone || s.code, search: `${s.code} ${s.phone ?? ""}` }))} /></div>
        <div className="space-y-1.5"><Label htmlFor="po-date">Order date</Label><Input id="po-date" type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} /></div>
        <div className="space-y-1.5"><Label htmlFor="po-exp">Expected delivery</Label><Input id="po-exp" type="date" value={expected} onChange={(e) => setExpected(e.target.value)} /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="po-ref">Reference</Label><Input id="po-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" /></div>
        <div className="space-y-1.5 sm:col-span-2"><Label htmlFor="po-notes">Notes to supplier</Label><Textarea id="po-notes" rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional; printed on the order" /></div>
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-4">
        <ProductPicker products={products} value="" onChange={add} placeholder="Search products to add" />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-2 py-2 text-left">Product</th>
                {hasSuggestion && <><th className="px-2 py-2 text-right">Avg / month</th><th className="px-2 py-2 text-right">On hand</th><th className="px-2 py-2 text-right">Suggested</th></>}
                <th className="px-2 py-2 text-right">Order qty</th>
                <th className="px-2 py-2 text-left">Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={hasSuggestion ? 7 : 4} className="px-2 py-8 text-center text-muted-foreground">Search products to add lines</td></tr>}
              {rows.map((r) => {
                const p = pMap.get(r.product_id);
                return (
                  <tr key={r.key} className="border-t border-border">
                    <td className="px-2 py-1.5"><span className="font-medium">{p?.name ?? "—"}</span><span className="block text-xs text-muted-foreground">{[p?.sku, p?.brand, p?.unit].filter(Boolean).join(" · ")}</span></td>
                    {hasSuggestion && <>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.avg_monthly !== null ? formatQuantity(r.avg_monthly) : "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.on_hand !== null ? formatQuantity(r.on_hand) : "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{r.suggested_qty !== null ? formatQuantity(r.suggested_qty) : "—"}</td>
                    </>}
                    <td className="px-1 py-1"><Input aria-label="Order quantity" className="ml-auto h-8 w-24 text-right tabular-nums" type="number" min="0" step="1" value={r.quantity} onChange={(e) => set(r.key, { quantity: e.target.value })} /></td>
                    <td className="px-1 py-1"><Input aria-label="Line note" className="h-8 min-w-[140px]" value={r.note} onChange={(e) => set(r.key, { note: e.target.value })} /></td>
                    <td className="px-1 py-1 text-center"><button type="button" aria-label="Remove line" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} className="text-muted-foreground hover:text-destructive"><Trash2 className="h-4 w-4" /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent></Card>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {errors.length > 0 && <ul className="mr-auto space-y-1 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{errors.map((e) => <li key={e}>⚠ {e}</li>)}</ul>}
        <Button variant="outline" onClick={() => router.back()} disabled={pending}>Cancel</Button>
        <Button onClick={save} disabled={pending}>{pending ? "Saving..." : "Save order"}</Button>
      </div>
    </div>
  );
}
