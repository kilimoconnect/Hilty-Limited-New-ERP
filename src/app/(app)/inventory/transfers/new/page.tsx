import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { branchStep } from "@/lib/branch-step";
import { BranchChoice, ChosenBranch } from "@/components/layout/branch-choice";
import { EmptyState } from "@/components/ui/empty-state";
import { NewTransferForm } from "./new-transfer-form";

export const metadata: Metadata = { title: "New Transfer" };

export default async function NewTransferPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermissionPage("inventory.transfer_create");
  const base = await getActiveContext();
  const step = branchStep(base, await props.searchParams);
  if (step.choose) return <BranchChoice title="New Transfer" branches={base.branches} current={base.branchId} />;
  const ctx = step.ctx;
  const branch = ctx.branches.find((b) => b.id === ctx.branchId);
  const many = ctx.branches.length > 1;
  const admin = createAdminClient();
  const [{ data: products }, { data: categories }, logistics, { data: companyBranches }] = await Promise.all([
    admin.from("products").select("id, sku, name").eq("company_id", ctx.companyId).eq("is_active", true).order("sku"),
    // Only charge types that go into inventory cost.
    admin.from("cost_categories").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true)
      .eq("applies_to_transfer", true).eq("inventory_treatment", "capitalize").order("code"),
    isFeatureEnabled(ctx.companyId, "transfer_logistics"),
    // Goods can be sent to any branch of the company; only the sending branch must be the user's.
    admin.from("branches").select("id, name, code").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
  ]);
  const myBranches = ctx.user.isOwner ? ctx.branches : ctx.branches.filter((b) => ctx.user.branchIds.includes(b.id));
  return (
    <div>
      <PageHeader title="New Transfer"
        description={<><ChosenBranch branch={branch} canChange={many} /> (sending) · Goods, truck and driver, and the loading, transport and other charges for this move. Charges are added to the cost of the goods at the receiving branch; offloading is entered when the goods are received.</>} />
      {!ctx.branchId || myBranches.length === 0 ? <EmptyState title="Choose a branch first" /> : (
        <NewTransferForm
          products={(products ?? []) as never}
          sourceBranches={myBranches}
          allBranches={(companyBranches ?? []) as { id: string; name: string; code: string }[]}
          sourceBranchId={ctx.branchId}
          canDispatch={can(ctx.user, "inventory.transfer_dispatch")}
          canLicence={can(ctx.user, "documents.view_licence")}
          chargesEnabled={logistics}
          categories={(categories ?? []).map((c) => ({ id: c.id, code: c.code, label: c.name }))}
        />
      )}
    </div>
  );
}
