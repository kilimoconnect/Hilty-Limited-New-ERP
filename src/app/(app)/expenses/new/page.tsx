import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { createAdminClient } from "@/lib/supabase/admin";
import { branchPaymentOptions } from "@/lib/payment-methods";
import { PageHeader } from "@/components/ui/page-header";
import { branchStep } from "@/lib/branch-step";
import { BranchChoice, ChosenBranch } from "@/components/layout/branch-choice";
import { EmptyState } from "@/components/ui/empty-state";
import { ExpenseForm } from "./expense-form";

export const metadata: Metadata = { title: "Record Expense" };

export default async function NewExpensePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermissionPage("expenses.create");
  const base = await getActiveContext();
  const step = branchStep(base, await props.searchParams);
  if (step.choose) return <BranchChoice title="Record Expense" branches={base.branches} current={base.branchId} />;
  const ctx = step.ctx;
  const branch = ctx.branches.find((b) => b.id === ctx.branchId);
  const many = ctx.branches.length > 1;
  const admin = createAdminClient();
  if (!ctx.branchId) return <div><PageHeader title="Record Expense" /><EmptyState title="No active branch" /></div>;

  const [{ data: categories }, { data: suppliers }, { data: taxCodes }, branchAccounts] = await Promise.all([
    admin.from("expense_categories").select("id, code, name, description").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("suppliers").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("tax_codes").select("id, name, rate, is_inclusive").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    branchPaymentOptions(ctx.companyId, ctx.branchId),
  ]);
  const receiptsOn = (await isFeatureEnabled(ctx.companyId, "attachments")) && can(ctx.user, "documents.upload");

  return (
    <div>
      <PageHeader title="Record Expense" description={<><ChosenBranch branch={branch} canChange={many} /> · Petty cash and other operating expenses. Do not use this for stock purchases.</>} />
      <ExpenseForm branchId={ctx.branchId} categories={(categories ?? []) as never} suppliers={(suppliers ?? []) as never}
        taxCodes={(taxCodes ?? []).map((t) => ({ ...t, rate: Number(t.rate) })) as never} accounts={branchAccounts as never} receiptsOn={receiptsOn} />
    </div>
  );
}
