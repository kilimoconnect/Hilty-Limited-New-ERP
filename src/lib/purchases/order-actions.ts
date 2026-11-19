"use server";

import { revalidatePath } from "next/cache";
import { assertActiveUser, assertPermission, assertBranchAccess } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { getActiveContext } from "@/lib/context";
import type { RpcResult as BaseResult } from "@/lib/rpc";

type RpcResult = BaseResult & { message?: string };

export type Basis = "sales" | "purchases";
export interface SuggestParams {
  branchId: string;
  months: 6 | 9 | 12;
  basis: Basis;
  leadDays: number;
  safetyDays: number;
  coverDays: number;
  supplierIds?: string[];
  brandIds?: string[];
  categoryIds?: string[];
  productIds?: string[];
}
export interface SuggestionRow {
  product_id: string; sku: string; name: string; brand: string | null; category: string | null; unit: string | null;
  supplier_id: string | null; supplier_name: string | null; supplier_source: "preferred" | "last_purchase" | null;
  history_months: number; months_used: number;
  avg_6: number | null; avg_9: number | null; avg_12: number | null; avg_monthly: number;
  reorder_level: number; current_reorder_level: number;
  on_hand: number; in_transit: number; on_order: number; suggested: number;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const nonEmpty = (a?: string[]) => (a && a.length ? a : null);
const OPEN = ["draft", "confirmed", "partially_received"];

/** Removes or closes orders that stayed pending past 30 days (cheap; run before order lists and suggestions). */
export async function expireOrders(companyId: string) {
  await createAdminClient().rpc("expire_purchase_orders", { p_company: companyId });
}

function checkParams(p: SuggestParams): string | null {
  if (![6, 9, 12].includes(p.months)) return "Choose 6, 9 or 12 months.";
  if (!["sales", "purchases"].includes(p.basis)) return "Choose what the average is based on.";
  for (const [label, v] of [["Lead time", p.leadDays], ["Safety stock", p.safetyDays], ["Cover", p.coverDays]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 365) return `${label} must be a whole number of days from 0 to 365.`;
  }
  return null;
}

/** Suggested order quantities per product for a branch (no prices). */
export async function suggestOrder(p: SuggestParams): Promise<{ ok: true; rows: SuggestionRow[] } | { ok: false; error: string }> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "purchases.order");
    const ctx = await getActiveContext();
    assertBranchAccess(user, p.branchId);
    const bad = checkParams(p);
    if (bad) return { ok: false, error: bad };
    await expireOrders(ctx.companyId);
    const { data, error } = await createAdminClient().rpc("report_reorder_suggestions", {
      p_company: ctx.companyId, p_branch: p.branchId, p_months: p.months, p_basis: p.basis,
      p_lead: p.leadDays, p_safety: p.safetyDays, p_cover: p.coverDays,
      p_suppliers: nonEmpty(p.supplierIds), p_brands: nonEmpty(p.brandIds),
      p_categories: nonEmpty(p.categoryIds), p_products: nonEmpty(p.productIds),
    });
    if (error) return { ok: false, error: error.message };
    const rows = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      ...(r as unknown as SuggestionRow),
      history_months: Number(r.history_months), months_used: Number(r.months_used),
      avg_6: num(r.avg_6), avg_9: num(r.avg_9), avg_12: num(r.avg_12), avg_monthly: Number(r.avg_monthly),
      reorder_level: Number(r.reorder_level), current_reorder_level: Number(r.current_reorder_level),
      on_hand: Number(r.on_hand), in_transit: Number(r.in_transit), on_order: Number(r.on_order), suggested: Number(r.suggested),
    }));
    return { ok: true, rows };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}

export interface GeneratedLine {
  product_id: string; supplier_id: string; quantity: number;
  avg_monthly?: number | null; reorder_level?: number | null; on_hand?: number | null; suggested_qty?: number | null; note?: string;
}

async function nextNumber(companyId: string, branchId: string): Promise<string> {
  const { data, error } = await createAdminClient().rpc("next_document_number", { p_company: companyId, p_branch: branchId, p_doc_type: "purchase_order" });
  if (error) throw new Error(error.message);
  return data as string;
}

