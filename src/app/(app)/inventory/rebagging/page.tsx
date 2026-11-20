import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { ListToolbar } from "@/components/common/list-toolbar";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";
import { STATUS_VARIANT } from "./status";
import { pageBranch } from "@/lib/branch-filter";

export const metadata: Metadata = { title: "Rebagging" };

export default async function RebaggingPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  await requirePermissionPage("rebagging.view");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "rebagging"))) {
    return <div><PageHeader title="Rebagging" /><EmptyState title="Rebagging is not enabled" description="Enable it under Admin → Feature Flags." /></div>;
  }
  const admin = createAdminClient();
  const search = typeof sp.q === "string" ? sp.q.trim() : "";
  const term = search.replace(/[,()]/g, " ").trim();
  const status = typeof sp.status === "string" ? sp.status : "";
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  let q = admin.from("rebag_orders")
    .select("id, document_number, order_date, document_status, issued_kg, output_value, branch:branches(code), bulk:products!rebag_orders_bulk_product_id_fkey(name), shipment:import_shipments(id, document_number), outputs:rebag_outputs(bags, net_kg, product:products(name, net_weight_kg))", { count: "exact" })
    .eq("company_id", ctx.companyId).order("order_date", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false })
      .range((page - 1) * size, page * size - 1);
  if (!ctx.user.isOwner) q = q.in("branch_id", ctx.user.branchIds.length ? ctx.user.branchIds : ["00000000-0000-0000-0000-000000000000"]);
  if (status) q = q.eq("document_status", status);
  if (branch) q = q.eq("branch_id", branch);
  if (from_) q = q.gte("order_date", from_);
  if (to_) q = q.lte("order_date", to_);
  if (term) q = q.ilike("document_number", `%${term}%`);
  const { data, count } = await q;
  type Row = { id: string; document_number: string | null; order_date: string; document_status: string; issued_kg: number; output_value: number;
    branch: { code: string } | null; bulk: { name: string } | null; shipment: { id: string; document_number: string | null } | null;
    outputs: { bags: number; net_kg: number; product: { name: string; net_weight_kg: number } | null }[] };
  const rows = (data ?? []) as unknown as Row[];
  const open = rows.filter((r) => r.document_status === "issued");
  return (
    <div>
      <PageHeader title="Rebagging" description="Bulk into 50 / 25 / 5 kg bags: bulk issued, good bags, unused bulk, losses, packaging and labour."
        actions={can(ctx.user, "rebagging.create") ? <Button asChild><Link href="/inventory/rebagging/new">New rebagging order</Link></Button> : null} />
      <ListToolbar searchValue={search} searchPlaceholder="Search order no..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branchParam, width: "w-[140px]", options: ctx.branches.map((b) => ({ value: b.id, label: b.code })) },
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [{ value: "draft", label: "Draft" }, { value: "issued", label: "Issued" }, { value: "completed", label: "Completed" }, { value: "cancelled", label: "Cancelled" }, { value: "voided", label: "Voided" }] },
        ]}
        dates={{ from: from_, to: to_ }} />
      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card className="p-4"><p className="text-xs text-muted-foreground">In production (issued)</p><p className="text-lg font-semibold tabular-nums">{open.length}</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Bulk in production</p><p className="text-lg font-semibold tabular-nums">{formatQuantity(open.reduce((a, r) => a + Number(r.issued_kg), 0))} kg</p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">Drafts</p><p className="text-lg font-semibold tabular-nums">{rows.filter((r) => r.document_status === "draft").length}</p></Card>
      </div>
      {rows.length === 0 ? <EmptyState title="No rebagging orders yet" /> : (
        <Card><CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Order</TableHead><TableHead>Date</TableHead><TableHead>Branch</TableHead><TableHead>Bulk</TableHead><TableHead>Shipment</TableHead>
              <TableHead className="text-right">Issued kg</TableHead><TableHead>Bags</TableHead><TableHead className="text-right">Output value</TableHead><TableHead>Status</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell><Link className="font-mono text-xs underline" href={`/inventory/rebagging/${r.id}`}>{r.document_number ?? "draft"}</Link></TableCell>
                  <TableCell>{formatDate(r.order_date)}</TableCell>
                  <TableCell>{r.branch?.code}</TableCell>
                  <TableCell className="text-sm">{r.bulk?.name}</TableCell>
                  <TableCell>{r.shipment ? <Link className="font-mono text-xs underline" href={`/imports/${r.shipment.id}`}>{r.shipment.document_number}</Link> : "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.issued_kg) ? formatQuantity(Number(r.issued_kg)) : "—"}</TableCell>
                  <TableCell className="text-xs">{r.outputs.map((o, i) => <span key={i} className="mr-2 whitespace-nowrap">{formatQuantity(Number(o.bags))} × {Number(o.product?.net_weight_kg)} kg</span>)}</TableCell>
                  <TableCell className="text-right tabular-nums">{Number(r.output_value) ? formatMoney(Number(r.output_value)) : "—"}</TableCell>
                  <TableCell><Badge variant={STATUS_VARIANT[r.document_status]}>{r.document_status}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}
      <Pager basePath="/inventory/rebagging" params={{ q: search, status, branch: branchParam, from: from_, to: to_ }} page={page} pageSize={size} total={count ?? 0} />
    </div>
  );
}
