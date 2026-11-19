import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { transferAccountOptions } from "@/lib/payment-methods";
import { PageHeader } from "@/components/ui/page-header";
import { TransferForm } from "./transfer-form";

export const metadata: Metadata = { title: "Cash Transfer" };

export default async function CashTransferPage() {
  await requirePermissionPage("cash_transfers.create");
  const ctx = await getActiveContext();
  // The payment methods assigned to the branches this user works in (banks once).
  const accounts = await transferAccountOptions(ctx.companyId, ctx.user.isOwner ? ctx.branches.map((b) => b.id) : ctx.user.branchIds);
  const slipsOn = (await isFeatureEnabled(ctx.companyId, "attachments")) && can(ctx.user, "documents.upload");
  return (
    <div>
      <PageHeader title="Cash Transfer" description="Move money between accounts. This is not income or an ordinary expense." />
      <TransferForm accounts={accounts as never} branchId={ctx.branchId} slipsOn={slipsOn} />
    </div>
  );
}
