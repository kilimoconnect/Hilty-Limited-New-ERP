import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/batch";
import { Pager, pageOf, pageSizeOf } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { ListToolbar } from "@/components/common/list-toolbar";
import { StockTable, type StockRow } from "./stock-table";
import { loadLetterhead } from "@/lib/print/letterhead";
import { formatMoney } from "@/lib/format";
import { pageBranch } from "@/lib/branch-filter";
import { selfPath, withBack } from "@/lib/back-link";

export const metadata: Metadata = { title: "Current Stock" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function InventoryPage(props: { searchParams: SP }) {
  await requirePermissionPage("inventory.view");
  const ctx = await getActiveContext();
  const showCost = can(ctx.user, "inventory.view_cost");
  const admin = createAdminClient();

  const sp = await props.searchParams;
  const here = selfPath("/inventory", sp);
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const low = sp.low === "1";
  const category = typeof sp.category === "string" ? sp.category : "";
  const brand = typeof sp.brand === "string" ? sp.brand : "";
  const [{ data: categories }, { data: brands }] = await Promise.all([
    admin.from("product_categories").select("id, name").eq("company_id", ctx.companyId).order("name"),
    admin.from("brands").select("id, name").eq("company_id", ctx.companyId).order("name"),
  ]);

  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  // Commas and brackets would break the search filter syntax.
  const term = q.replace(/[,()]/g, " ").trim();

  type Row = {
    id: string; quantity: number; avg_unit_cost: number; stock_value: number;
    qty_in_transit: number; last_movement_at: string | null; product_id: string; branch_id: string;
    product: { sku: string; name: string; reorder_level: number; is_active: boolean;
      category: { name: string } | null; brand: { name: string } | null; unit: { symbol: string } | null } | null;
    branch: { name: string; code: string } | null;
  };
  // Every matching balance is read (the list, the low-stock filter and the
  // total value must cover all of them), then shown one page at a time.
  const rows = await selectAll<Row>(() => {
    let query = admin.from("stock_balances")
      .select("id, quantity, avg_unit_cost, stock_value, qty_in_transit, last_movement_at, branch_id, product_id, product:products!inner(sku, name, reorder_level, is_active, category:product_categories(name), brand:brands(name), unit:units(symbol)), branch:branches(name, code)")
      .eq("company_id", ctx.companyId);
    if (branch) query = query.eq("branch_id", branch);
    else if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
    if (category) query = query.eq("product.category_id", category);
    if (brand) query = query.eq("product.brand_id", brand);
    if (term) query = query.or(`sku.ilike.%${term}%,name.ilike.%${term}%`, { referencedTable: "products" });
    return query.order("id");
  });
  let all = rows;
  if (low) all = all.filter((r) => Number(r.quantity) <= Number(r.product?.reorder_level ?? 0));
  all.sort((x, y) => (x.product?.sku ?? "").localeCompare(y.product?.sku ?? "") || (x.branch?.code ?? "").localeCompare(y.branch?.code ?? ""));
  const total = all.length;
  const totalValue = all.reduce((s, r) => s + Number(r.stock_value), 0);
  const list = all.slice((page - 1) * size, page * size);

  // Rows for the table and the Excel / PDF export (every matching row, not only this page).
  const toRow = (r: Row): StockRow => {
    const qty = Number(r.quantity);
    return {
      id: r.id, sku: r.product?.sku ?? "", name: r.product?.name ?? "",
      group: [r.product?.category?.name, r.product?.brand?.name].filter(Boolean).join(" · "),
      branchCode: r.branch?.code ?? "", branchName: r.branch?.name ?? "", unit: r.product?.unit?.symbol ?? "",
      qty, inTransit: Number(r.qty_in_transit), avgCost: showCost ? Number(r.avg_unit_cost) : 0, value: showCost ? Number(r.stock_value) : 0,
      status: qty < 0 ? "negative" : qty <= Number(r.product?.reorder_level ?? 0) ? "low" : r.product?.is_active === false ? "inactive" : "active",
      href: withBack(`/inventory/kardex?product=${r.product_id}&branch=${r.branch_id}`, here, "Current Stock"),
    };
  };
  const branchObj = ctx.branches.find((x) => x.id === branch);
  const filterText = [
    `Branch: ${branchObj ? `${branchObj.name} (${branchObj.code})` : "All branches"}`,
    category ? `Category: ${(categories ?? []).find((c) => c.id === category)?.name ?? ""}` : "",
    brand ? `Brand: ${(brands ?? []).find((x) => x.id === brand)?.name ?? ""}` : "",
    low ? "Low stock only" : "", q ? `Search: "${q}"` : "",
  ].filter(Boolean).join("  ·  ");
  const letterhead = await loadLetterhead(ctx.companyId);

  return (
    <div>
      <PageHeader
        title="Current Stock"
        description="Live quantity on hand by branch, from the stock-movement ledger."
      />
      <ListToolbar
        searchValue={q}
        searchPlaceholder="Search SKU or name..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branchParam, width: "w-[180px]",
            options: ctx.branches.map((b) => ({ value: b.id, label: `${b.name} (${b.code})` })) },
          { name: "category", placeholder: "All categories", value: category, width: "w-[170px]",
            options: (categories ?? []).map((c) => ({ value: c.id, label: c.name })) },
          { name: "brand", placeholder: "All brands", value: brand, width: "w-[170px]",
            options: (brands ?? []).map((b) => ({ value: b.id, label: b.name })) },
          { name: "low", placeholder: "All stock", value: low ? "1" : "",
            options: [{ value: "1", label: "Low stock only" }] },
        ]}
      />

      {list.length === 0 ? (
        <EmptyState title="No stock records" description="Post an opening balance or a purchase to build stock." />
      ) : (
        <StockTable pageRows={list.map(toRow)} allRows={all.map(toRow)} showCost={showCost}
          filters={filterText} company={letterhead} printedBy={ctx.user.fullName ?? ctx.user.email} />
      )}

      {showCost && total > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Total stock value ({total} {total === 1 ? "row" : "rows"}{q || branch || category || brand || low ? ", filtered" : ""}): <span className="font-semibold text-foreground tabular-nums">{formatMoney(totalValue)}</span>
        </p>
      )}
      <Pager basePath="/inventory" params={{ q, branch: branchParam, category, brand, low: low ? "1" : "" }} page={page} pageSize={size} total={total} />
    </div>
  );
}
