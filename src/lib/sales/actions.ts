"use server";

import { postingDateError, roleLimits, backdateError, discountError } from "@/lib/auth/limits";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission, assertBranchAccess } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import { callPostingRpc, type RpcResult } from "@/lib/rpc";
import { calcLine, calcTotals, round2 } from "@/lib/sales/calc";

export interface SaleLineInput {
  product_id: string;
  quantity: number;
  unit_price: number;
  discount: number;
  tax_code_id?: string | null;
}
export interface SalePaymentInput {
  payment_account_id: string;
  amount: number;
  reference?: string;
  payment_date?: string;
}
export interface SaleDraftInput {
  saleId?: string;
  branchId: string;
  documentDate: string;
  dueDate?: string | null;
  customerId: string;
  customerReference?: string;
  salespersonId?: string | null;
  notes?: string;
  lines: SaleLineInput[];
  payments: SalePaymentInput[];
}

export async function saveSaleDraft(input: SaleDraftInput): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, input.saleId ? "sales.edit_draft" : "sales.create");
    const ctx = await getActiveContext();
    assertBranchAccess(user, input.branchId);
    if (input.lines.length === 0) return { ok: false, error: "Add at least one product line." };

    const admin = createAdminClient();

    // Trusted snapshots from products + tax codes (same company, active).
    const productIds = input.lines.map((l) => l.product_id);
    const { data: products } = await admin
      .from("products")
      .select("id, name, sku, selling_price, tax_code_id, track_inventory, is_active, company_id")
      .in("id", productIds);
    const pMap = new Map((products ?? []).map((p) => [p.id, p]));

    const taxIds = Array.from(new Set(
      input.lines.map((l) => l.tax_code_id).filter(Boolean) as string[],
    ));
    const productTaxIds = (products ?? []).map((p) => p.tax_code_id).filter(Boolean) as string[];
    const { data: taxCodes } = await admin
      .from("tax_codes")
      .select("id, name, tax_type, rate, is_inclusive, company_id, is_active")
      .in("id", Array.from(new Set([...taxIds, ...productTaxIds])).length ? Array.from(new Set([...taxIds, ...productTaxIds])) : ["00000000-0000-0000-0000-000000000000"]);
    const tMap = new Map((taxCodes ?? []).map((t) => [t.id, t]));

    const canOverride = userHasPermission(user, "sales.override_price");
    const lineRows: Record<string, unknown>[] = [];
    let overrode = false;

    input.lines.forEach((l, i) => {
      const p = pMap.get(l.product_id);
      if (!p) throw new Error("A selected product is invalid.");
      if (p.company_id !== ctx.companyId) throw new Error("A product belongs to another company.");
      if (!p.is_active) throw new Error(`Product ${p.sku} is inactive.`);
      if (!(l.quantity > 0)) throw new Error("Quantity must be greater than zero.");
      if (l.unit_price < 0) throw new Error("Price cannot be negative.");
      if (l.discount < 0) throw new Error("Discount cannot be negative.");

      const original = Number(p.selling_price);
      if (round2(l.unit_price) !== round2(original)) {
        if (!canOverride) throw new Error("You are not allowed to change the selling price.");
        overrode = true;
      }

      const taxId = l.tax_code_id ?? p.tax_code_id ?? null;
      const tc = taxId ? tMap.get(taxId) : null;
      if (taxId && tc && tc.company_id !== ctx.companyId) throw new Error("Tax code belongs to another company.");
      const rate = tc ? Number(tc.rate) : 0;
      // Prices are entered including VAT (as on the old system): VAT is taken out of the price.
      const inclusive = rate > 0;

      const r = calcLine({ quantity: l.quantity, unitPrice: l.unit_price, discount: l.discount, taxRate: rate, taxInclusive: inclusive });
      if (r.base < 0) throw new Error("Discount exceeds the line value.");

      lineRows.push({
        product_id: l.product_id,
        description: p.name,
        quantity: l.quantity,
        unit_price: l.unit_price,
        original_price: original,
        discount: l.discount,
        tax_code_id: taxId,
        tax_rate: rate,
        tax_type: tc?.tax_type ?? null,
        tax_name: tc?.name ?? null,
        tax_inclusive: inclusive,
        net_amount: r.net,
        tax_amount: r.tax,
        line_total: r.lineTotal,
        track_inventory: p.track_inventory,
        line_no: i + 1,
      });
    });

    const totals = calcTotals(input.lines.map((l) => {
      const p = pMap.get(l.product_id)!;
      const taxId = l.tax_code_id ?? p.tax_code_id ?? null;
      const tc = taxId ? tMap.get(taxId) : null;
      return { quantity: l.quantity, unitPrice: l.unit_price, discount: l.discount, taxRate: tc ? Number(tc.rate) : 0, taxInclusive: !!tc && Number(tc.rate) > 0 };
    }));

    const paid = round2(input.payments.reduce((s, p) => s + (p.amount || 0), 0));
    if (paid < 0) return { ok: false, error: "Payments cannot be negative." };
    if (paid > totals.grand + 0.001) return { ok: false, error: "Payments exceed the sale total." };
    const outstanding = round2(totals.grand - paid);
    const isCredit = outstanding > 0;

    const header = {
      company_id: ctx.companyId,
      branch_id: input.branchId,
      document_date: input.documentDate,
      due_date: input.dueDate || null,
      customer_id: input.customerId,
      customer_reference: input.customerReference || null,
      salesperson_id: input.salespersonId || null,
      notes: input.notes || null,
      is_credit: isCredit,
      subtotal: totals.subtotal,
      discount_total: totals.discount,
      net_total: totals.net,
      tax_total: totals.tax,
      grand_total: totals.grand,
      amount_paid: paid,
      outstanding,
      payment_status: paid <= 0 ? "unpaid" : paid < totals.grand ? "partially_paid" : "paid",
      updated_by: user.id,
    };

    let saleId = input.saleId ?? null;
    if (saleId) {
      const { data: existing } = await admin.from("sales").select("document_status, company_id").eq("id", saleId).maybeSingle();
      if (!existing || existing.company_id !== ctx.companyId) return { ok: false, error: "Sale not found." };
      if (existing.document_status !== "draft") return { ok: false, error: "Only drafts can be edited." };
      const { error } = await admin.from("sales").update(header).eq("id", saleId);
      if (error) return { ok: false, error: error.message };
      await admin.from("sale_lines").delete().eq("sale_id", saleId);
      await admin.from("sale_payments").delete().eq("sale_id", saleId);
    } else {
      const { data, error } = await admin.from("sales").insert({ ...header, created_by: user.id }).select("id").single();
      if (error) return { ok: false, error: error.message };
      saleId = data.id;
    }

    await admin.from("sale_lines").insert(lineRows.map((r) => ({ ...r, sale_id: saleId })));
    if (input.payments.length) {
      await admin.from("sale_payments").insert(input.payments.filter((p) => p.amount > 0).map((p) => ({
        sale_id: saleId, payment_account_id: p.payment_account_id, amount: p.amount,
        reference: p.reference || null, payment_date: p.payment_date || input.documentDate,
      })));
    }

    await writeAuditLog({
      userId: user.id, companyId: ctx.companyId, branchId: input.branchId,
      action: input.saleId ? "sale.draft_edit" : "sale.draft_create",
      resourceType: "sale", resourceId: saleId!,
    });
    if (overrode) {
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "sale.price_override", resourceType: "sale", resourceId: saleId! });
    }
    revalidatePath("/sales/history");
    return { ok: true, id: saleId! };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

