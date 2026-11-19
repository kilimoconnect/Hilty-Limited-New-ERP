import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

export interface MethodRow {
  id: string; code: string; name: string; method_type: "cash" | "bank" | "mobile_money"; per_branch: boolean;
  provider: string | null; account_number: string | null; is_active: boolean; branchIds: string[];
}
export interface BranchRow { id: string; code: string; name: string; address: string | null; is_active: boolean; methodIds: string[] }

/** Payment methods with the branches that use them, and branches with their methods. */
export async function loadPaymentMethods(companyId: string): Promise<{ methods: MethodRow[]; branches: BranchRow[] }> {
  const admin = createAdminClient();
  const [{ data: methods }, { data: branches }, { data: links }, { data: banks }] = await Promise.all([
    admin.from("payment_methods").select("id, code, name, method_type, per_branch, provider, is_active, sort_order").eq("company_id", companyId).order("sort_order").order("code"),
    admin.from("branches").select("id, code, name, address, is_active").eq("company_id", companyId).order("code"),
    admin.from("branch_payment_methods").select("branch_id, payment_method_id").eq("company_id", companyId),
    admin.from("payment_accounts").select("payment_method_id, account_number").eq("company_id", companyId).is("branch_id", null).not("payment_method_id", "is", null),
  ]);
  const order = new Map((branches ?? []).map((b, i) => [b.id, i]));
  const l = (links ?? []).sort((a, b) => (order.get(a.branch_id) ?? 0) - (order.get(b.branch_id) ?? 0));
  const accNo = new Map((banks ?? []).map((b) => [b.payment_method_id as string, b.account_number as string | null]));
  return {
    methods: (methods ?? []).map((m) => ({
      id: m.id, code: m.code, name: m.name, method_type: m.method_type, per_branch: m.per_branch, provider: m.provider,
      account_number: accNo.get(m.id) ?? null, is_active: m.is_active,
      branchIds: l.filter((x) => x.payment_method_id === m.id).map((x) => x.branch_id),
    })),
    branches: (branches ?? []).map((b) => ({ ...b, methodIds: l.filter((x) => x.branch_id === b.id).map((x) => x.payment_method_id) })),
  };
}
