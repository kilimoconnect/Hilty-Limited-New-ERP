"use server";

import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission, assertBranchAccess } from "@/lib/auth/guards";
import { postingDateError } from "@/lib/auth/limits";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import { todayISO } from "@/lib/format";

export interface CountResult { ok: boolean; error?: string; difference?: number }

/**
 * Records (or corrects) the end-of-day count of a branch till. Nothing is
 * posted: the cash-up report compares the count with the till's balance for
 * that day. The expected balance at the time of counting is kept for audit.
 */
export async function recordCashCount(input: {
  accountId: string; date: string; counted: number; notes?: string;
}): Promise<CountResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "cash_accounts.count_cash");
    const ctx = await getActiveContext();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) return { ok: false, error: "Choose a valid date." };
    if (input.date > todayISO()) return { ok: false, error: "A count cannot be dated in the future." };
    if (!Number.isFinite(input.counted) || input.counted < 0) return { ok: false, error: "Enter the amount counted (0 or more)." };

    const admin = createAdminClient();
    const { data: pa } = await admin.from("payment_accounts")
      .select("id, company_id, branch_id, name").eq("id", input.accountId).maybeSingle();
    if (!pa || pa.company_id !== ctx.companyId || !pa.branch_id) return { ok: false, error: "Only a branch till can be counted." };
    assertBranchAccess(user, pa.branch_id);
    const dateErr = await postingDateError(user, input.date);
    if (dateErr) return { ok: false, error: dateErr };

    const { data: rows, error: rpcErr } = await admin.rpc("report_daily_cashup", {
      p_company: ctx.companyId, p_branches: [pa.branch_id], p_start: input.date, p_end: input.date,
    });
    if (rpcErr) return { ok: false, error: rpcErr.message };
    const row = ((rows ?? []) as { account_id: string; closing: number }[]).find((r) => r.account_id === pa.id);
    const expected = Number(row?.closing ?? 0);
    const counted = Math.round(input.counted * 100) / 100;

    const { data: prior } = await admin.from("cash_counts").select("id, counted_amount, notes")
      .eq("payment_account_id", pa.id).eq("count_date", input.date).maybeSingle();
    const { error } = await admin.from("cash_counts").upsert({
      company_id: ctx.companyId, branch_id: pa.branch_id, payment_account_id: pa.id, count_date: input.date,
      counted_amount: counted, expected_at_count: expected, notes: input.notes?.trim() || null,
      counted_by: user.id, updated_at: new Date().toISOString(),
    }, { onConflict: "payment_account_id,count_date" });
    if (error) return { ok: false, error: error.message };

    await writeAuditLog({
      userId: user.id, companyId: ctx.companyId, branchId: pa.branch_id,
      action: prior ? "cash_count.correct" : "cash_count.record", resourceType: "cash_count", resourceId: pa.id,
      oldValues: prior ? { counted_amount: prior.counted_amount, notes: prior.notes } : undefined,
      newValues: { till: pa.name, date: input.date, counted_amount: counted, expected, difference: Math.round((counted - expected) * 100) / 100 },
    });
    revalidatePath("/reports/cash-up");
    return { ok: true, difference: Math.round((counted - expected) * 100) / 100 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}
