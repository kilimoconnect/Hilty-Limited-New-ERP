import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireActiveUser } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPrimaryCompanyId } from "@/lib/admin/queries";
import { formatQuantity, formatDate } from "@/lib/format";
import { PrintButton } from "@/components/print/print-button";

type Params = Promise<{ id: string }>;

export async function generateMetadata(props: { params: Params }): Promise<Metadata> {
  const { id } = await props.params;
  const { data } = await createAdminClient().from("purchase_orders").select("document_number, supplier:suppliers(name)").eq("id", id).maybeSingle();
  const sup = (data?.supplier as unknown as { name: string } | null)?.name;
  // The browser uses the title as the PDF file name.
  return { title: data ? `Purchase Order ${data.document_number}${sup ? ` - ${sup}` : ""}` : "Purchase Order" };
}

/** Printable purchase order for the supplier: quantities only, no prices. Print or "Save as PDF". */
export default async function PurchaseOrderPrintPage(props: { params: Params }) {
  const user = await requireActiveUser();
  const { id } = await props.params;
  const admin = createAdminClient();
  const companyId = await getPrimaryCompanyId(user.defaultCompanyId);
  if (!user.isOwner && !user.permissions.has("purchases.view")) notFound();

  const { data: o } = await admin.from("purchase_orders")
    .select("*, supplier:suppliers(code, name, phone, email, address, tin), branch:branches(name, code, address, phone, email), lines:purchase_order_lines(id, quantity, note, line_no, description, product:products(sku, name, unit:units(symbol)))")
    .eq("id", id).maybeSingle();
  if (!o || o.company_id !== companyId || o.status === "draft" || o.status === "cancelled") notFound();
  if (!user.isOwner && !user.branchIds.includes(o.branch_id)) notFound();

  const [{ data: company }, { data: by }] = await Promise.all([
    admin.from("companies").select("name, legal_name, address, phone, email").eq("id", companyId).single(),
    o.confirmed_by ? admin.from("user_profiles").select("full_name").eq("id", o.confirmed_by).maybeSingle() : Promise.resolve({ data: null }),
  ]);
  const sup = o.supplier as { code: string; name: string; phone: string | null; email: string | null; address: string | null; tin: string | null } | null;
  const br = o.branch as { name: string; code: string; address: string | null; phone: string | null; email: string | null } | null;
  const lines = ((o.lines ?? []) as Array<{ id: string; quantity: number; note: string | null; line_no: number; description: string | null; product: { sku: string; name: string; unit: { symbol: string | null } | null } | null }>)
    .sort((a, b) => a.line_no - b.line_no);
  const total = lines.reduce((a, l) => a + Number(l.quantity), 0);

  return (
    <div className="mx-auto max-w-3xl bg-white p-8 text-stone-900">
      <style>{`@media print { .no-print { display: none !important; } body { background: #fff; } } @page { margin: 14mm; }`}</style>

      <div className="mb-6 flex items-start justify-between gap-6">
        <div className="flex items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="h-14 w-auto" />
          <div>
            <h1 className="text-xl font-bold">{company?.name}</h1>
            {company?.legal_name && company.legal_name !== company.name && <p className="text-sm text-stone-600">{company.legal_name}</p>}
            {company?.address && <p className="text-sm text-stone-600">{company.address}</p>}
            <p className="text-sm text-stone-600">{[company?.phone, company?.email].filter(Boolean).join(" · ")}</p>
          </div>
        </div>
        <div className="text-right">
          <h2 className="text-lg font-bold">PURCHASE ORDER</h2>
          <p className="font-mono text-sm">{o.document_number}</p>
          <p className="text-sm text-stone-600">Date: {formatDate(o.order_date)}</p>
          {o.expected_date && <p className="text-sm text-stone-600">Deliver by: {formatDate(o.expected_date)}</p>}
          {o.reference && <p className="text-sm text-stone-600">Ref: {o.reference}</p>}
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 text-sm">
        <div className="rounded border border-stone-200 p-3">
          <p className="font-semibold">Supplier</p>
          <p>{sup?.name}</p>
          {sup?.address && <p className="text-stone-600">{sup.address}</p>}
          {(sup?.phone || sup?.email) && <p className="text-stone-600">{[sup?.phone, sup?.email].filter(Boolean).join(" · ")}</p>}
          {sup?.tin && <p className="text-stone-600">TIN: {sup.tin}</p>}
        </div>
        <div className="rounded border border-stone-200 p-3">
          <p className="font-semibold">Deliver to</p>
          <p>{company?.name} — {br?.name}</p>
          {br?.address && <p className="text-stone-600">{br.address}</p>}
          {(br?.phone || br?.email) && <p className="text-stone-600">{[br?.phone, br?.email].filter(Boolean).join(" · ")}</p>}
        </div>
      </div>

      <table className="mb-4 w-full text-sm">
        <thead>
          <tr className="border-b-2 border-stone-300 text-left">
            <th className="w-8 py-1.5">#</th>
            <th className="py-1.5">Item</th>
            <th className="py-1.5">Code</th>
            <th className="py-1.5">Unit</th>
            <th className="py-1.5 text-right">Quantity</th>
            <th className="py-1.5 pl-4">Note</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id} className="border-b border-stone-100">
              <td className="py-1.5 text-stone-500">{i + 1}</td>
              <td className="py-1.5">{l.product?.name ?? l.description}</td>
              <td className="py-1.5 font-mono text-xs text-stone-600">{l.product?.sku}</td>
              <td className="py-1.5 text-stone-600">{l.product?.unit?.symbol ?? ""}</td>
              <td className="py-1.5 text-right font-medium tabular-nums">{formatQuantity(Number(l.quantity))}</td>
              <td className="py-1.5 pl-4 text-stone-600">{l.note ?? ""}</td>
            </tr>
          ))}
          <tr className="border-t-2 border-stone-300 font-semibold">
            <td /><td className="py-1.5">{lines.length} item{lines.length === 1 ? "" : "s"}</td><td /><td />
            <td className="py-1.5 text-right tabular-nums">{formatQuantity(total)}</td><td />
          </tr>
        </tbody>
      </table>

      {o.notes && <div className="mb-6 rounded border border-stone-200 p-3 text-sm"><p className="font-semibold">Notes</p><p className="whitespace-pre-wrap text-stone-700">{o.notes}</p></div>}

      <p className="text-xs text-stone-600">Please supply the items above and quote the order number <span className="font-mono">{o.document_number}</span> on your delivery note and invoice. Prices are as agreed on your invoice.</p>

      <div className="mt-14 grid grid-cols-2 gap-10 text-sm">
        <div><div className="border-t border-stone-400 pt-1">Prepared / approved by{by?.full_name ? `: ${by.full_name}` : ""}</div></div>
        <div><div className="border-t border-stone-400 pt-1">Supplier acknowledgement</div></div>
      </div>

      <div className="no-print mt-8 flex justify-center gap-3"><PrintButton /></div>
      <p className="no-print mt-2 text-center text-xs text-stone-500">To send a PDF, choose “Save as PDF” as the printer.</p>
    </div>
  );
}
