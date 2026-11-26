import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { BackButton } from "@/components/common/back-button";
import { SaleForm } from "../../new/sale-form";
import { loadSaleFormData } from "../../new/load-form";

export const metadata: Metadata = { title: "Edit Sale Draft" };

export default async function EditSaleDraftPage(props: { params: Promise<{ id: string }> }) {
  await requirePermissionPage("sales.edit_draft");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const admin = createAdminClient();

  const { data: sale } = await admin.from("sales")
    .select("id, company_id, branch_id, document_status, document_date, due_date, customer_id, customer_reference, amends_sale_id")
    .eq("id", id).maybeSingle();
  if (!sale || sale.company_id !== ctx.companyId) notFound();
  if (sale.document_status !== "draft") redirect(`/sales/${id}`);
  const branch = ctx.branches.find((b) => b.id === sale.branch_id);
  if (!branch) notFound();

  const { data: corrects } = sale.amends_sale_id
    ? await admin.from("sales").select("document_number").eq("id", sale.amends_sale_id).maybeSingle()
    : { data: null };

  const [{ data: lines }, { data: payments }, data] = await Promise.all([
    admin.from("sale_lines").select("product_id, quantity, unit_price, tax_code_id").eq("sale_id", id).order("line_no"),
    admin.from("sale_payments").select("payment_account_id, amount").eq("sale_id", id),
    loadSaleFormData(ctx.companyId, sale.branch_id, ctx.user.isOwner),
  ]);
  // A correction: the original's items go back into stock when it is posted, so they count as available.
  if (sale.amends_sale_id && sale.branch_id) {
    const { data: orig } = await admin.from("sale_lines").select("product_id, quantity, track_inventory").eq("sale_id", sale.amends_sale_id);
    for (const l of orig ?? []) if (l.product_id && l.track_inventory) data.stock[l.product_id] = (data.stock[l.product_id] ?? 0) + Number(l.quantity);
  }

  return (
    <div>
      <BackButton href={`/sales/${id}`} label="Draft" />
      <PageHeader title={corrects ? `Correct sale ${corrects.document_number}` : "Edit Sale Draft"} />
      {corrects && (
        <p className="mb-3 rounded-md border border-primary/40 bg-primary/5 px-4 py-2 text-sm">
          Posting this replaces <span className="font-medium">{corrects.document_number}</span>: the original is reversed (stock and accounts) and this sale keeps the number {corrects.document_number}.
        </p>
      )}
      <SaleForm
        branchId={sale.branch_id}
        branchLabel={`${branch.code} — ${branch.name}`}
        {...data}
        correctionOf={corrects?.document_number ?? null}
        initial={{
          saleId: id,
          documentDate: sale.document_date,
          dueDate: sale.due_date,
          customerId: sale.customer_id,
          walkInName: sale.customer_reference ?? "",
          lines: (lines ?? []).filter((l) => l.product_id).map((l) => ({
            product_id: l.product_id as string, quantity: Number(l.quantity), unit_price: Number(l.unit_price), tax_code_id: l.tax_code_id,
          })),
          payments: (payments ?? []).map((p) => ({ payment_account_id: p.payment_account_id, amount: Number(p.amount) })),
        }}
      />
    </div>
  );
}
