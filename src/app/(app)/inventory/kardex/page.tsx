import type { Metadata } from "next";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
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
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  const from = (page - 1) * size, to = from + size - 1;
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");

  // Commas and brackets would break the search filter syntax.
  const term = q.replace(/[,()]/g, " ").trim();

  let query = admin.from("stock_movements")
    .select(`id, created_at, movement_type, source_type, source_id, source_number, qty_in, qty_out, unit_cost, movement_value, balance_qty, avg_cost_after, balance_value, branch:branches(code), product:products${term ? "!inner" : ""}(sku, name)`, { count: "exact" })
    .eq("company_id", ctx.companyId)
    .order("created_at", { ascending: false }).order("id", { ascending: false })
    .range(from, to);
  if (branch) query = query.eq("branch_id", branch);
  else if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  if (type) query = query.eq("movement_type", type);
  if (from_) query = query.gte("created_at", localDayStart(from_));
  if (to_) query = query.lte("created_at", localDayEnd(to_));
  if (term) query = query.or(`sku.ilike.%${term}%,name.ilike.%${term}%`, { referencedTable: "products" });

  const { data, count } = await query;
  const rows = (data ?? []) as unknown as Array<{
    id: string; created_at: string; movement_type: string; source_type: string; source_id: string | null;
    source_number: string | null; qty_in: number; qty_out: number; unit_cost: number; movement_value: number;
    balance_qty: number; avg_cost_after: number; balance_value: number;
    branch: { code: string } | null; product: { sku: string; name: string } | null;
  }>;
  const total = count ?? 0;

  return (
    <div>
      <PageHeader title="Kardex" description="Immutable stock-movement ledger. Rows cannot be edited." />
      <ListToolbar
        searchValue={q}
        searchPlaceholder="Search product SKU or name..."
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
                <TableHead>Product</TableHead>
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
                  <TableCell>
                    <div className="text-sm font-medium">{r.product?.sku}</div>
                    <div className="text-xs text-muted-foreground">{r.product?.name}</div>
                  </TableCell>
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

      <Pager basePath="/inventory/kardex" params={{ q, branch, type, from: from_, to: to_ }} page={page} pageSize={size} total={total} />
    </div>
  );
}
