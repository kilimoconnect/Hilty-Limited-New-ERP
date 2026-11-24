"use server";

import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission, assertBranchAccess } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveContext } from "@/lib/context";
import { writeAuditLog } from "@/lib/audit";
import { saveSaleDraft } from "@/lib/sales/actions";
import { normalizeAlias, receiptIssues, receiptsReference, round2, type ReadReceipt } from "./types";
import { usedReceiptNumbers } from "./reader";

export interface PhotoDraftInput {
  branchId: string;
  receipts: ReadReceipt[];
}
export interface PhotoDraftResult {
  ok: boolean;
  error?: string;
  /** One combined sale draft per receipt date. */
  drafts: { date: string; numbers: string[]; id?: string; error?: string }[];
  /** Receipts left out (incomplete or already entered). */
  refused: { number: string; error: string }[];
}

/**
 * Combines all reviewed receipts into one sale draft (one per receipt date,
 * as a sale has one date): Walk-in, unit price = line amount / qty, the same
 * product at the same price merged into one line, and the receipt numbers as
 * the reference ("Receipts 0195, 0196, 0197"). Payment is entered on the
 * draft before posting. Incomplete or already-entered receipts are refused
 * here as well. Nothing is posted.
 */
export async function createPhotoDrafts(input: PhotoDraftInput): Promise<PhotoDraftResult> {
  const out: PhotoDraftResult = { ok: true, drafts: [], refused: [] };
  try {
    const user = await assertActiveUser();
    assertPermission(user, "sales.from_photos");
    assertPermission(user, "sales.create");
    assertBranchAccess(user, input.branchId);
    const ctx = await getActiveContext();
    const admin = createAdminClient();

    const { data: walkIn } = await admin.from("customers").select("id").eq("company_id", ctx.companyId).eq("is_protected", true).maybeSingle();
    if (!walkIn) return { ...out, ok: false, error: "The Walk-in customer is missing." };

    // Re-check on the server: products, date, and not entered before.
    const used = await usedReceiptNumbers(ctx.companyId, input.branchId);
    const byDate = new Map<string, ReadReceipt[]>();
    for (const r of input.receipts) {
      const issues = receiptIssues({ ...r, existing_sale_id: used.get(r.number) ?? null });
      if (issues.length) { out.refused.push({ number: r.number, error: issues[0] }); continue; }
      byDate.set(r.date!, [...(byDate.get(r.date!) ?? []), r]);
    }

    const remember: { text: string; product_id: string }[] = [];
    for (const [date, group] of Array.from(byDate).sort(([a], [b]) => a.localeCompare(b))) {
      const numbers = group.map((r) => r.number).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      // Same product at the same unit price -> one line with the quantities added.
      const merged = new Map<string, { product_id: string; quantity: number; unit_price: number; discount: number; tax_code_id: null }>();
      for (const r of group) for (const l of r.lines) {
        const unit = round2(l.amount / l.qty);
        const k = `${l.product_id}|${unit}`;
        const m = merged.get(k);
        if (m) m.quantity = Math.round((m.quantity + l.qty) * 10000) / 10000;
        else merged.set(k, { product_id: l.product_id!, quantity: l.qty, unit_price: unit, discount: 0, tax_code_id: null });
      }
      const res = await saveSaleDraft({
        branchId: input.branchId, documentDate: date, customerId: walkIn.id,
        customerReference: receiptsReference(numbers),
        notes: `From photos: cash sale receipts ${numbers.join(", ")}`,
        lines: Array.from(merged.values()), payments: [],
      });
      if (!res.ok || !res.id) { out.drafts.push({ date, numbers, error: res.error ?? "Could not save the draft." }); continue; }
      out.drafts.push({ date, numbers, id: res.id });
      for (const r of group) for (const l of r.lines) remember.push({ text: l.text, product_id: l.product_id! });
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
    revalidatePath("/sales/history");
    return out;
  } catch (e) {
    return { ...out, ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}
