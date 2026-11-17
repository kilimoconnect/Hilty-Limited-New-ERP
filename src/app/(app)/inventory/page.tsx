import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/batch";
import { Pager, pageOf, pageSizeOf } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ListToolbar } from "@/components/common/list-toolbar";
import { formatMoney, formatQuantity } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Current Stock" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function InventoryPage(props: { searchParams: SP }) {
  await requirePermissionPage("inventory.view");
  const ctx = await getActiveContext();
  const showCost = can(ctx.user, "inventory.view_cost");
  const admin = createAdminClient();

  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const branch = typeof sp.branch === "string" ? sp.branch : "";
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
    qty_in_transit: number; last_movement_at: string | null;
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
          { name: "branch", placeholder: "All branches", value: branch, width: "w-[180px]",
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
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead className="text-right">On hand</TableHead>
                <TableHead className="text-right">In transit</TableHead>
                {showCost && <TableHead className="text-right">Avg cost</TableHead>}
                {showCost && <TableHead className="text-right">Value</TableHead>}
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => {
                const lowStock = Number(r.quantity) <= Number(r.product?.reorder_level ?? 0);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.product?.sku}</TableCell>
                    <TableCell>
                      <div className="font-medium">{r.product?.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {[r.product?.category?.name, r.product?.brand?.name].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{r.branch?.code}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQuantity(r.quantity)} {r.product?.unit?.symbol ?? ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {Number(r.qty_in_transit) > 0 ? formatQuantity(r.qty_in_transit) : "—"}
                    </TableCell>
                    {showCost && <TableCell className="text-right tabular-nums">{formatMoney(r.avg_unit_cost)}</TableCell>}
                    {showCost && <TableCell className="text-right tabular-nums">{formatMoney(r.stock_value)}</TableCell>}
                    <TableCell>
                      {Number(r.quantity) < 0 ? (
                        <Badge variant="destructive">Negative</Badge>
                      ) : lowStock ? (
                        <Badge variant="warning">Low</Badge>
                      ) : (
                        <StatusBadge active={r.product?.is_active ?? true} />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {showCost && total > 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Total stock value ({total} {total === 1 ? "row" : "rows"}{q || branch || category || brand || low ? ", filtered" : ""}): <span className="font-semibold text-foreground tabular-nums">{formatMoney(totalValue)}</span>
        </p>
      )}
      <Pager basePath="/inventory" params={{ q, branch, category, brand, low: low ? "1" : "" }} page={page} pageSize={size} total={total} />
    </div>
  );
}
