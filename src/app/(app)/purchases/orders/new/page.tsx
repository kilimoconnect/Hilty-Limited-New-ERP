import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { flattenProducts } from "@/lib/products";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { OrderEditor } from "@/components/purchases/order-editor";

export const metadata: Metadata = { title: "New Purchase Order" };

export default async function NewOrderPage() {
  await requirePermissionPage("purchases.order");
  const ctx = await getActiveContext();
  if (!ctx.branchId) return <div><PageHeader title="New Purchase Order" /><EmptyState title="No active branch" /></div>;
  const branch = ctx.branches.find((b) => b.id === ctx.branchId);
  const admin = createAdminClient();
  const [{ data: suppliers }, { data: products }] = await Promise.all([
    admin.from("suppliers").select("id, code, name, phone").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("products").select("id, sku, barcode, name, unit:units(symbol), category:product_categories(name), brand:brands(name)")
      .eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
  ]);
  return (
    <div>
      <PageHeader title="New Purchase Order" description={`Branch: ${branch ? `${branch.code} — ${branch.name}` : "—"}. Quantities only; prices are entered when the goods arrive.`} />
      <OrderEditor branchId={ctx.branchId} suppliers={suppliers ?? []}
        products={flattenProducts(products).map((p) => ({ ...p, unit: (p.unit as unknown as { symbol: string | null } | null)?.symbol ?? null }))} />
    </div>
  );
}
