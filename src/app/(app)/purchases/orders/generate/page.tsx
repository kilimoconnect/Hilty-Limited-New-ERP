import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { flattenProducts } from "@/lib/products";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { OrderGenerator } from "./generator";

export const metadata: Metadata = { title: "Generate Purchase Orders" };

export default async function GenerateOrdersPage() {
  await requirePermissionPage("purchases.order");
  const ctx = await getActiveContext();
  if (!ctx.branchId) return <div><PageHeader title="Generate Purchase Orders" /><EmptyState title="No active branch" /></div>;
  const admin = createAdminClient();
  const [{ data: suppliers }, { data: brands }, { data: categories }, { data: products }] = await Promise.all([
    admin.from("suppliers").select("id, name, phone").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("brands").select("id, name").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("product_categories").select("id, name, description").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("products").select("id, sku, barcode, name, category:product_categories(name), brand:brands(name)")
      .eq("company_id", ctx.companyId).eq("is_active", true).eq("track_inventory", true).order("name"),
  ]);
  return (
    <div>
      <PageHeader title="Generate Purchase Orders"
        description="Choose the suppliers, brands, categories or products, then generate. Quantities come from the average of past months; change, remove or add lines, then create one order per supplier. Orders carry quantities only, no prices." />
      <OrderGenerator branches={ctx.branches} defaultBranchId={ctx.branchId}
        suppliers={(suppliers ?? []).map((s) => ({ id: s.id, name: s.name, hint: s.phone }))}
        brands={brands ?? []} categories={(categories ?? []).map((c) => ({ id: c.id, name: c.name, hint: c.description }))}
        products={flattenProducts(products)} canSaveLevels={ctx.user.isOwner || can(ctx.user, "inventory.manage")} />
    </div>
  );
}
