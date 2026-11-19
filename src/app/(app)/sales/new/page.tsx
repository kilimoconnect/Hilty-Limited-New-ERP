import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { branchPaymentOptions } from "@/lib/payment-methods";
import { flattenProducts } from "@/lib/products";
import { PageHeader } from "@/components/ui/page-header";
import { branchStep } from "@/lib/branch-step";
import { BranchChoice } from "@/components/layout/branch-choice";
import { EmptyState } from "@/components/ui/empty-state";
import { SaleForm } from "./sale-form";

export const metadata: Metadata = { title: "Create Sale" };

export default async function NewSalePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermissionPage("sales.create");
  const base = await getActiveContext();
  const step = branchStep(base, await props.searchParams);
  if (step.choose) return <BranchChoice title="Create Sale" branches={base.branches} current={base.branchId} />;
  const ctx = step.ctx;
  const branch = ctx.branches.find((b) => b.id === ctx.branchId);
  const many = ctx.branches.length > 1;
  const admin = createAdminClient();

  if (!ctx.branchId) {
    return (
      <div>
        <PageHeader title="Create Sale" />
        <EmptyState title="No active branch" description="You need an assigned branch to create sales." />
      </div>
    );
  }

  const [{ data: products }, { data: taxCodes }, branchAccounts, { data: customers }, { data: bals }] = await Promise.all([
    admin.from("products").select("id, sku, barcode, name, selling_price, tax_code_id, track_inventory, category:product_categories(name), brand:brands(name)").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("tax_codes").select("id, name, rate, is_inclusive").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    branchPaymentOptions(ctx.companyId, ctx.branchId),
    admin.from("customers").select("id, code, name, phone, is_protected").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("stock_balances").select("product_id, quantity, avg_unit_cost").eq("company_id", ctx.companyId).eq("branch_id", ctx.branchId),
  ]);

  const stock: Record<string, number> = {};
  // Weighted average cost is shown to the Owner only (like gross profit).
  const wac: Record<string, number> = {};
  for (const b of bals ?? []) { stock[b.product_id] = Number(b.quantity); if (ctx.user.isOwner) wac[b.product_id] = Number(b.avg_unit_cost); }
  const walkIn = (customers ?? []).find((c) => c.is_protected);

  return (
    <div>
      <PageHeader title="Sales" />
      <SaleForm
        branchId={ctx.branchId}
        branchLabel={branch ? `${branch.code} — ${branch.name}` : ""}
        canChangeBranch={many}
        wac={wac}
        products={flattenProducts(products)}
        taxCodes={(taxCodes ?? []).map((t) => ({ ...t, rate: Number(t.rate) })) as never}
        accounts={branchAccounts as never}
        customers={(customers ?? []) as never}
        stock={stock}
        canViewCost={ctx.user.isOwner}
        walkInId={walkIn?.id ?? null}
      />
    </div>
  );
}
