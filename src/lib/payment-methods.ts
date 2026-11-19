import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/** What a user picks when paying or receiving money at a branch. `id` is the payment account behind it. */
export interface PayOption { id: string; code: string; name: string; type: string }

/**
 * The payment methods assigned to a branch (Admin -> Branches -> Assign
 * methods), as the accounts that hold the money: the branch's own account for
 * per-branch methods (cash, mobile money), the shared account for banks.
 * Shown by method name ("Cash", "MPESA"...), in the methods' order.
 *
 * A branch with no methods assigned falls back to the earlier rule: every
 * company-wide account plus the branch's own accounts.
 */
export async function branchPaymentOptions(companyId: string, branchId: string): Promise<PayOption[]> {
  const admin = createAdminClient();
  const [{ data: assigned }, { data: accounts }] = await Promise.all([
    admin.from("branch_payment_methods")
      .select("method:payment_methods!inner(id, code, name, per_branch, is_active, sort_order)")
      .eq("company_id", companyId).eq("branch_id", branchId),
    admin.from("payment_accounts").select("id, code, name, account_type, branch_id, payment_method_id")
      .eq("company_id", companyId).eq("is_active", true).order("code"),
  ]);
  const accs = accounts ?? [];
  const methods = ((assigned ?? []) as unknown as { method: { id: string; code: string; name: string; per_branch: boolean; is_active: boolean; sort_order: number } }[])
    .map((r) => r.method).filter((m) => m.is_active)
    .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));

  if (methods.length === 0) {
    return accs.filter((a) => !a.branch_id || a.branch_id === branchId)
      .map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.account_type }));
  }
  const out: PayOption[] = [];
  for (const m of methods) {
    const acc = accs.find((a) => a.payment_method_id === m.id && (m.per_branch ? a.branch_id === branchId : !a.branch_id));
    if (acc) out.push({ id: acc.id, code: m.code, name: m.name, type: acc.account_type });
  }
  return out;
}

/**
 * Accounts a user may move money between (cash transfers): for each branch
 * given, its assigned methods (labelled "Cash - Bunju B"), plus the banks once.
 */
export async function transferAccountOptions(companyId: string, branchIds: string[]): Promise<{ id: string; name: string }[]> {
  const admin = createAdminClient();
  const [{ data: assigned }, { data: accounts }] = await Promise.all([
    admin.from("branch_payment_methods").select("branch_id, payment_method_id").eq("company_id", companyId).in("branch_id", branchIds.length ? branchIds : ["00000000-0000-0000-0000-000000000000"]),
    admin.from("payment_accounts").select("id, name, branch_id, payment_method_id").eq("company_id", companyId).eq("is_active", true).order("code"),
  ]);
  const accs = accounts ?? [];
  const pairs = new Set((assigned ?? []).map((r) => `${r.branch_id}:${r.payment_method_id}`));
  const methodsAnywhere = new Set((assigned ?? []).map((r) => r.payment_method_id));
  const branchesWithMethods = new Set((assigned ?? []).map((r) => r.branch_id));
  return accs.filter((a) => {
    if (!a.payment_method_id) return !a.branch_id ? branchesWithMethods.size === 0 : branchIds.includes(a.branch_id) && !branchesWithMethods.has(a.branch_id);
    if (!a.branch_id) return methodsAnywhere.has(a.payment_method_id);
    if (!branchIds.includes(a.branch_id)) return false;
    return branchesWithMethods.has(a.branch_id) ? pairs.has(`${a.branch_id}:${a.payment_method_id}`) : true;
  }).map((a) => ({ id: a.id, name: a.name }));
}
