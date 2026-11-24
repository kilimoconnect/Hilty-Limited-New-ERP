import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/batch";
import { reportPeriod, addDays } from "@/lib/reports/scope";
import { Pager, pageOf, pageSizeOf, str } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PeriodFilter, ParamSelect, PrintButton, ExportCsvButton } from "@/components/reports/report-tools";
import { formatDate, formatMoney, formatQuantity, todayISO } from "@/lib/format";
import { cn } from "@/lib/utils";
import { pageBranch } from "@/lib/branch-filter";

export const metadata: Metadata = { title: "Stock Movements" };

type SP = Record<string, string | string[] | undefined>;
interface TLine {
  id: string; qty_requested: number; qty_dispatched: number; qty_received: number; qty_lost_normal: number; qty_lost_abnormal: number;
  dispatched_value: number; received_value: number; lost_value: number;
  product: { id: string; sku: string; name: string } | null;
  transfer: { id: string; document_number: string | null; transfer_date: string; status: string; source_branch_id: string; destination_branch_id: string;
    src: { code: string } | null; dst: { code: string } | null };
}
interface ALine {
  id: string; quantity: number; unit_cost: number; total_value: number;
  product: { id: string; sku: string; name: string } | null;
  adjustment: { id: string; document_number: string | null; adjustment_date: string; direction: string; reason: string; branch_id: string; branch: { code: string } | null };
}
const N = (v: unknown) => Number(v ?? 0);

