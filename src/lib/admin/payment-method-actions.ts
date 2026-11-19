"use server";

import { revalidatePath } from "next/cache";
import { assertOwner } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getPrimaryCompanyId } from "@/lib/admin/queries";

export interface MethodResult { ok: boolean; error?: string; id?: string }
type MethodType = "cash" | "bank" | "mobile_money";

function refresh() {
  ["/admin/payment-methods", "/admin/branches", "/admin/payment-accounts", "/cash-and-banks"].forEach((p) => revalidatePath(p));
}

/** Next free child code under a ledger header (1120 -> 1123, 1130 -> 1133 ...). */
async function nextChildCode(companyId: string, parentId: string, parentCode: string): Promise<string> {
  const { data } = await createAdminClient().from("chart_of_accounts").select("code").eq("company_id", companyId).eq("parent_id", parentId);
  let max = 0;
  for (const r of data ?? []) {
    if (r.code.startsWith(parentCode) && /^\d+$/.test(r.code) && r.code.length === parentCode.length + 1) max = Math.max(max, Number(r.code.slice(parentCode.length)));
  }
  return parentCode + (max + 1);
}

/**
 * Creates or edits a payment method. A new bank gets its one company-wide
 * account (with a ledger account under 1120 Bank). A new cash / mobile-money
 * method gets a ledger header under 1110 Cash / 1130 Mobile Money; each branch
 * account is created under it when the method is assigned to the branch.
 */
export async function savePaymentMethod(input: {
  id?: string; code: string; name: string; type: MethodType; provider?: string; accountNumber?: string;
}): Promise<MethodResult> {
  try {
    const user = await assertOwner();
    const companyId = await getPrimaryCompanyId(user.defaultCompanyId);
    const admin = createAdminClient();
    const code = input.code.trim().toUpperCase().replace(/\s+/g, "");
    const name = input.name.trim();
    if (!name) return { ok: false, error: "Enter the name." };

    if (input.id) {
      const { data: m } = await admin.from("payment_methods").select("id, company_id, per_branch").eq("id", input.id).maybeSingle();
      if (!m || m.company_id !== companyId) return { ok: false, error: "Payment method not found." };
      const { error } = await admin.from("payment_methods").update({ name, provider: input.provider?.trim() || null, updated_by: user.id, updated_at: new Date().toISOString() }).eq("id", m.id);
      if (error) return { ok: false, error: error.message };
      // Keep the account names in step (balances are untouched).
      const { data: accs } = await admin.from("payment_accounts").select("id, branch:branches(name)").eq("payment_method_id", m.id);
      for (const a of (accs ?? []) as unknown as { id: string; branch: { name: string } | null }[]) {
        await admin.from("payment_accounts").update({
          name: a.branch ? `${name} - ${a.branch.name}` : name, updated_by: user.id,
          ...(!m.per_branch ? { provider: input.provider?.trim() || null, ...(input.accountNumber !== undefined ? { account_number: input.accountNumber.trim() || null } : {}) } : {}),
        }).eq("id", a.id);
      }
      await writeAuditLog({ userId: user.id, companyId, action: "payment_method.update", resourceType: "payment_method", resourceId: m.id, newValues: { name } });
      refresh();
      return { ok: true, id: m.id };
    }

    if (!/^[A-Z0-9_-]{2,12}$/.test(code)) return { ok: false, error: "Code: 2 to 12 letters or digits, e.g. AIRTEL." };
    if (!["cash", "bank", "mobile_money"].includes(input.type)) return { ok: false, error: "Choose the type." };
    const { data: dup } = await admin.from("payment_methods").select("id").eq("company_id", companyId).eq("code", code).maybeSingle();
    if (dup) return { ok: false, error: "A payment method with this code already exists." };
    const { data: dupAcc } = await admin.from("payment_accounts").select("id").eq("company_id", companyId).or(`code.eq.${code},code.like.${code}-%`).limit(1);
    if (dupAcc && dupAcc.length) return { ok: false, error: "Payment accounts with this code already exist; choose another code." };

    const headerCode = input.type === "cash" ? "1110" : input.type === "bank" ? "1120" : "1130";
    const { data: header } = await admin.from("chart_of_accounts").select("id, code").eq("company_id", companyId).eq("code", headerCode).maybeSingle();
    if (!header) return { ok: false, error: `Ledger account ${headerCode} is missing in the chart of accounts.` };
    const perBranch = input.type !== "bank";
    const glCode = await nextChildCode(companyId, header.id, header.code);
    const { data: gl, error: glErr } = await admin.from("chart_of_accounts").insert({
      company_id: companyId, code: glCode, name, account_type: "asset", parent_id: header.id, normal_balance: "debit",
      // A per-branch method's ledger account is a header: each branch account posts beneath it.
      allow_posting: !perBranch, is_system: false, is_active: true, is_control: true, cashflow_class: "unclassified", created_by: user.id,
    }).select("id").single();
    if (glErr) return { ok: false, error: glErr.message };
    const { data: sortRow } = await admin.from("payment_methods").select("sort_order").eq("company_id", companyId).order("sort_order", { ascending: false }).limit(1);
    const { data: m, error } = await admin.from("payment_methods").insert({
      company_id: companyId, code, name, method_type: input.type, per_branch: perBranch, ledger_parent_id: perBranch ? gl.id : null,
      provider: input.provider?.trim() || null, sort_order: (sortRow?.[0]?.sort_order ?? 0) + 1, created_by: user.id, updated_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    if (!perBranch) {
      const { error: accErr } = await admin.from("payment_accounts").insert({
        company_id: companyId, code, name, account_type: "bank", provider: input.provider?.trim() || null,
        account_number: input.accountNumber?.trim() || null, ledger_account_id: gl.id, payment_method_id: m.id, created_by: user.id,
      });
      if (accErr) return { ok: false, error: accErr.message };
    }
    await writeAuditLog({ userId: user.id, companyId, action: "payment_method.create", resourceType: "payment_method", resourceId: m.id, newValues: { code, name, type: input.type } });
    refresh();
    return { ok: true, id: m.id };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}

/** Switches a method off (it disappears from every form) or back on. Accounts and balances are kept. */
export async function setPaymentMethodActive(id: string, active: boolean): Promise<MethodResult> {
  try {
    const user = await assertOwner();
    const companyId = await getPrimaryCompanyId(user.defaultCompanyId);
    const admin = createAdminClient();
    const { error } = await admin.from("payment_methods").update({ is_active: active, updated_by: user.id, updated_at: new Date().toISOString() })
      .eq("id", id).eq("company_id", companyId);
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId, action: active ? "payment_method.activate" : "payment_method.deactivate", resourceType: "payment_method", resourceId: id });
    refresh();
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}

/** The methods a branch may use. Assigning a cash / mobile-money method creates the branch's own account. */
export async function setBranchPaymentMethods(branchId: string, methodIds: string[]): Promise<MethodResult> {
  try {
    const user = await assertOwner();
    const companyId = await getPrimaryCompanyId(user.defaultCompanyId);
    const admin = createAdminClient();
    const { data: b } = await admin.from("branches").select("id, company_id").eq("id", branchId).maybeSingle();
    if (!b || b.company_id !== companyId) return { ok: false, error: "Branch not found." };
    const { error } = await admin.rpc("set_branch_payment_methods", { p_branch: branchId, p_methods: Array.from(new Set(methodIds)), p_user: user.id });
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId, branchId, action: "branch.payment_methods", resourceType: "branch", resourceId: branchId, newValues: { methods: methodIds } });
    refresh();
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}
