import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { transferAccountOptions } from "@/lib/payment-methods";
import { PageHeader } from "@/components/ui/page-header";
import { branchStep } from "@/lib/branch-step";
import { BranchChoice, ChosenBranch } from "@/components/layout/branch-choice";
import { TransferForm } from "./transfer-form";

export const metadata: Metadata = { title: "Cash Transfer" };

export default async function CashTransferPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermissionPage("cash_transfers.create");
  const base = await getActiveContext();
  const step = branchStep(base, await props.searchParams);
  if (step.choose) return <BranchChoice title="Cash Transfer" branches={base.branches} current={base.branchId} />;
  const ctx = step.ctx;
  const branch = ctx.branches.find((b) => b.id === ctx.branchId);
  const many = ctx.branches.length > 1;
  // The payment methods assigned to the branches this user works in (banks once).
  const accounts = await transferAccountOptions(ctx.companyId, ctx.user.isOwner ? ctx.branches.map((b) => b.id) : ctx.user.branchIds);
  const slipsOn = (await isFeatureEnabled(ctx.companyId, "attachments")) && can(ctx.user, "documents.upload");
  return (
    <div>
      <PageHeader title="Cash Transfer" description={<><ChosenBranch branch={branch} canChange={many} /> · Move money between accounts. This is not income or an ordinary expense.</>} />
      <TransferForm accounts={accounts as never} branchId={ctx.branchId} slipsOn={slipsOn} />
    </div>
  );
}
