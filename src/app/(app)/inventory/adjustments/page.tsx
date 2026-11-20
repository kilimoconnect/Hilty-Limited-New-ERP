import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { ListToolbar } from "@/components/common/list-toolbar";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, formatDate } from "@/lib/format";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { NewAdjustmentButton, type AdjustmentDraft } from "./adjustment-form";
import { InventoryDocActions } from "@/components/inventory/doc-actions";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { pageBranch } from "@/lib/branch-filter";

export const metadata: Metadata = { title: "Stock Adjustments" };

export default async function AdjustmentsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  await requirePermissionPage("inventory.adjustment_create");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canPost = can(ctx.user, "inventory.adjustment_post");
  const canOwner = can(ctx.user, "transactions.void");

  const { data: products } = await admin.from("products")
    .select("id, sku, name").eq("company_id", ctx.companyId).eq("is_active", true).order("sku");

  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const term = q.replace(/[,()]/g, " ").trim();
  const status = typeof sp.status === "string" ? sp.status : "";
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const direction = typeof sp.direction === "string" ? sp.direction : "";
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  let query = admin.from("stock_adjustments")
    .select("id, document_number, adjustment_date, direction, reason, description, reference, branch_id, total_value, document_status, branch:branches(code)", { count: "exact" })
    .eq("company_id", ctx.companyId).order("created_at", { ascending: false }).order("id", { ascending: false })
      .range((page - 1) * size, page * size - 1);
  if (status) query = query.eq("document_status", status);
  if (branch) query = query.eq("branch_id", branch);
  if (direction) query = query.eq("direction", direction);
  if (from_) query = query.gte("adjustment_date", from_);
  if (to_) query = query.lte("adjustment_date", to_);
  if (term) query = query.or(`document_number.ilike.%${term}%,reason.ilike.%${term}%`);
  const { data: rows, count } = await query;
  const list = (rows ?? []) as unknown as Array<{
    id: string; document_number: string | null; adjustment_date: string; direction: string;
    reason: string; description: string | null; reference: string | null; branch_id: string;
    total_value: number; document_status: string; branch: { code: string } | null;
  }>;
  // Drafts open in the same dialog with "Edit draft".
  const draftIds = list.filter((r) => r.document_status === "draft" && ctx.branches.some((b) => b.id === r.branch_id)).map((r) => r.id);
  const { data: draftLines } = draftIds.length
    ? await admin.from("stock_adjustment_lines").select("adjustment_id, product_id, quantity, unit_cost, line_no").in("adjustment_id", draftIds).order("line_no")
    : { data: [] as { adjustment_id: string; product_id: string; quantity: number; unit_cost: number; line_no: number }[] };
  const draftOf = (r: (typeof list)[number]): AdjustmentDraft => ({
    id: r.id, branchId: r.branch_id, date: r.adjustment_date, direction: r.direction === "increase" ? "increase" : "decrease",
    reason: r.reason, description: r.description ?? "", reference: r.reference ?? "",
    lines: (draftLines ?? []).filter((l) => l.adjustment_id === r.id).map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit_cost: Number(l.unit_cost) })),
  });

  return (
    <div>
      <PageHeader
        title="Stock Adjustments"
        description="Correct stock for damage, loss, counts and data fixes."
        actions={ctx.branchId && <NewAdjustmentButton products={(products ?? []) as never} branchId={ctx.branchId} canPost={canPost} />}
      />
      <ListToolbar searchValue={q} searchPlaceholder="Search adjustment no / reason..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branchParam, width: "w-[140px]", options: ctx.branches.map((b) => ({ value: b.id, label: b.code })) },
          { name: "direction", placeholder: "All directions", value: direction, width: "w-[190px]", options: [{ value: "increase", label: "Increase" }, { value: "decrease", label: "Decrease" }] },
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [{ value: "draft", label: "Draft" }, { value: "posted", label: "Posted" }, { value: "voided", label: "Voided" }] },
        ]}
        dates={{ from: from_, to: to_ }} />
      {list.length === 0 ? (
        <EmptyState title="No adjustments yet" />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.document_number ? <a href={`/print/stock-adjustment/${r.id}`} target="_blank" rel="noopener" className="text-primary hover:underline" title="Print">{r.document_number}</a> : <Badge variant="muted">Draft</Badge>}</TableCell>
                  <TableCell className="text-sm">{r.branch?.code}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.adjustment_date)}</TableCell>
                  <TableCell><Badge variant={r.direction === "increase" ? "success" : "warning"}>{r.direction === "increase" ? "Increase" : "Decrease"}</Badge></TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.reason}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.total_value)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {draftIds.includes(r.id) && <NewAdjustmentButton products={(products ?? []) as never} branchId={r.branch_id} canPost={canPost} draft={draftOf(r)} />}
                    <InventoryDocActions kind="adjustment" id={r.id} status={r.document_status} canPost={canPost} canOwner={canOwner} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager basePath="/inventory/adjustments" params={{ q, status, branch: branchParam, direction, from: from_, to: to_ }} page={page} pageSize={size} total={count ?? 0} />
    </div>
  );
}
