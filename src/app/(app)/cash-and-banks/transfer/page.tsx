import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { isFeatureEnabled } from "@/lib/features";
import { branchPaymentOptions } from "@/lib/payment-methods";
import { createAdminClient } from "@/lib/supabase/admin";
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
  // Only the payment methods assigned to this branch, each with its balance at the
  // branch (for a bank: the branch's share, as on Cash & Banks).
  const admin = createAdminClient();
  const [options, { data: bal }] = await Promise.all([
    ctx.branchId ? branchPaymentOptions(ctx.companyId, ctx.branchId) : Promise.resolve([]),
    ctx.branchId ? admin.rpc("report_branch_method_balances", { p_company: ctx.companyId, p_branches: [ctx.branchId] }) : Promise.resolve({ data: [] }),
  ]);
  const { data: limits } = options.length
    ? await admin.from("payment_accounts").select("id, allow_negative, overdraft_limit").in("id", options.map((o) => o.id))
    : { data: [] as { id: string; allow_negative: boolean; overdraft_limit: number }[] };
  const balOf = new Map(((bal ?? []) as { payment_account_id: string; balance: number }[]).map((r) => [r.payment_account_id, Number(r.balance)]));
  const accounts = options.map((o) => {
    const l = (limits ?? []).find((x) => x.id === o.id);
    const balance = balOf.get(o.id) ?? 0;
    return { id: o.id, code: o.code, name: o.name, balance, available: balance + (l?.allow_negative ? Number(l.overdraft_limit) : 0) };
  });
  const slipsOn = (await isFeatureEnabled(ctx.companyId, "attachments")) && can(ctx.user, "documents.upload");
  return (
    <div>
      <PageHeader title="Cash Transfer" description={<><ChosenBranch branch={branch} canChange={many} /> · Move money between accounts. This is not income or an ordinary expense.</>} />
      <TransferForm accounts={accounts} branchId={ctx.branchId} slipsOn={slipsOn} />
    </div>
  );
}
