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
import { NewOpeningButton, type OpeningDraft } from "./opening-form";
import { InventoryDocActions } from "@/components/inventory/doc-actions";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { pageBranch } from "@/lib/branch-filter";

export const metadata: Metadata = { title: "Opening Balances" };

export default async function OpeningBalancesPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  await requirePermissionPage("inventory.opening_balance");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canOwner = can(ctx.user, "transactions.void");

  const { data: products } = await admin.from("products")
    .select("id, sku, name").eq("company_id", ctx.companyId).eq("is_active", true).order("sku");

  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const term = q.replace(/[,()]/g, " ").trim();
  const status = typeof sp.status === "string" ? sp.status : "";
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  let query = admin.from("inventory_openings")
    .select("id, document_number, opening_date, reference, description, branch_id, total_cost, document_status, branch:branches(code)", { count: "exact" })
    .eq("company_id", ctx.companyId).order("created_at", { ascending: false }).order("id", { ascending: false })
      .range((page - 1) * size, page * size - 1);
  if (status) query = query.eq("document_status", status);
  if (branch) query = query.eq("branch_id", branch);
  if (from_) query = query.gte("opening_date", from_);
  if (to_) query = query.lte("opening_date", to_);
  if (term) query = query.or(`document_number.ilike.%${term}%,reference.ilike.%${term}%`);
  const { data: rows, count } = await query;
  const list = (rows ?? []) as unknown as Array<{
    id: string; document_number: string | null; opening_date: string; reference: string | null;
    description: string | null; branch_id: string;
    total_cost: number; document_status: string; branch: { code: string } | null;
  }>;
  // Drafts open in the same dialog with "Edit draft".
  const draftIds = list.filter((r) => r.document_status === "draft" && ctx.branches.some((b) => b.id === r.branch_id)).map((r) => r.id);
  const { data: draftLines } = draftIds.length
    ? await admin.from("inventory_opening_lines").select("opening_id, product_id, quantity, unit_cost, line_no").in("opening_id", draftIds).order("line_no")
    : { data: [] as { opening_id: string; product_id: string; quantity: number; unit_cost: number; line_no: number }[] };
  const draftOf = (r: (typeof list)[number]): OpeningDraft => ({
    id: r.id, branchId: r.branch_id, date: r.opening_date, reference: r.reference ?? "", description: r.description ?? "",
    lines: (draftLines ?? []).filter((l) => l.opening_id === r.id).map((l) => ({ product_id: l.product_id, quantity: Number(l.quantity), unit_cost: Number(l.unit_cost) })),
  });

  return (
    <div>
      <PageHeader
        title="Opening Balances"
        description="Load starting inventory. Posting creates stock-in movements and a balanced journal."
        actions={ctx.branchId && <NewOpeningButton products={(products ?? []) as never} branchId={ctx.branchId} />}
      />
      <ListToolbar searchValue={q} searchPlaceholder="Search opening no / reference..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branchParam, width: "w-[140px]", options: ctx.branches.map((b) => ({ value: b.id, label: b.code })) },
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [{ value: "draft", label: "Draft" }, { value: "posted", label: "Posted" }, { value: "voided", label: "Voided" }] },
        ]}
        dates={{ from: from_, to: to_ }} />
      {list.length === 0 ? (
        <EmptyState title="No opening balances yet" description="Create one to load your starting stock." />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead className="text-right">Total cost</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-10 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.document_number ?? <Badge variant="muted">Draft</Badge>}</TableCell>
                  <TableCell className="text-sm">{r.branch?.code}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.opening_date)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.reference ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.total_cost)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="whitespace-nowrap text-right">
                    {draftIds.includes(r.id) && <NewOpeningButton products={(products ?? []) as never} branchId={r.branch_id} draft={draftOf(r)} />}
                    <InventoryDocActions kind="opening" id={r.id} status={r.document_status} canPost canOwner={canOwner} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager basePath="/inventory/opening-balances" params={{ q, status, branch: branchParam, from: from_, to: to_ }} page={page} pageSize={size} total={count ?? 0} />
    </div>
  );
}
