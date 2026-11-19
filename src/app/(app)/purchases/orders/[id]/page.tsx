import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { flattenProducts } from "@/lib/products";
import { expireOrders } from "@/lib/purchases/order-actions";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { OrderStatusBadge, daysLeft } from "@/components/purchases/order-status";
import { OrderEditor } from "@/components/purchases/order-editor";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";
import { OrderActions } from "./order-actions";

export const metadata: Metadata = { title: "Purchase Order" };

type Line = { id: string; product_id: string; description: string | null; quantity: number; qty_received: number; avg_monthly: number | null; reorder_level: number | null; on_hand: number | null; suggested_qty: number | null; note: string | null; line_no: number;
  product: { sku: string; name: string; unit: { symbol: string | null } | null; brand: { name: string } | null } | null };

export default async function OrderPage(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermissionPage("purchases.view");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const sp = await props.searchParams;
  const admin = createAdminClient();
  await expireOrders(ctx.companyId);
  const { data: o } = await admin.from("purchase_orders")
    .select("*, supplier:suppliers(name, phone, email), branch:branches(code, name), lines:purchase_order_lines(*, product:products(sku, name, unit:units(symbol), brand:brands(name)))")
    .eq("id", id).maybeSingle();
  if (!o || o.company_id !== ctx.companyId) notFound();
  if (!ctx.user.isOwner && !ctx.user.branchIds.includes(o.branch_id)) notFound();
  const lines = ((o.lines ?? []) as Line[]).sort((a, b) => a.line_no - b.line_no);
  const canOrder = can(ctx.user, "purchases.order");

  const { data: purchases } = await admin.from("purchases")
    .select("id, document_number, document_date, document_status, grand_total, supplier_invoice_number")
    .eq("purchase_order_id", id).order("document_date");
  const hasReceipts = (purchases ?? []).some((p) => p.document_status === "posted");

  // Edit a draft in place.
  if (sp.edit === "1" && o.status === "draft" && canOrder) {
    const [{ data: suppliers }, { data: products }] = await Promise.all([
      admin.from("suppliers").select("id, code, name, phone").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
      admin.from("products").select("id, sku, barcode, name, unit:units(symbol), category:product_categories(name), brand:brands(name)").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    ]);
    return (
      <div>
        <PageHeader title={`Edit ${o.document_number}`} description={`Branch: ${o.branch?.code} — ${o.branch?.name}`} />
        <OrderEditor branchId={o.branch_id} suppliers={suppliers ?? []}
          products={flattenProducts(products).map((p) => ({ ...p, unit: (p.unit as unknown as { symbol: string | null } | null)?.symbol ?? null }))}
          initial={{ id, supplierId: o.supplier_id, orderDate: o.order_date, expectedDate: o.expected_date, reference: o.reference, notes: o.notes,
            lines: lines.map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), note: l.note, avg_monthly: l.avg_monthly === null ? null : Number(l.avg_monthly), on_hand: l.on_hand === null ? null : Number(l.on_hand), suggested_qty: l.suggested_qty === null ? null : Number(l.suggested_qty) })) }} />
      </div>
    );
  }

  const open = ["draft", "confirmed", "partially_received"].includes(o.status);
  const left = daysLeft(o.expires_at);
  const generated = lines.some((l) => l.avg_monthly !== null);
  const tot = lines.reduce((a, l) => ({ q: a.q + Number(l.quantity), r: a.r + Math.min(Number(l.qty_received), Number(l.quantity)) }), { q: 0, r: 0 });

  return (
    <div className="space-y-4">
      <PageHeader title={`Purchase Order ${o.document_number ?? ""}`}
        description={`${o.supplier?.name ?? ""} · ${o.branch?.code} — ${o.branch?.name}`}
        actions={<OrderActions id={id} status={o.status} canOrder={canOrder} canReceive={can(ctx.user, "purchases.create")} hasReceipts={hasReceipts} />} />

      <Card><CardContent className="grid grid-cols-2 gap-4 p-5 text-sm md:grid-cols-5">
        <Field label="Status"><OrderStatusBadge status={o.status} /></Field>
        <Field label="Order date">{formatDate(o.order_date)}</Field>
        <Field label="Expected delivery">{o.expected_date ? formatDate(o.expected_date) : "—"}</Field>
        <Field label={open ? "Pending until" : o.status === "closed" ? "Closed" : "Confirmed"}>
          {open ? <span className={left <= 5 ? "text-destructive" : ""}>{formatDate(o.expires_at.slice(0, 10))} ({left} day{left === 1 ? "" : "s"})</span>
            : o.status === "closed" ? `${o.closed_at ? formatDate(o.closed_at.slice(0, 10)) : ""}${o.close_reason ? ` — ${o.close_reason}` : ""}`
            : o.confirmed_at ? formatDate(o.confirmed_at.slice(0, 10)) : "—"}
        </Field>
        <Field label="Reference">{o.reference ?? "—"}</Field>
        {o.notes && <div className="col-span-2 md:col-span-5"><Field label="Notes to supplier">{o.notes}</Field></div>}
        {generated && o.basis && (
          <p className="col-span-2 text-xs text-muted-foreground md:col-span-5">
            Suggested from {o.basis === "sales" ? "sales" : "past purchases"} averaged over {o.basis_months} months · lead {o.lead_days} days, safety {o.safety_days} days, cover {o.cover_days} days.
          </p>
        )}
      </CardContent></Card>

      {o.status === "draft" && (
        <p className="rounded-md bg-muted px-4 py-2.5 text-sm">This order is a draft. Check the quantities (Edit), then <span className="font-medium">Confirm order</span> to print it or save it as PDF for the supplier.</p>
      )}

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow>
            <TableHead className="w-10">#</TableHead><TableHead>Product</TableHead>
            {generated && <><TableHead className="text-right">Avg / month</TableHead><TableHead className="text-right">On hand</TableHead><TableHead className="text-right">Suggested</TableHead></>}
            <TableHead className="text-right">Ordered</TableHead><TableHead className="text-right">Received</TableHead><TableHead className="text-right">Pending</TableHead><TableHead>Note</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {lines.map((l, i) => {
              const pend = Math.max(Number(l.quantity) - Number(l.qty_received), 0);
              return (
                <TableRow key={l.id}>
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell><span className="font-medium">{l.product?.name ?? l.description}</span>
                    <span className="block text-xs text-muted-foreground">{[l.product?.sku, l.product?.brand?.name, l.product?.unit?.symbol].filter(Boolean).join(" · ")}</span></TableCell>
                  {generated && <>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{l.avg_monthly === null ? "—" : formatQuantity(Number(l.avg_monthly))}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{l.on_hand === null ? "—" : formatQuantity(Number(l.on_hand))}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{l.suggested_qty === null ? "—" : formatQuantity(Number(l.suggested_qty))}</TableCell>
                  </>}
                  <TableCell className="text-right font-medium tabular-nums">{formatQuantity(Number(l.quantity))}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(Number(l.qty_received))}</TableCell>
                  <TableCell className={`text-right tabular-nums ${pend > 0 && o.status !== "draft" ? "font-medium" : "text-muted-foreground"}`}>{formatQuantity(pend)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{l.note ?? ""}</TableCell>
                </TableRow>
              );
            })}
            <TableRow className="border-t-2 font-semibold">
              <TableCell /><TableCell>Total</TableCell>{generated && <><TableCell /><TableCell /><TableCell /></>}
              <TableCell className="text-right tabular-nums">{formatQuantity(tot.q)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatQuantity(tot.r)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatQuantity(Math.max(tot.q - tot.r, 0))}</TableCell><TableCell />
            </TableRow>
          </TableBody>
        </Table>
      </Card>

      <Card><CardContent className="p-5">
        <h3 className="mb-2 font-semibold">Deliveries (purchases)</h3>
        {(purchases ?? []).length === 0 ? <p className="text-sm text-muted-foreground">Nothing received yet.{open && o.status !== "draft" ? " Use Receive goods when the delivery arrives." : ""}</p> : (
          <Table>
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Purchase</TableHead><TableHead>Supplier bill</TableHead><TableHead className="text-right">Total</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
            <TableBody>
              {(purchases ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-sm">{formatDate(p.document_date)}</TableCell>
                  <TableCell><Link href={`/purchases/${p.id}`} className="font-mono text-xs underline">{p.document_number ?? "Draft"}</Link></TableCell>
                  <TableCell className="text-sm">{p.supplier_invoice_number ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(Number(p.grand_total))}</TableCell>
                  <TableCell><DocStatusBadge status={p.document_status} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent></Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><div className="mt-0.5">{children}</div></div>;
}
