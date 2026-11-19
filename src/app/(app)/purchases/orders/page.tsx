import type { Metadata } from "next";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { ClickableRow } from "@/components/common/clickable-row";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { expireOrders } from "@/lib/purchases/order-actions";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListToolbar } from "@/components/common/list-toolbar";
import { OrderStatusBadge, daysLeft } from "@/components/purchases/order-status";
import { formatDate, formatQuantity } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Purchase Orders" };
type SP = Promise<Record<string, string | string[] | undefined>>;

const STATUSES = [
  { value: "pending", label: "Pending (not fully received)" }, { value: "draft", label: "Draft" },
  { value: "confirmed", label: "Pending delivery" }, { value: "partially_received", label: "Partly received" },
  { value: "received", label: "Received" }, { value: "closed", label: "Closed" }, { value: "cancelled", label: "Cancelled" },
];

export default async function PurchaseOrdersPage(props: { searchParams: SP }) {
  await requirePermissionPage("purchases.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  await expireOrders(ctx.companyId);
  const canOrder = can(ctx.user, "purchases.order");
  const sp = await props.searchParams;
  const page = pageOf(sp), size = pageSizeOf(sp);
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  const branch = typeof sp.branch === "string" ? sp.branch : "";
  const supplier = typeof sp.supplier === "string" ? sp.supplier : "";
  const term = q.replace(/[,()%]/g, " ").trim();

  const { data: suppliers } = await admin.from("suppliers").select("id, name").eq("company_id", ctx.companyId).order("name");
  let query = admin.from("purchase_orders")
    .select("id, document_number, order_date, expected_date, status, reference, expires_at, supplier:suppliers(name), branch:branches(code), lines:purchase_order_lines(quantity, qty_received)", { count: "exact" })
    .eq("company_id", ctx.companyId).order("order_date", { ascending: false }).order("created_at", { ascending: false })
    .range((page - 1) * size, page * size - 1);
  if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  if (status === "pending") query = query.in("status", ["draft", "confirmed", "partially_received"]);
  else if (status) query = query.eq("status", status);
  if (branch) query = query.eq("branch_id", branch);
  if (supplier) query = query.eq("supplier_id", supplier);
  if (from_) query = query.gte("order_date", from_);
  if (to_) query = query.lte("order_date", to_);
  if (term) query = query.or(`document_number.ilike.%${term}%,reference.ilike.%${term}%`);
  const { data, count } = await query;
  const rows = (data ?? []) as unknown as Array<{
    id: string; document_number: string | null; order_date: string; expected_date: string | null; status: string; reference: string | null; expires_at: string;
    supplier: { name: string } | null; branch: { code: string } | null; lines: { quantity: number; qty_received: number }[];
  }>;

  return (
    <div>
      <PageHeader title="Purchase Orders"
        description="Orders to suppliers (quantities only). When goods arrive, open the order and receive it: enter the quantity received and the price, then post the purchase. Orders not received within 30 days are removed automatically; partly received ones are closed."
        actions={canOrder && <div className="flex gap-2">
          <Button asChild variant="outline"><Link href="/purchases/orders/new">New order</Link></Button>
          <Button asChild><Link href="/purchases/orders/generate"><Sparkles className="h-4 w-4" /> Generate orders</Link></Button>
        </div>} />
      <ListToolbar searchValue={q} searchPlaceholder="Search order number or reference..."
        selects={[
          { name: "status", placeholder: "All statuses", value: status, width: "w-[210px]", options: STATUSES },
          { name: "branch", placeholder: "All branches", value: branch, width: "w-[150px]", options: ctx.branches.map((b) => ({ value: b.id, label: b.code })) },
          { name: "supplier", placeholder: "All suppliers", value: supplier, width: "w-[200px]", options: (suppliers ?? []).map((x) => ({ value: x.id, label: x.name })) },
        ]}
        dates={{ from: from_, to: to_ }} />

      {rows.length === 0 ? <EmptyState title="No purchase orders" description={canOrder ? "Generate orders from past sales, or create one by hand." : undefined} /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>Order</TableHead><TableHead>Branch</TableHead><TableHead>Supplier</TableHead>
              <TableHead className="text-right">Lines</TableHead><TableHead className="text-right">Ordered</TableHead><TableHead className="text-right">Received</TableHead>
              <TableHead>Expected</TableHead><TableHead>Status</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => {
                const ordered = r.lines.reduce((a, l) => a + Number(l.quantity), 0);
                const received = r.lines.reduce((a, l) => a + Math.min(Number(l.qty_received), Number(l.quantity)), 0);
                const open = ["draft", "confirmed", "partially_received"].includes(r.status);
                const left = daysLeft(r.expires_at);
                return (
                  <ClickableRow key={r.id} href={`/purchases/orders/${r.id}`}>
                    <TableCell className="text-sm">{formatDate(r.order_date)}</TableCell>
                    <TableCell className="font-mono text-xs">{r.document_number}{r.reference && <div className="text-[11px] text-muted-foreground">{r.reference}</div>}</TableCell>
                    <TableCell className="text-sm">{r.branch?.code}</TableCell>
                    <TableCell className="text-sm">{r.supplier?.name}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.lines.length}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(ordered)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatQuantity(received)}</TableCell>
                    <TableCell className="text-sm">{r.expected_date ? formatDate(r.expected_date) : "—"}</TableCell>
                    <TableCell><OrderStatusBadge status={r.status} />
                      {open && <div className={`mt-0.5 text-[11px] ${left <= 5 ? "text-destructive" : "text-muted-foreground"}`}>{left === 0 ? "expires today" : `${left} day${left === 1 ? "" : "s"} left`}</div>}</TableCell>
                  </ClickableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
      <Pager basePath="/purchases/orders" params={{ q, status, branch, supplier, from: from_, to: to_ }} page={page} pageSize={size} total={count ?? 0} />
    </div>
  );
}