export default async function StockMovementsPage(props: { searchParams: Promise<SP> }) {
  await requirePermissionPage("report.stock_movements");
  const ctx = await getActiveContext();
  const sp = await props.searchParams;
  const view = str(sp, "view") === "adjustments" ? "adjustments" : "transfers";
  const { start, end } = reportPeriod(sp, addDays(todayISO(), -89));
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const side = ["out", "in"].includes(str(sp, "side")) ? str(sp, "side") : "";
  const productId = str(sp, "product");
  const direction = ["increase", "decrease"].includes(str(sp, "direction")) ? str(sp, "direction") : "";
  const page = pageOf(sp), size = pageSizeOf(sp);
  const showCost = can(ctx.user, "inventory.view_cost");
  const mine = ctx.user.isOwner ? null : ctx.user.branchIds;
  const admin = createAdminClient();

  const products = await selectAll<{ id: string; sku: string; name: string }>(() =>
    admin.from("products").select("id, sku, name").eq("company_id", ctx.companyId).order("sku").order("id"));

  // ---------- transfers ----------
  let tlines: TLine[] = [];
  if (view === "transfers") {
    tlines = await selectAll<TLine>(() => {
      let q = admin.from("stock_transfer_lines")
        .select("id, qty_requested, qty_dispatched, qty_received, qty_lost_normal, qty_lost_abnormal, dispatched_value, received_value, lost_value, product:products(id, sku, name), transfer:stock_transfers!inner(id, document_number, transfer_date, status, company_id, source_branch_id, destination_branch_id, src:branches!stock_transfers_source_branch_id_fkey(code), dst:branches!stock_transfers_destination_branch_id_fkey(code))")
        .eq("transfer.company_id", ctx.companyId).neq("transfer.status", "draft").neq("transfer.status", "voided")
        .gte("transfer.transfer_date", start).lte("transfer.transfer_date", end);
      if (productId) q = q.eq("product_id", productId);
      return q.order("id");
    });
    tlines = tlines.filter((l) => {
      const t = l.transfer;
      if (mine && !mine.includes(t.source_branch_id) && !mine.includes(t.destination_branch_id)) return false;
      if (!branch) return true;
      if (side === "out") return t.source_branch_id === branch;
      if (side === "in") return t.destination_branch_id === branch;
      return t.source_branch_id === branch || t.destination_branch_id === branch;
    }).sort((a, b) => b.transfer.transfer_date.localeCompare(a.transfer.transfer_date) || (b.transfer.document_number ?? "").localeCompare(a.transfer.document_number ?? ""));
  }
  const routes = new Map<string, { route: string; transfers: Set<string>; sent: number; received: number; lost: number; value: number }>();
  for (const l of tlines) {
    const k = `${l.transfer.src?.code} → ${l.transfer.dst?.code}`;
    const r = routes.get(k) ?? { route: k, transfers: new Set<string>(), sent: 0, received: 0, lost: 0, value: 0 };
    r.transfers.add(l.transfer.id); r.sent += N(l.qty_dispatched); r.received += N(l.qty_received);
    r.lost += N(l.qty_lost_normal) + N(l.qty_lost_abnormal); r.value += N(l.dispatched_value);
    routes.set(k, r);
  }

  // ---------- adjustments ----------
  let alines: ALine[] = [];
  if (view === "adjustments") {
    alines = await selectAll<ALine>(() => {
      let q = admin.from("stock_adjustment_lines")
        .select("id, quantity, unit_cost, total_value, product:products(id, sku, name), adjustment:stock_adjustments!inner(id, document_number, adjustment_date, direction, reason, branch_id, company_id, document_status, branch:branches(code))")
        .eq("adjustment.company_id", ctx.companyId).eq("adjustment.document_status", "posted")
        .gte("adjustment.adjustment_date", start).lte("adjustment.adjustment_date", end);
      if (productId) q = q.eq("product_id", productId);
      if (direction) q = q.eq("adjustment.direction", direction);
      if (branch) q = q.eq("adjustment.branch_id", branch);
      else if (mine) q = q.in("adjustment.branch_id", mine.length ? mine : ["00000000-0000-0000-0000-000000000000"]);
      return q.order("id");
    });
    alines.sort((a, b) => b.adjustment.adjustment_date.localeCompare(a.adjustment.adjustment_date));
  }
  const perBranch = new Map<string, { code: string; incQty: number; incValue: number; decQty: number; decValue: number }>();
  for (const l of alines) {
    const k = l.adjustment.branch?.code ?? "—";
    const r = perBranch.get(k) ?? { code: k, incQty: 0, incValue: 0, decQty: 0, decValue: 0 };
    if (l.adjustment.direction === "increase") { r.incQty += N(l.quantity); r.incValue += N(l.total_value); }
    else { r.decQty += N(l.quantity); r.decValue += N(l.total_value); }
    perBranch.set(k, r);
  }

  const total = view === "transfers" ? tlines.length : alines.length;
  const tPage = tlines.slice((page - 1) * size, page * size);
  const aPage = alines.slice((page - 1) * size, page * size);
  const csv = view === "transfers"
    ? tlines.map((l) => [l.transfer.transfer_date, l.transfer.document_number ?? "", l.transfer.src?.code ?? "", l.transfer.dst?.code ?? "", l.product?.sku ?? "", l.product?.name ?? "",
      N(l.qty_dispatched), N(l.qty_received), N(l.qty_lost_normal) + N(l.qty_lost_abnormal), ...(showCost ? [N(l.dispatched_value), N(l.received_value)] : []), l.transfer.status])
    : alines.map((l) => [l.adjustment.adjustment_date, l.adjustment.document_number ?? "", l.adjustment.branch?.code ?? "", l.adjustment.direction, l.product?.sku ?? "", l.product?.name ?? "",
      N(l.quantity), ...(showCost ? [N(l.unit_cost), N(l.total_value)] : []), l.adjustment.reason]);
  const header = view === "transfers"
    ? ["Date", "Transfer", "From", "To", "SKU", "Product", "Sent", "Received", "Lost", ...(showCost ? ["Value sent", "Value received"] : []), "Status"]
    : ["Date", "Adjustment", "Branch", "Direction", "SKU", "Product", "Qty", ...(showCost ? ["Unit cost", "Value"] : []), "Reason"];
  const tab = (v: string, label: string) => {
    const q = new URLSearchParams({ start, end, ...(branch && { branch }), ...(productId && { product: productId }), ...(v === "adjustments" && { view: v }) });
    return <Link href={`/reports/stock-movements?${q}`} className={cn("rounded-md px-3 py-1.5 text-sm", view === v ? "bg-primary text-primary-foreground" : "border border-border hover:bg-muted")}>{label}</Link>;
  };

  return (
    <div>
      <PageHeader title="Stock Movements" description="Stock transfers between branches and stock adjustments, by period, branch and product."
        actions={<div className="flex gap-2"><PrintButton /><ExportCsvButton filename={`${view}-${start}-to-${end}.csv`} header={header} rows={csv} /></div>} />
      <div className="mb-3 flex flex-wrap gap-2">{tab("transfers", "Transfers")}{tab("adjustments", "Adjustments")}</div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <PeriodFilter start={start} end={end} />
        <ParamSelect param="branch" value={branchParam} placeholder={ctx.user.isOwner ? "All branches" : "All my branches"}
          options={ctx.branches.map((b) => ({ id: b.id, label: `${b.code} - ${b.name}` }))} />
        {view === "transfers" && branch && <ParamSelect param="side" value={side} placeholder="Sent or received"
          options={[{ id: "out", label: "Sent from this branch" }, { id: "in", label: "Received at this branch" }]} />}
        {view === "adjustments" && <ParamSelect param="direction" value={direction} placeholder="Increases and decreases"
          options={[{ id: "increase", label: "Increases only" }, { id: "decrease", label: "Decreases only" }]} />}
        <ParamSelect param="product" value={productId} placeholder="All products" options={products.map((p) => ({ id: p.id, label: `${p.sku} - ${p.name}` }))} />
      </div>

      {view === "transfers" ? (
        <>
          {routes.size > 0 && (
            <Card className="mb-4 overflow-x-auto"><Table>
              <TableHeader><TableRow><TableHead>Route</TableHead><TableHead className="text-right">Transfers</TableHead>
                <TableHead className="text-right">Units sent</TableHead><TableHead className="text-right">Units received</TableHead><TableHead className="text-right">Lost</TableHead>
                {showCost && <TableHead className="text-right">Value sent</TableHead>}</TableRow></TableHeader>
              <TableBody>{Array.from(routes.values()).sort((a, b) => b.value - a.value || b.sent - a.sent).map((r) => (
                <TableRow key={r.route}>
                  <TableCell className="font-medium">{r.route}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.transfers.size}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(r.sent)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatQuantity(r.received)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums", r.lost > 0 && "text-destructive")}>{formatQuantity(r.lost)}</TableCell>
                  {showCost && <TableCell className="text-right tabular-nums">{formatMoney(r.value)}</TableCell>}
                </TableRow>))}</TableBody>
            </Table></Card>
          )}
          {tPage.length === 0 ? <EmptyState title="No stock transfers in this period" /> : (
            <Card className="overflow-x-auto"><Table>
              <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Transfer</TableHead><TableHead>Route</TableHead><TableHead>Product</TableHead>
                <TableHead className="text-right">Sent</TableHead><TableHead className="text-right">Received</TableHead><TableHead className="text-right">Lost</TableHead>
                {showCost && <TableHead className="text-right">Value</TableHead>}<TableHead>Status</TableHead></TableRow></TableHeader>
              <TableBody>{tPage.map((l) => {
                const lost = N(l.qty_lost_normal) + N(l.qty_lost_abnormal);
                const pending = N(l.qty_dispatched) - N(l.qty_received) - lost;
                return (
                  <TableRow key={l.id}>
                    <TableCell className="whitespace-nowrap text-sm">{formatDate(l.transfer.transfer_date)}</TableCell>
                    <TableCell className="font-mono text-xs"><Link className="text-primary hover:underline" href={`/inventory/transfers/${l.transfer.id}`}>{l.transfer.document_number}</Link></TableCell>
                    <TableCell className="whitespace-nowrap text-sm">{l.transfer.src?.code} → {l.transfer.dst?.code}</TableCell>
                    <TableCell><div className="text-sm">{l.product?.name}</div><div className="font-mono text-[11px] text-muted-foreground">{l.product?.sku}</div></TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(l.qty_dispatched)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(l.qty_received)}{pending > 0 && <div className="text-[11px] text-warning">{formatQuantity(pending)} pending</div>}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", lost > 0 && "text-destructive")}>{lost ? formatQuantity(lost) : "—"}</TableCell>
                    {showCost && <TableCell className="text-right tabular-nums">{formatMoney(N(l.dispatched_value))}</TableCell>}
                    <TableCell><DocStatusBadge status={l.transfer.status} /></TableCell>
                  </TableRow>
                );
              })}</TableBody>
            </Table></Card>
          )}
        </>
      ) : (
        <>
          {perBranch.size > 0 && (
            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
              {Array.from(perBranch.values()).map((r) => (
                <Card key={r.code} className="p-4">
                  <p className="text-sm font-semibold">{r.code}</p>
                  <p className="text-sm tabular-nums text-success">+{formatQuantity(r.incQty)} units{showCost && ` · ${formatMoney(r.incValue)}`}</p>
                  <p className="text-sm tabular-nums text-destructive">−{formatQuantity(r.decQty)} units{showCost && ` · ${formatMoney(r.decValue)}`}</p>
                </Card>
              ))}
            </div>
          )}
          {aPage.length === 0 ? <EmptyState title="No posted stock adjustments in this period" /> : (
            <Card className="overflow-x-auto"><Table>
              <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Adjustment</TableHead><TableHead>Branch</TableHead><TableHead>Product</TableHead>
                <TableHead className="text-right">Qty</TableHead>{showCost && <><TableHead className="text-right">Unit cost</TableHead><TableHead className="text-right">Value</TableHead></>}
                <TableHead>Reason</TableHead></TableRow></TableHeader>
              <TableBody>{aPage.map((l) => {
                const inc = l.adjustment.direction === "increase";
                return (
                  <TableRow key={l.id}>
                    <TableCell className="whitespace-nowrap text-sm">{formatDate(l.adjustment.adjustment_date)}</TableCell>
                    <TableCell className="font-mono text-xs">{l.adjustment.document_number}</TableCell>
                    <TableCell className="text-sm">{l.adjustment.branch?.code}</TableCell>
                    <TableCell><div className="text-sm">{l.product?.name}</div><div className="font-mono text-[11px] text-muted-foreground">{l.product?.sku}</div></TableCell>
                    <TableCell className="text-right tabular-nums"><Badge variant={inc ? "success" : "destructive"}>{inc ? "+" : "−"}{formatQuantity(l.quantity)}</Badge></TableCell>
                    {showCost && <><TableCell className="text-right tabular-nums">{formatMoney(N(l.unit_cost))}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(N(l.total_value))}</TableCell></>}
                    <TableCell className="max-w-64 text-sm text-muted-foreground">{l.adjustment.reason}</TableCell>
                  </TableRow>
                );
              })}</TableBody>
            </Table></Card>
          )}
        </>
      )}
      <Pager basePath="/reports/stock-movements"
        params={{ start, end, branch: branchParam, product: productId, ...(view === "adjustments" ? { view, direction } : { side }) }}
        page={page} pageSize={size} total={total} />
    </div>
  );
}