/**
 * Edit posted sale (Owner only): opens a correction draft, a copy of the posted
 * sale that points at it. The original stays posted while the copy is edited
 * (deleting the copy changes nothing). Posting the copy reverses the original
 * and takes over its invoice number (see migration 0048). If a correction is
 * already open for this sale, that one is returned.
 */
export async function createSaleCorrection(saleId: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    if (!user.isOwner) return { ok: false, error: "Only the Owner can edit a posted sale." };
    const ctx = await getActiveContext();
    const admin = createAdminClient();
    const { data: sale } = await admin.from("sales").select("*").eq("id", saleId).maybeSingle();
    if (!sale || sale.company_id !== ctx.companyId) return { ok: false, error: "Sale not found." };
    if (sale.document_status !== "posted") return { ok: false, error: "Only a posted sale can be edited this way." };

    const { data: open } = await admin.from("sales").select("id").eq("amends_sale_id", saleId).eq("document_status", "draft").maybeSingle();
    if (open) return { ok: true, id: open.id };

    // Same rule as Void: nothing may depend on the sale.
    const { data: receipts } = await admin.from("customer_receipt_allocations")
      .select("receipt:customer_receipts!inner(document_number, document_status)").eq("sale_id", saleId).eq("receipt.document_status", "posted").limit(1);
    if (receipts?.length) return { ok: false, error: "This sale has customer payments received after the sale. Void those first, then edit the sale." };
    const { data: returns } = await admin.from("sales_returns").select("id").eq("sale_id", saleId).eq("document_status", "posted").limit(1);
    if (returns?.length) return { ok: false, error: "This sale has returns. Void those first, then edit the sale." };

    const [{ data: lines }, { data: pays }] = await Promise.all([
      admin.from("sale_lines").select("product_id, quantity, unit_price, discount, tax_code_id").eq("sale_id", saleId).order("line_no"),
      admin.from("sale_payments").select("payment_account_id, amount, reference, payment_date").eq("sale_id", saleId),
    ]);
    const res = await saveSaleDraft({
      branchId: sale.branch_id, documentDate: sale.document_date, dueDate: sale.due_date,
      customerId: sale.customer_id, customerReference: sale.customer_reference ?? "", salespersonId: sale.salesperson_id,
      notes: sale.notes ?? "",
      lines: (lines ?? []).filter((l) => l.product_id).map((l) => ({
        product_id: l.product_id as string, quantity: Number(l.quantity), unit_price: Number(l.unit_price), discount: Number(l.discount ?? 0), tax_code_id: l.tax_code_id,
      })),
      payments: (pays ?? []).map((p) => ({ payment_account_id: p.payment_account_id, amount: Number(p.amount), reference: p.reference ?? undefined, payment_date: p.payment_date ?? undefined })),
    });
    if (!res.ok || !res.id) return res;
    const { error } = await admin.from("sales").update({ amends_sale_id: saleId }).eq("id", res.id);
    if (error) {
      await admin.from("sales").delete().eq("id", res.id);
      return { ok: false, error: /sales_one_open_amendment/.test(error.message) ? "A correction of this sale is already open." : error.message };
    }
    await writeAuditLog({
      userId: user.id, companyId: ctx.companyId, branchId: sale.branch_id, action: "sale.correction_open",
      resourceType: "sale", resourceId: saleId, newValues: { correction_id: res.id, number: sale.document_number },
    });
    revalidatePath(`/sales/${saleId}`);
    return { ok: true, id: res.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function postSale(saleId: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "sales.post");
    const ctx = await getActiveContext();

    const admin = createAdminClient();
    const { data: sale } = await admin.from("sales").select("*").eq("id", saleId).maybeSingle();
    if (!sale || sale.company_id !== ctx.companyId) return { ok: false, error: "Sale not found." };
    if (sale.document_status !== "draft") return { ok: false, error: "Sale is not a draft." };
    assertBranchAccess(user, sale.branch_id);
    // A correction of a posted sale replaces it on posting (the database checks this too).
    if (sale.amends_sale_id && !user.isOwner) return { ok: false, error: "Only the Owner can post a correction of a posted sale." };

    // Walk-in credit block
    if (sale.outstanding > 0) {
      const { data: cust } = await admin.from("customers").select("is_protected").eq("id", sale.customer_id).maybeSingle();
      if (cust?.is_protected && !user.isOwner) {
        return { ok: false, error: "A Walk-in Customer sale cannot be posted on credit." };
      }
    }

    // Below-cost check
    if (!userHasPermission(user, "sales.sell_below_cost")) {
      const { data: lines } = await admin.from("sale_lines").select("product_id, unit_price, track_inventory").eq("sale_id", saleId);
      const prodIds = (lines ?? []).filter((l) => l.track_inventory).map((l) => l.product_id);
      if (prodIds.length) {
        const { data: bals } = await admin.from("stock_balances").select("product_id, avg_unit_cost")
          .eq("company_id", ctx.companyId).eq("branch_id", sale.branch_id).in("product_id", prodIds);
        const costMap = new Map((bals ?? []).map((b) => [b.product_id, Number(b.avg_unit_cost)]));
        for (const l of lines ?? []) {
          if (!l.track_inventory) continue;
          const cost = costMap.get(l.product_id) ?? 0;
          if (cost > 0 && Number(l.unit_price) < cost) {
            return { ok: false, error: "You are not allowed to sell below cost." };
          }
        }
      }
    }

    // Role limits: back-dating window and largest discount below list price.
    const limits = await roleLimits(user);
    const dateErr = backdateError(limits, sale.document_date);
    if (dateErr) return { ok: false, error: dateErr };
    if (limits.maxDiscountPct !== null) {
      const { data: dl } = await admin.from("sale_lines").select("quantity, unit_price, original_price, discount, description").eq("sale_id", saleId);
      const discErr = discountError(limits, (dl ?? []) as { quantity: number; unit_price: number; original_price: number | null; discount: number; description: string | null }[]);
      if (discErr) return { ok: false, error: discErr };
    }

    const res = await callPostingRpc("post_sale", { p_id: saleId, p_user: user.id, p_idem: randomUUID() });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: sale.branch_id, action: "sale.post", resourceType: "sale", resourceId: saleId });
      if (sale.amends_sale_id) {
        await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: sale.branch_id, action: "sale.corrected", resourceType: "sale",
          resourceId: sale.amends_sale_id, newValues: { replaced_by: saleId } });
        revalidatePath(`/sales/${sale.amends_sale_id}`);
      }
      revalidatePath("/sales/history"); revalidatePath(`/sales/${saleId}`); revalidatePath("/inventory"); revalidatePath("/dashboard");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function voidSale(saleId: string, reason: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "transactions.void");
    const res = await callPostingRpc("void_sale", { p_id: saleId, p_user: user.id, p_reason: reason });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, action: "sale.void", resourceType: "sale", resourceId: saleId, reason });
      revalidatePath("/sales/history"); revalidatePath(`/sales/${saleId}`); revalidatePath("/inventory"); revalidatePath("/dashboard");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function deleteSaleDraft(saleId: string, reason: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "transactions.delete_draft");
    const admin = createAdminClient();
    const { data: sale } = await admin.from("sales").select("document_status, document_number").eq("id", saleId).maybeSingle();
    if (!sale) return { ok: false, error: "Sale not found." };
    if (sale.document_status !== "draft") return { ok: false, error: "Only drafts can be deleted." };
    const { error } = await admin.from("sales").delete().eq("id", saleId);
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, action: "sale.draft_delete", resourceType: "sale", resourceId: saleId, reason });
    revalidatePath("/sales/history");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

