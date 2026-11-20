import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { createAdminClient } from "@/lib/supabase/admin";
import { branchPaymentOptions } from "@/lib/payment-methods";
import { PageHeader } from "@/components/ui/page-header";
import { branchStep } from "@/lib/branch-step";
import { BranchChoice, ChosenBranch } from "@/components/layout/branch-choice";
import { EmptyState } from "@/components/ui/empty-state";
import { BackButton } from "@/components/common/back-button";
import { ExpenseForm, type ExpenseInitial } from "./expense-form";

export const metadata: Metadata = { title: "Record Expense" };

export default async function NewExpensePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const draftId = typeof sp.draft === "string" ? sp.draft : null;
  await requirePermissionPage(draftId ? "expenses.edit_draft" : "expenses.create");
  const base = await getActiveContext();
  const admin = createAdminClient();
  let ctx = base;

  // Edit draft: the form opens at the draft's branch, filled in.
  let initial: ExpenseInitial | undefined;
  if (draftId) {
    const { data: d } = await admin.from("expenses")
      .select("id, company_id, branch_id, document_status, document_date, expense_category_id, supplier_id, reference, description, tax_code_id, tax_inclusive, net_total, grand_total, due_date, is_credit, payments:expense_payments(payment_account_id)")
      .eq("id", draftId).maybeSingle();
    if (!d || d.company_id !== base.companyId) notFound();
    if (d.document_status !== "draft") redirect(`/expenses/${draftId}`);
    if (!base.branches.some((x) => x.id === d.branch_id)) notFound();
    const pays = (d.payments ?? []) as { payment_account_id: string }[];
    initial = {
      expenseId: draftId, documentDate: d.document_date, accountId: pays[0]?.payment_account_id ?? "",
      categoryId: d.expense_category_id, amount: Number(d.tax_inclusive ? d.grand_total : d.net_total),
      description: d.description ?? "", supplierId: d.supplier_id, taxCodeId: d.tax_code_id, reference: d.reference ?? "",
      onCredit: pays.length === 0, dueDate: d.due_date ?? "",
    };
    ctx = { ...base, branchId: d.branch_id };
  } else {
    const step = branchStep(base, sp);
    if (step.choose) return <BranchChoice title="Record Expense" branches={base.branches} current={base.branchId} />;
    ctx = step.ctx;
  }
  const branch = ctx.branches.find((b) => b.id === ctx.branchId);
  const many = ctx.branches.length > 1;
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
      {initial && <BackButton href={`/expenses/${initial.expenseId}`} label="Draft" />}
      <PageHeader title={initial ? "Edit Expense Draft" : "Record Expense"}
        description={<><ChosenBranch branch={branch} canChange={many && !initial} /> · Petty cash and other operating expenses. Do not use this for stock purchases.</>} />
      <ExpenseForm branchId={ctx.branchId} categories={(categories ?? []) as never} suppliers={(suppliers ?? []) as never}
        taxCodes={(taxCodes ?? []).map((t) => ({ ...t, rate: Number(t.rate) })) as never} accounts={branchAccounts as never} receiptsOn={receiptsOn}
        initial={initial} />
    </div>
  );
}