async function checkProductsAndSuppliers(companyId: string, productIds: string[], supplierIds: string[]) {
  const admin = createAdminClient();
  const [{ data: prods }, { data: sups }] = await Promise.all([
    admin.from("products").select("id, name, company_id, is_active").in("id", productIds),
    supplierIds.length ? admin.from("suppliers").select("id, company_id, is_active").in("id", supplierIds) : Promise.resolve({ data: [] as { id: string; company_id: string; is_active: boolean }[] }),
  ]);
  const pMap = new Map((prods ?? []).map((p) => [p.id, p]));
  for (const id of productIds) {
    const p = pMap.get(id);
    if (!p || p.company_id !== companyId) throw new Error("A selected product is invalid.");
    if (!p.is_active) throw new Error(`${p.name} is inactive.`);
  }
  const sMap = new Map((sups ?? []).map((s) => [s.id, s]));
  for (const id of supplierIds) {
    const s = sMap.get(id);
    if (!s || s.company_id !== companyId) throw new Error("A selected supplier is invalid.");
    if (!s.is_active) throw new Error("A selected supplier is inactive.");
  }
  return pMap;
}

/**
 * Turns the edited suggestion into one draft order per supplier.
 * `rememberSuppliers` stores the chosen supplier as each product's preferred supplier.
 */
export async function createOrdersFromSuggestion(input: {
  branchId: string; params: Omit<SuggestParams, "branchId">; expectedDate?: string | null; notes?: string;
  lines: GeneratedLine[]; rememberSuppliers?: boolean;
}): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "purchases.order");
    const ctx = await getActiveContext();
    assertBranchAccess(user, input.branchId);
    const bad = checkParams({ ...input.params, branchId: input.branchId });
    if (bad) return { ok: false, error: bad };
    const lines = input.lines.filter((l) => l.quantity > 0);
    if (lines.length === 0) return { ok: false, error: "Nothing to order: every quantity is zero." };
    if (lines.some((l) => !l.supplier_id)) return { ok: false, error: "Choose a supplier for every line." };
    if (new Set(lines.map((l) => `${l.supplier_id}:${l.product_id}`)).size !== lines.length) return { ok: false, error: "A product appears twice for the same supplier." };
    const pMap = await checkProductsAndSuppliers(ctx.companyId, Array.from(new Set(lines.map((l) => l.product_id))), Array.from(new Set(lines.map((l) => l.supplier_id))));

    const admin = createAdminClient();
    const bySupplier = new Map<string, GeneratedLine[]>();
    for (const l of lines) bySupplier.set(l.supplier_id, [...(bySupplier.get(l.supplier_id) ?? []), l]);
    const ids: string[] = [];
    for (const [supplierId, group] of bySupplier) {
      const { data: po, error } = await admin.from("purchase_orders").insert({
        company_id: ctx.companyId, branch_id: input.branchId, supplier_id: supplierId,
        document_number: await nextNumber(ctx.companyId, input.branchId),
        expected_date: input.expectedDate || null, notes: input.notes || null,
        basis: input.params.basis, basis_months: input.params.months, lead_days: input.params.leadDays,
        safety_days: input.params.safetyDays, cover_days: input.params.coverDays,
        created_by: user.id, updated_by: user.id,
      }).select("id").single();
      if (error) return { ok: false, error: error.message };
      const { error: le } = await admin.from("purchase_order_lines").insert(group.map((l, i) => ({
        order_id: po.id, product_id: l.product_id, description: pMap.get(l.product_id)!.name, quantity: l.quantity,
        avg_monthly: l.avg_monthly ?? null, reorder_level: l.reorder_level ?? null, on_hand: l.on_hand ?? null,
        suggested_qty: l.suggested_qty ?? null, note: l.note || null, line_no: i + 1,
      })));
      if (le) { await admin.from("purchase_orders").delete().eq("id", po.id); return { ok: false, error: le.message }; }
      ids.push(po.id);
      await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: input.branchId, action: "purchase_order.create", resourceType: "purchase_order", resourceId: po.id });
    }
    if (input.rememberSuppliers) {
      // One update per supplier.
      await Promise.all(Array.from(bySupplier.entries()).map(([sid, group]) => admin.from("products")
        .update({ preferred_supplier_id: sid }).in("id", group.map((l) => l.product_id)).eq("company_id", ctx.companyId)));
    }
    revalidatePath("/purchases/orders");
    return { ok: true, ids };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}