/* -------------------------------- Returns ------------------------------- */

export async function createAndPostReturn(input: {
  saleId: string;
  returnDate: string;
  reason: string;
  notes?: string;
  lines: { sale_line_id: string; quantity: number; condition: "saleable" | "damaged" }[];
  refunds: { payment_account_id: string; amount: number; reference?: string }[];
}): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "sales.create_return");
    const ctx = await getActiveContext();
    if (!input.reason?.trim()) return { ok: false, error: "A reason is required." };
    if (input.lines.length === 0) return { ok: false, error: "Select at least one line to return." };
    { const dateErr = await postingDateError(user, input.returnDate); if (dateErr) return { ok: false, error: dateErr }; }

    const admin = createAdminClient();
    const { data: sale } = await admin.from("sales").select("*").eq("id", input.saleId).maybeSingle();
    if (!sale || sale.company_id !== ctx.companyId) return { ok: false, error: "Original sale not found." };
    if (sale.document_status !== "posted") return { ok: false, error: "Returns require a posted sale." };
    assertBranchAccess(user, sale.branch_id);

    const { data: saleLines } = await admin.from("sale_lines").select("*").eq("sale_id", input.saleId);
    const slMap = new Map((saleLines ?? []).map((l) => [l.id, l]));

    // Build return lines using original sale-line snapshots.
    let net = 0, tax = 0, total = 0;
    const retLines = input.lines.map((rl, i) => {
      const sl = slMap.get(rl.sale_line_id);
      if (!sl) throw new Error("Invalid return line.");
      if (!(rl.quantity > 0)) throw new Error("Return quantity must be greater than zero.");
      const soldQty = Number(sl.quantity);
      const frac = rl.quantity / soldQty;
      const lnNet = round2(Number(sl.net_amount) * frac);
      const lnTax = round2(Number(sl.tax_amount) * frac);
      const lnTotal = round2(Number(sl.line_total) * frac);
      net = round2(net + lnNet); tax = round2(tax + lnTax); total = round2(total + lnTotal);
      return {
        sale_line_id: sl.id, product_id: sl.product_id, quantity: rl.quantity,
        unit_price: sl.unit_price, tax_rate: sl.tax_rate,
        net_amount: lnNet, tax_amount: lnTax, line_total: lnTotal,
        unit_cost: sl.unit_cost, condition: rl.condition, track_inventory: sl.track_inventory, line_no: i + 1,
      };
    });

    const refundTotal = round2(input.refunds.reduce((s, r) => s + (r.amount || 0), 0));
    if (refundTotal > total + 0.001) return { ok: false, error: "Refund exceeds the return value." };
    const refundMethod = refundTotal <= 0 ? "receivable" : refundTotal >= total ? "payment_account" : "mixed";

    const { data: rHead, error } = await admin.from("sales_returns").insert({
      company_id: ctx.companyId, branch_id: sale.branch_id, sale_id: input.saleId,
      document_date: input.returnDate, customer_id: sale.customer_id, reason: input.reason,
      notes: input.notes || null, refund_method: refundMethod, created_by: user.id, updated_by: user.id,
    }).select("id").single();
    if (error) return { ok: false, error: error.message };
    const returnId = rHead.id;
    await admin.from("sales_return_lines").insert(retLines.map((l) => ({ ...l, return_id: returnId })));
    if (input.refunds.length) {
      await admin.from("sales_return_refunds").insert(input.refunds.filter((r) => r.amount > 0).map((r) => ({
        return_id: returnId, payment_account_id: r.payment_account_id, amount: r.amount,
        reference: r.reference || null, refund_date: input.returnDate,
      })));
    }

    const res = await callPostingRpc("post_sales_return", { p_id: returnId, p_user: user.id, p_idem: randomUUID() });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: sale.branch_id, action: "sale.return_post", resourceType: "sales_return", resourceId: returnId });
      revalidatePath("/sales/history"); revalidatePath(`/sales/${input.saleId}`); revalidatePath("/inventory"); revalidatePath("/dashboard");
    } else {
      // Clean up the unusable draft return so it does not linger.
      await admin.from("sales_returns").delete().eq("id", returnId);
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}

export async function voidReturn(returnId: string, reason: string): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "transactions.void");
    const res = await callPostingRpc("void_sales_return", { p_id: returnId, p_user: user.id, p_reason: reason });
    if (res.ok) {
      await writeAuditLog({ userId: user.id, action: "sale.return_void", resourceType: "sales_return", resourceId: returnId, reason });
      revalidatePath("/sales/history"); revalidatePath("/inventory"); revalidatePath("/dashboard");
    }
    return res;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed." };
  }
}
