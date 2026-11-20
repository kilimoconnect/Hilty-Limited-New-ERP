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
    .select("id, company_id, branch_id, document_status, document_date, due_date, customer_id, customer_reference")
    .eq("id", id).maybeSingle();
  if (!sale || sale.company_id !== ctx.companyId) notFound();
  if (sale.document_status !== "draft") redirect(`/sales/${id}`);
  const branch = ctx.branches.find((b) => b.id === sale.branch_id);
  if (!branch) notFound();

  const [{ data: lines }, { data: payments }, data] = await Promise.all([
    admin.from("sale_lines").select("product_id, quantity, unit_price, tax_code_id").eq("sale_id", id).order("line_no"),
    admin.from("sale_payments").select("payment_account_id, amount").eq("sale_id", id),
    loadSaleFormData(ctx.companyId, sale.branch_id, ctx.user.isOwner),
  ]);

  return (
    <div>
      <BackButton href={`/sales/${id}`} label="Draft" />
      <PageHeader title="Edit Sale Draft" />
      <SaleForm
        branchId={sale.branch_id}
        branchLabel={`${branch.code} — ${branch.name}`}
        {...data}
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