/** Saves the computed reorder levels on the products (Owner or inventory.manage). */
export async function saveReorderLevels(rows: { product_id: string; reorder_level: number }[]): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    if (!user.isOwner) assertPermission(user, "inventory.manage");
    const ctx = await getActiveContext();
    const admin = createAdminClient();
    // One update per distinct level (many products share small levels).
    const byLevel = new Map<number, string[]>();
    for (const r of rows) if (r.reorder_level >= 0) byLevel.set(r.reorder_level, [...(byLevel.get(r.reorder_level) ?? []), r.product_id]);
    const results = await Promise.all(Array.from(byLevel.entries()).map(([level, ids]) => admin.from("products")
      .update({ reorder_level: level, updated_by: user.id }).in("id", ids).eq("company_id", ctx.companyId)));
    const failed = results.find((r) => r.error);
    if (failed?.error) return { ok: false, error: failed.error.message };
    const n = Array.from(byLevel.values()).reduce((a, ids) => a + ids.length, 0);
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, action: "product.reorder_levels", resourceType: "product", newValues: { count: n } });
    revalidatePath("/inventory");
    return { ok: true, message: `Reorder level saved on ${n} product${n === 1 ? "" : "s"}.` };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}

async function loadOrder(id: string) {
  const user = await assertActiveUser();
  assertPermission(user, "purchases.order");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const { data: o } = await admin.from("purchase_orders").select("id, company_id, branch_id, status").eq("id", id).maybeSingle();
  if (!o || o.company_id !== ctx.companyId) throw new Error("Purchase order not found.");
  assertBranchAccess(user, o.branch_id);
  return { user, ctx, admin, o };
}

/** Create (no orderId) or edit a draft order by hand. */
export async function saveOrder(input: {
  orderId?: string; branchId: string; supplierId: string; orderDate: string; expectedDate?: string | null;
  reference?: string; notes?: string; lines: { product_id: string; quantity: number; note?: string }[];
}): Promise<RpcResult> {
  try {
    const user = await assertActiveUser();
    assertPermission(user, "purchases.order");
    const ctx = await getActiveContext();
    assertBranchAccess(user, input.branchId);
    const lines = input.lines.filter((l) => l.product_id);
    if (lines.length === 0) return { ok: false, error: "Add at least one product." };
    if (lines.some((l) => !(l.quantity > 0))) return { ok: false, error: "Every quantity must be greater than zero." };
    if (new Set(lines.map((l) => l.product_id)).size !== lines.length) return { ok: false, error: "A product is listed twice; combine the lines." };
    if (!input.supplierId) return { ok: false, error: "Select a supplier." };
    const pMap = await checkProductsAndSuppliers(ctx.companyId, lines.map((l) => l.product_id), [input.supplierId]);
    const admin = createAdminClient();
    const header = {
      branch_id: input.branchId, supplier_id: input.supplierId, order_date: input.orderDate,
      expected_date: input.expectedDate || null, reference: input.reference || null, notes: input.notes || null,
      updated_by: user.id, updated_at: new Date().toISOString(),
    };
    let id = input.orderId ?? null;
    const old = new Map<string, Record<string, unknown>>();
    if (id) {
      const { data: ex } = await admin.from("purchase_orders").select("company_id, branch_id, status").eq("id", id).maybeSingle();
      if (!ex || ex.company_id !== ctx.companyId) return { ok: false, error: "Purchase order not found." };
      assertBranchAccess(user, ex.branch_id);
      if (ex.status !== "draft") return { ok: false, error: "Only draft orders can be edited." };
      const { data: prev } = await admin.from("purchase_order_lines").select("product_id, avg_monthly, reorder_level, on_hand, suggested_qty").eq("order_id", id);
      for (const r of prev ?? []) old.set(r.product_id, r);
      const { error } = await admin.from("purchase_orders").update(header).eq("id", id);
      if (error) return { ok: false, error: error.message };
      await admin.from("purchase_order_lines").delete().eq("order_id", id);
    } else {
      const { data, error } = await admin.from("purchase_orders").insert({
        ...header, company_id: ctx.companyId, document_number: await nextNumber(ctx.companyId, input.branchId), created_by: user.id,
      }).select("id").single();
      if (error) return { ok: false, error: error.message };
      id = data.id;
    }
    const { error: le } = await admin.from("purchase_order_lines").insert(lines.map((l, i) => {
      const o = old.get(l.product_id);
      return {
        order_id: id, product_id: l.product_id, description: pMap.get(l.product_id)!.name, quantity: l.quantity, note: l.note || null, line_no: i + 1,
        avg_monthly: o?.avg_monthly ?? null, reorder_level: o?.reorder_level ?? null, on_hand: o?.on_hand ?? null, suggested_qty: o?.suggested_qty ?? null,
      };
    }));
    if (le) return { ok: false, error: le.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: input.branchId, action: input.orderId ? "purchase_order.edit" : "purchase_order.create", resourceType: "purchase_order", resourceId: id! });
    revalidatePath("/purchases/orders"); revalidatePath(`/purchases/orders/${id}`);
    return { ok: true, id: id! };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}

