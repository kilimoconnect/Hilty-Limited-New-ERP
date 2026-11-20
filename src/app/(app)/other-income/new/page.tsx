import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { branchPaymentOptions } from "@/lib/payment-methods";
import { PageHeader } from "@/components/ui/page-header";
import { branchStep } from "@/lib/branch-step";
import { BranchChoice, ChosenBranch } from "@/components/layout/branch-choice";
import { EmptyState } from "@/components/ui/empty-state";
import { BackButton } from "@/components/common/back-button";
import { IncomeForm, type IncomeInitial } from "./income-form";

export const metadata: Metadata = { title: "Record Other Income" };

export default async function NewIncomePage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const draftId = typeof sp.draft === "string" ? sp.draft : null;
  await requirePermissionPage(draftId ? "other_income.edit_draft" : "other_income.create");
  const base = await getActiveContext();
  const admin = createAdminClient();
  let ctx = base;

  // Edit draft: the form opens at the draft's branch, filled in.
  let initial: IncomeInitial | undefined;
  if (draftId) {
    const { data: d } = await admin.from("other_income_transactions")
      .select("id, company_id, branch_id, document_status, document_date, income_type_id, received_from, description, tax_code_id, tax_inclusive, net_total, grand_total, reference, receipts:other_income_receipts(payment_account_id, amount)")
      .eq("id", draftId).maybeSingle();
    if (!d || d.company_id !== base.companyId) notFound();
    if (d.document_status !== "draft") redirect(`/other-income/${draftId}`);
    if (!base.branches.some((x) => x.id === d.branch_id)) notFound();
    initial = {
      incomeId: draftId, typeId: d.income_type_id, receivedFrom: d.received_from ?? "", documentDate: d.document_date,
      taxCodeId: d.tax_code_id, amount: Number(d.tax_inclusive ? d.grand_total : d.net_total), reference: d.reference ?? "",
      description: d.description ?? "",
      receipts: ((d.receipts ?? []) as { payment_account_id: string; amount: number }[]).map((r) => ({ payment_account_id: r.payment_account_id, amount: Number(r.amount) })),
    };
    ctx = { ...base, branchId: d.branch_id };
  } else {
    const step = branchStep(base, sp);
    if (step.choose) return <BranchChoice title="Record Other Income" branches={base.branches} current={base.branchId} />;
    ctx = step.ctx;
  }
  const branch = ctx.branches.find((b) => b.id === ctx.branchId);
  if (!ctx.branchId) return <div><PageHeader title="Record Other Income" /><EmptyState title="No active branch" /></div>;
  const [{ data: types }, { data: taxCodes }, branchAccounts] = await Promise.all([
    admin.from("other_income_types").select("id, code, name").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    admin.from("tax_codes").select("id, name, rate, is_inclusive").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    branchPaymentOptions(ctx.companyId, ctx.branchId),
  ]);
  return (
    <div>
      {initial && <BackButton href={`/other-income/${initial.incomeId}`} label="Draft" />}
      <PageHeader title={initial ? "Edit Income Draft" : "Record Other Income"}
        description={<><ChosenBranch branch={branch} canChange={ctx.branches.length > 1 && !initial} /> · Non-sales income, fully received when posted.</>} />
      <IncomeForm branchId={ctx.branchId} types={(types ?? []) as never} taxCodes={(taxCodes ?? []).map((t) => ({ ...t, rate: Number(t.rate) })) as never}
        accounts={branchAccounts as never} initial={initial} />
    </div>
  );
}
