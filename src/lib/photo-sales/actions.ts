"use server";

import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission, assertBranchAccess } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveContext } from "@/lib/context";
import { writeAuditLog } from "@/lib/audit";
import { saveSaleDraft } from "@/lib/sales/actions";
import { saveExpenseDraft } from "@/lib/expenses/actions";
import { normalizeAlias, receiptIssues, receiptReference, round2, type ReadReceipt } from "./types";

export interface PhotoDraftInput {
  branchId: string;
  receipts: (ReadReceipt & { payments: { payment_account_id: string; amount: number }[] })[];
  expenses: { key: string; date: string; label: string; amount: number; category_id: string; paid_from_account_id: string }[];
}
export interface PhotoDraftResult {
  ok: boolean;
  error?: string;
  receipts: { key: string; number: string; id?: string; error?: string }[];
  expenses: { key: string; label: string; id?: string; error?: string }[];
}

/**
 * Creates drafts from a reviewed photo: one sale draft per receipt that
 * matches (Walk-in, the receipt's date, unit price = line amount / qty, the
 * receipt number as reference, payments as allocated on the review page) and
 * one expense draft per notebook expense. Receipts that do not match are
 * refused here as well; the user enters those by hand. Nothing is posted.
 */
export async function createPhotoDrafts(input: PhotoDraftInput): Promise<PhotoDraftResult> {
  const out: PhotoDraftResult = { ok: true, receipts: [], expenses: [] };
  try {
    const user = await assertActiveUser();
    assertPermission(user, "sales.create");
    assertBranchAccess(user, input.branchId);
    const ctx = await getActiveContext();
    const admin = createAdminClient();

    const { data: walkIn } = await admin.from("customers").select("id").eq("company_id", ctx.companyId).eq("is_protected", true).maybeSingle();
    if (!walkIn) return { ...out, ok: false, error: "The Walk-in customer is missing." };

    const remember: { text: string; product_id: string }[] = [];
    for (const r of input.receipts) {
      // Re-check on the server: totals, products, date, and not entered before.
      const { data: dup } = await admin.from("sales").select("id").eq("company_id", ctx.companyId).eq("branch_id", input.branchId)
        .neq("document_status", "voided").eq("customer_reference", receiptReference(r.number)).limit(1);
      const issues = receiptIssues({ ...r, existing_sale_id: dup?.[0]?.id ?? null });
      if (issues.length) { out.receipts.push({ key: r.key, number: r.number, error: issues[0] }); continue; }

      const lines = r.lines.map((l) => ({
        product_id: l.product_id!, quantity: l.qty, unit_price: round2(l.amount / l.qty), discount: 0, tax_code_id: null,
      }));
      // Unit prices are rounded to cents; never let payments exceed what the lines come to.
      const total = round2(lines.reduce((s, l) => s + round2(l.unit_price * l.quantity), 0));
      let left = total;
      const payments = r.payments.filter((p) => p.amount > 0).map((p) => {
        const amount = round2(Math.min(p.amount, left)); left = round2(left - amount);
        return { payment_account_id: p.payment_account_id, amount, payment_date: r.date! };
      }).filter((p) => p.amount > 0);

      const res = await saveSaleDraft({
        branchId: input.branchId, documentDate: r.date!, customerId: walkIn.id,
        customerReference: receiptReference(r.number), notes: `From photo: cash sale receipt ${r.number}`,
        lines, payments,
      });
      if (!res.ok || !res.id) { out.receipts.push({ key: r.key, number: r.number, error: res.error ?? "Could not save the draft." }); continue; }
      out.receipts.push({ key: r.key, number: r.number, id: res.id });
      for (const l of r.lines) remember.push({ text: l.text, product_id: l.product_id! });
    }

    for (const e of input.expenses) {
      if (!(e.amount > 0) || !e.category_id || !e.paid_from_account_id || !e.date) {
        out.expenses.push({ key: e.key, label: e.label, error: "Choose the category, the payment method and the date." }); continue;
      }
      const res = await saveExpenseDraft({
        branchId: input.branchId, categoryId: e.category_id, documentDate: e.date,
        description: `${e.label} (from photo)`, taxCodeId: null, amount: e.amount,
        payments: [{ payment_account_id: e.paid_from_account_id, amount: e.amount }],
      });
      out.expenses.push(res.ok && res.id ? { key: e.key, label: e.label, id: res.id } : { key: e.key, label: e.label, error: res.error ?? "Could not save the expense." });
    }

    // Short-form memory: remember what each written item was matched to.
    const byAlias = new Map<string, string>();
    for (const m of remember) { const a = normalizeAlias(m.text); if (a) byAlias.set(a, m.product_id); }
    if (byAlias.size) {
      const { data: known } = await admin.from("photo_item_aliases").select("id, alias, uses").eq("company_id", ctx.companyId).in("alias", Array.from(byAlias.keys()));
      const knownBy = new Map((known ?? []).map((k) => [k.alias, k]));
      for (const [alias, product_id] of byAlias) {
        const k = knownBy.get(alias);
        if (k) await admin.from("photo_item_aliases").update({ product_id, uses: k.uses + 1, updated_at: new Date().toISOString() }).eq("id", k.id);
        else await admin.from("photo_item_aliases").insert({ company_id: ctx.companyId, alias, product_id, created_by: user.id });
      }
    }

    await writeAuditLog({
      userId: user.id, companyId: ctx.companyId, branchId: input.branchId, action: "photo_sales.drafts",
      resourceType: "branch", resourceId: input.branchId,
    });
    revalidatePath("/sales/history"); revalidatePath("/expenses/history");
    return out;
  } catch (e) {
    return { ...out, ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}