/** Confirms a draft: it is now pending delivery for 30 days. */
export async function confirmOrder(id: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin, o } = await loadOrder(id);
    if (o.status !== "draft") return { ok: false, error: "Only draft orders can be confirmed." };
    const { count } = await admin.from("purchase_order_lines").select("id", { count: "exact", head: true }).eq("order_id", id);
    if (!count) return { ok: false, error: "The order has no lines." };
    const now = new Date();
    const { error } = await admin.from("purchase_orders").update({
      status: "confirmed", confirmed_at: now.toISOString(), confirmed_by: user.id,
      expires_at: new Date(now.getTime() + 30 * 86400000).toISOString(), updated_by: user.id, updated_at: now.toISOString(),
    }).eq("id", id).eq("status", "draft");
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: o.branch_id, action: "purchase_order.confirm", resourceType: "purchase_order", resourceId: id });
    revalidatePath("/purchases/orders"); revalidatePath(`/purchases/orders/${id}`);
    return { ok: true, id, message: "Order confirmed. Print it or save it as PDF for the supplier." };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}

/** A confirmed order with nothing received goes back to draft for changes. */
export async function reopenOrder(id: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin, o } = await loadOrder(id);
    if (o.status !== "confirmed") return { ok: false, error: "Only confirmed orders with nothing received can be changed." };
    const { count } = await admin.from("purchases").select("id", { count: "exact", head: true }).eq("purchase_order_id", id).eq("document_status", "posted");
    if (count) return { ok: false, error: "Goods were already received on this order." };
    const { error } = await admin.from("purchase_orders").update({
      status: "draft", confirmed_at: null, confirmed_by: null, expires_at: new Date(Date.now() + 30 * 86400000).toISOString(),
      updated_by: user.id, updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: o.branch_id, action: "purchase_order.reopen", resourceType: "purchase_order", resourceId: id });
    revalidatePath("/purchases/orders"); revalidatePath(`/purchases/orders/${id}`);
    return { ok: true, id };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}

/** Deletes an order that has received nothing (draft or confirmed). */
export async function deleteOrder(id: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin, o } = await loadOrder(id);
    if (!["draft", "confirmed", "cancelled"].includes(o.status)) return { ok: false, error: "An order with received goods cannot be deleted; close it instead." };
    const { count } = await admin.from("purchases").select("id", { count: "exact", head: true }).eq("purchase_order_id", id).eq("document_status", "posted");
    if (count) return { ok: false, error: "Goods were already received on this order; close it instead." };
    const { error } = await admin.from("purchase_orders").delete().eq("id", id);
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: o.branch_id, action: "purchase_order.delete", resourceType: "purchase_order", resourceId: id });
    revalidatePath("/purchases/orders");
    return { ok: true };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}

/** Stops waiting for the rest of a partly received order. */
export async function closeOrder(id: string, reason: string): Promise<RpcResult> {
  try {
    const { user, ctx, admin, o } = await loadOrder(id);
    if (!OPEN.slice(1).includes(o.status)) return { ok: false, error: "Only pending orders can be closed." };
    const { error } = await admin.from("purchase_orders").update({
      status: "closed", closed_at: new Date().toISOString(), close_reason: reason.trim() || "Closed by user",
      updated_by: user.id, updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) return { ok: false, error: error.message };
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId: o.branch_id, action: "purchase_order.close", resourceType: "purchase_order", resourceId: id, reason });
    revalidatePath("/purchases/orders"); revalidatePath(`/purchases/orders/${id}`);
    return { ok: true, id };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Failed." }; }
}
