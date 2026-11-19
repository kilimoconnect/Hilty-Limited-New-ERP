import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/batch";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListToolbar } from "@/components/common/list-toolbar";
import { formatMoney, formatQuantity, formatDateTime, localDayStart, localDayEnd } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const metadata: Metadata = { title: "Kardex" };

const TYPE_LABEL: Record<string, string> = {
  opening: "Opening", sale: "Sale", sale_void: "Sale void", sales_return: "Return",
  sales_return_void: "Return void", adjustment_increase: "Adj +", adjustment_decrease: "Adj −",
  adjustment_void: "Adj void", transfer_out: "Transfer out", transfer_in: "Transfer in",
  transfer_void: "Transfer void", purchase: "Purchase", purchase_return: "Purchase return",
};

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function KardexPage(props: { searchParams: SP }) {
  await requirePermissionPage("inventory.view_kardex");
  const ctx = await getActiveContext();
  const showCost = can(ctx.user, "inventory.view_cost");
  const admin = createAdminClient();

  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const branch = typeof sp.branch === "string" ? sp.branch : "";
  const type = typeof sp.type === "string" ? sp.type : "";
  // One item's Kardex (opened by clicking an item).
  const productId = typeof sp.product === "string" && /^[0-9a-f-]{36}$/i.test(sp.product) ? sp.product : "";
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  const from = (page - 1) * size, to = from + size - 1;
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");

  // Commas and brackets would break the search filter syntax.
  const term = q.replace(/[,()]/g, " ").trim();

  let query = admin.from("stock_movements")
    .select(`id, created_at, product_id, branch_id, movement_type, source_type, source_id, source_number, qty_in, qty_out, unit_cost, movement_value, balance_qty, avg_cost_after, balance_value, branch:branches(code), product:products${term ? "!inner" : ""}(sku, name)`, { count: "exact" })
    .eq("company_id", ctx.companyId)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .range(from, to);
  if (branch) query = query.eq("branch_id", branch);
  else if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  if (type) query = query.eq("movement_type", type);
  if (productId) query = query.eq("product_id", productId);
  if (from_) query = query.gte("created_at", localDayStart(from_));
  if (to_) query = query.lte("created_at", localDayEnd(to_));
  if (term) query = query.or(`sku.ilike.%${term}%,name.ilike.%${term}%`, { referencedTable: "products" });

  const { data, count } = await query;
  const rows = (data ?? []) as unknown as Array<{
    id: string; created_at: string; product_id: string; branch_id: string; movement_type: string; source_type: string; source_id: string | null;
    source_number: string | null; qty_in: number; qty_out: number; unit_cost: number; movement_value: number;
    balance_qty: number; avg_cost_after: number; balance_value: number;
    branch: { code: string } | null; product: { sku: string; name: string } | null;
  }>;
  const total = count ?? 0;

  // The item: name, current balance at the branch (or all branches) and totals in / out.
  let item: { sku: string; name: string; unit: string | null; qty: number; value: number; totIn: number; totOut: number } | null = null;
  if (productId) {
    const branchIds = branch ? [branch] : ctx.branches.map((b) => b.id);
    const [{ data: p }, { data: bals }, sums] = await Promise.all([
      admin.from("products").select("sku, name, company_id, unit:units(symbol)").eq("id", productId).maybeSingle(),
      admin.from("stock_balances").select("quantity, stock_value").eq("product_id", productId).in("branch_id", branchIds),
      // Every movement (a busy item has more than one page of 1000).
      selectAll<{ qty_in: number; qty_out: number }>(() => admin.from("stock_movements").select("id, qty_in, qty_out").eq("product_id", productId).in("branch_id", branchIds).order("id")),
    ]);
    if (p && p.company_id === ctx.companyId) {
      item = {
        sku: p.sku, name: p.name, unit: (p.unit as unknown as { symbol: string | null } | null)?.symbol ?? null,
        qty: (bals ?? []).reduce((a, b) => a + Number(b.quantity), 0), value: (bals ?? []).reduce((a, b) => a + Number(b.stock_value), 0),
        totIn: sums.reduce((a, m) => a + Number(m.qty_in), 0), totOut: sums.reduce((a, m) => a + Number(m.qty_out), 0),
      };
    }
  }
  const branchName = ctx.branches.find((b) => b.id === branch);
  const itemHref = (pid: string, bid: string) => `/inventory/kardex?product=${pid}&branch=${bid}`;

  return (
    <div>
      <PageHeader title={item ? `Kardex — ${item.name}` : "Kardex"}
        description={item ? `${item.sku} · ${branchName ? `${branchName.code} — ${branchName.name}` : "all branches"}. Every movement of this item, newest first.` : "Immutable stock-movement ledger. Click an item to open its own Kardex."}
        actions={item ? <Link href="/inventory/kardex" className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"><ArrowLeft className="h-4 w-4" /> All items</Link> : undefined} />
      {item && (
        <Card className="mb-4"><CardContent className="flex flex-wrap gap-8 p-5 text-sm">
          <div><p className="text-xs uppercase text-muted-foreground">On hand {branchName ? `at ${branchName.code}` : "(all branches)"}</p><p className="text-xl font-semibold tabular-nums">{formatQuantity(item.qty)}{item.unit ? <span className="ml-1 text-sm font-normal text-muted-foreground">{item.unit}</span> : null}</p></div>
          <div><p className="text-xs uppercase text-muted-foreground">Total in</p><p className="text-xl font-semibold tabular-nums text-success">{formatQuantity(item.totIn)}</p></div>
          <div><p className="text-xs uppercase text-muted-foreground">Total out</p><p className="text-xl font-semibold tabular-nums text-destructive">{formatQuantity(item.totOut)}</p></div>
          {showCost && <div><p className="text-xs uppercase text-muted-foreground">Stock value</p><p className="text-xl font-semibold tabular-nums">{formatMoney(item.value)}</p></div>}
          <div><p className="text-xs uppercase text-muted-foreground">Movements</p><p className="text-xl font-semibold tabular-nums">{total}</p></div>
        </CardContent></Card>
      )}
      <ListToolbar
        searchValue={q}
        searchPlaceholder={item ? "Search within this item..." : "Search product SKU or name..."}
        selects={[
          { name: "branch", placeholder: "All branches", value: branch, width: "w-[170px]",
            options: ctx.branches.map((b) => ({ value: b.id, label: b.code })) },
          { name: "type", placeholder: "All types", value: type, width: "w-[160px]",
            options: Object.entries(TYPE_LABEL).map(([v, l]) => ({ value: v, label: l })) },
        ]}
        dates={{ from: from_, to: to_ }}
      />

      {rows.length === 0 ? (
        <EmptyState title="No movements found" />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Branch</TableHead>
                {!item && <TableHead>Product</TableHead>}
                <TableHead>Type</TableHead>
                <TableHead>Document</TableHead>
                <TableHead className="text-right">In</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">Balance</TableHead>
                {showCost && <TableHead className="text-right">Unit cost</TableHead>}
                {showCost && <TableHead className="text-right">Stock value</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatDateTime(r.created_at)}</TableCell>
                  <TableCell className="text-sm">{r.branch?.code}</TableCell>
                  {!item && (
                    <TableCell>
                      <Link href={itemHref(r.product_id, r.branch_id)} className="group block" title="Open this item's Kardex">
                        <div className="text-sm font-medium text-primary group-hover:underline">{r.product?.sku}</div>
                        <div className="text-xs text-muted-foreground group-hover:text-foreground">{r.product?.name}</div>
                      </Link>
                    </TableCell>
                  )}
                  <TableCell><Badge variant="secondary" className="text-[11px]">{TYPE_LABEL[r.movement_type] ?? r.movement_type}</Badge></TableCell>
                  <TableCell className="font-mono text-xs">{r.source_number ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-success">{Number(r.qty_in) > 0 ? formatQuantity(r.qty_in) : ""}</TableCell>
                  <TableCell className="text-right tabular-nums text-destructive">{Number(r.qty_out) > 0 ? formatQuantity(r.qty_out) : ""}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatQuantity(r.balance_qty)}</TableCell>
                  {showCost && <TableCell className="text-right tabular-nums">{formatMoney(r.unit_cost)}</TableCell>}
                  {showCost && <TableCell className="text-right tabular-nums">{formatMoney(r.balance_value)}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Pager basePath="/inventory/kardex" params={{ q, branch, type, product: productId, from: from_, to: to_ }} page={page} pageSize={size} total={total} />
    </div>
  );
}
