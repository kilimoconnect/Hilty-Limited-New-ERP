import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { branchPaymentOptions } from "@/lib/payment-methods";
import { PageHeader } from "@/components/ui/page-header";
import { branchStep } from "@/lib/branch-step";
import { BranchChoice, ChosenBranch } from "@/components/layout/branch-choice";
import { EmptyState } from "@/components/ui/empty-state";
import { IncomeForm } from "./income-form";

export const metadata: Metadata = { title: "Record Other Income" };

export default async function NewIncomePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermissionPage("other_income.create");
  const base = await getActiveContext();
  const step = branchStep(base, await props.searchParams);
  if (step.choose) return <BranchChoice title="Record Other Income" branches={base.branches} current={base.branchId} />;
  const ctx = step.ctx;
  const branch = ctx.branches.find((b) => b.id === ctx.branchId);
  const admin = createAdminClient();
  if (!ctx.branchId) return <div><PageHeader title="Record Other Income" /><EmptyState title="No active branch" /></div>;
  const [{ data: types }, { data: taxCodes }, branchAccounts] = await Promise.all([
    admin.from("other_income_types").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("tax_codes").select("id, name, rate, is_inclusive").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    branchPaymentOptions(ctx.companyId, ctx.branchId),
  ]);
  return (
    <div>
      <PageHeader title="Record Other Income" description={<><ChosenBranch branch={branch} canChange={ctx.branches.length > 1} /> · Non-sales income, fully received when posted.</>} />
      <IncomeForm branchId={ctx.branchId} types={(types ?? []) as never} taxCodes={(taxCodes ?? []).map((t) => ({ ...t, rate: Number(t.rate) })) as never} accounts={branchAccounts as never} />
    </div>
  );
}
