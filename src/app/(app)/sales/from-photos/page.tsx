import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { branchPaymentOptions } from "@/lib/payment-methods";
import { PageHeader } from "@/components/ui/page-header";
import { branchStep } from "@/lib/branch-step";
import { BranchChoice, ChosenBranch } from "@/components/layout/branch-choice";
import { EmptyState } from "@/components/ui/empty-state";
import { PhotoImport } from "./photo-import";

export const metadata: Metadata = { title: "Sales from Photos" };

export default async function SalesFromPhotosPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermissionPage("sales.create");
  const base = await getActiveContext();
  const step = branchStep(base, await props.searchParams);
  if (step.choose) return <BranchChoice title="Sales from Photos" branches={base.branches} current={base.branchId} />;
  const ctx = step.ctx;
  if (!ctx.branchId) return <div><PageHeader title="Sales from Photos" /><EmptyState title="No active branch" /></div>;
  const branch = ctx.branches.find((b) => b.id === ctx.branchId);
  const admin = createAdminClient();
  const [{ data: products }, accounts, { data: categories }] = await Promise.all([
    admin.from("products").select("id, sku, name, selling_price").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    branchPaymentOptions(ctx.companyId, ctx.branchId),
    admin.from("expense_categories").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
  ]);

  return (
    <div>
      <PageHeader title="Sales from Photos"
        description={<><ChosenBranch branch={branch} canChange={ctx.branches.length > 1} /> · Photograph the day&apos;s cash-sale receipts and notebook page. Receipts that add up become sale drafts with payments; the rest you enter by hand.</>} />
      <PhotoImport
        branchId={ctx.branchId}
        products={(products ?? []).map((p) => ({ id: p.id, sku: p.sku, name: p.name, price: Number(p.selling_price) }))}
        accounts={accounts.map((a) => ({ id: a.id, code: String(a.code ?? ""), name: a.name }))}
        categories={(categories ?? []).map((c) => ({ id: c.id, name: c.name }))}
        canExpense={can(ctx.user, "expenses.create")}
      />
    </div>
  );
}
