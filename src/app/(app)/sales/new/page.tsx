import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { PageHeader } from "@/components/ui/page-header";
import { branchStep } from "@/lib/branch-step";
import { BranchChoice } from "@/components/layout/branch-choice";
import { EmptyState } from "@/components/ui/empty-state";
import { SaleForm } from "./sale-form";
import { loadSaleFormData } from "./load-form";

export const metadata: Metadata = { title: "Create Sale" };

export default async function NewSalePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermissionPage("sales.create");
  const base = await getActiveContext();
  const step = branchStep(base, await props.searchParams);
  if (step.choose) return <BranchChoice title="Create Sale" branches={base.branches} current={base.branchId} />;
  const ctx = step.ctx;
  const branch = ctx.branches.find((b) => b.id === ctx.branchId);
  const many = ctx.branches.length > 1;

  if (!ctx.branchId) {
    return (
      <div>
        <PageHeader title="Create Sale" />
        <EmptyState title="No active branch" description="You need an assigned branch to create sales." />
      </div>
    );
  }

  const data = await loadSaleFormData(ctx.companyId, ctx.branchId, ctx.user.isOwner);

  return (
    <div>
      <PageHeader title="Sales" />
      <SaleForm
        branchId={ctx.branchId}
        branchLabel={branch ? `${branch.code} — ${branch.name}` : ""}
        canChangeBranch={many}
        {...data}
      />
    </div>
  );
}
