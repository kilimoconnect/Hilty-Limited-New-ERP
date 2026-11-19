import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { TransferForm } from "./transfer-form";

export const metadata: Metadata = { title: "Cash Transfer" };

export default async function CashTransferPage() {
  await requirePermissionPage("cash_transfers.create");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const { data: all } = await admin.from("payment_accounts").select("id, name, branch_id").eq("company_id", ctx.companyId).eq("is_active", true).order("code");
  // Company-wide accounts (banks) plus the tills of the branches this user works in.
  const accounts = (all ?? []).filter((a) => !a.branch_id || ctx.user.isOwner || ctx.user.branchIds.includes(a.branch_id))
    .map(({ id, name }) => ({ id, name }));
  const slipsOn = (await isFeatureEnabled(ctx.companyId, "attachments")) && can(ctx.user, "documents.upload");
  return (
    <div>
      <PageHeader title="Cash Transfer" description="Move money between accounts. This is not income or an ordinary expense." />
      <TransferForm accounts={accounts as never} branchId={ctx.branchId} slipsOn={slipsOn} />
    </div>
  );
}
