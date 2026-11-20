import { createAdminClient } from "@/lib/supabase/admin";
import { branchPaymentOptions } from "@/lib/payment-methods";
import { flattenProducts } from "@/lib/products";

/** Everything the sale form needs for one branch (Create Sale and Edit draft). */
export async function loadSaleFormData(companyId: string, branchId: string, isOwner: boolean) {
  const admin = createAdminClient();
  const [{ data: products }, { data: taxCodes }, branchAccounts, { data: customers }, { data: bals }] = await Promise.all([
    admin.from("products").select("id, sku, barcode, name, selling_price, tax_code_id, track_inventory, category:product_categories(name), brand:brands(name)").eq("company_id", companyId).eq("is_active", true).order("name"),
    admin.from("tax_codes").select("id, name, rate, is_inclusive").eq("company_id", companyId).eq("is_active", true).order("code"),
    branchPaymentOptions(companyId, branchId),
    admin.from("customers").select("id, code, name, phone, is_protected").eq("company_id", companyId).eq("is_active", true).order("code"),
    admin.from("stock_balances").select("product_id, quantity, avg_unit_cost").eq("company_id", companyId).eq("branch_id", branchId),
  ]);

  const stock: Record<string, number> = {};
  // Weighted average cost is shown to the Owner only (like gross profit).
  const wac: Record<string, number> = {};
  for (const b of bals ?? []) { stock[b.product_id] = Number(b.quantity); if (isOwner) wac[b.product_id] = Number(b.avg_unit_cost); }
  const walkIn = (customers ?? []).find((c) => c.is_protected);

  return {
    wac, stock,
    products: flattenProducts(products),
    taxCodes: (taxCodes ?? []).map((t) => ({ ...t, rate: Number(t.rate) })) as never,
    accounts: branchAccounts as never,
    customers: (customers ?? []) as never,
    canViewCost: isOwner,
    walkInId: walkIn?.id ?? null,
  };
}
