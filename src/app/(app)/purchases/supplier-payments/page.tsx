import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { ListToolbar } from "@/components/common/list-toolbar";
import { voidSupplierPayment } from "@/lib/purchases/actions";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { TxnActions } from "@/components/common/txn-actions";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Supplier Payments" };

export default async function SupplierPaymentsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  await requirePermissionPage("purchases.record_payment");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canOwner = can(ctx.user, "transactions.void");
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  const branch = typeof sp.branch === "string" ? sp.branch : "";
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  const term = q.replace(/[,()]/g, " ").trim();
  const supplier = typeof sp.supplier === "string" ? sp.supplier : "";
  const { data: suppliers } = await admin.from("suppliers").select("id, name").eq("company_id", ctx.companyId).order("name");

  let query = admin.from("supplier_payments")
    .select("id, document_number, document_date, amount, reference, document_status, supplier:suppliers(name), branch:branches(code)", { count: "exact" })
    .eq("company_id", ctx.companyId).order("document_date", { ascending: false }).order("created_at", { ascending: false })
    .range((page - 1) * size, page * size - 1);
  if (!ctx.user.isOwner) query = query.in("branch_id", ctx.branches.map((b) => b.id));
  if (status) query = query.eq("document_status", status);
  if (branch) query = query.eq("branch_id", branch);
  if (supplier) query = query.eq("supplier_id", supplier);
  if (from_) query = query.gte("document_date", from_);
  if (to_) query = query.lte("document_date", to_);
  if (term) query = query.or(`document_number.ilike.%${term}%,reference.ilike.%${term}%`);
  const { data: rows, count } = await query;
  const total = count ?? 0;
  const list = (rows ?? []) as unknown as Array<{ id: string; document_number: string | null; document_date: string; amount: number; reference: string | null; document_status: string; supplier: { name: string } | null; branch: { code: string } | null }>;

  return (
    <div>
      <PageHeader title="Supplier Payments" description="Payments made to suppliers against outstanding documents."
        actions={<Button asChild><Link href="/purchases/supplier-payments/new">Record Payment</Link></Button>} />
      <ListToolbar searchValue={q} searchPlaceholder="Search payment no / reference..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branch, width: "w-[140px]", options: ctx.branches.map((b) => ({ value: b.id, label: b.code })) },
          { name: "supplier", placeholder: "All suppliers", value: supplier, width: "w-[200px]", options: (suppliers ?? []).map((x) => ({ value: x.id, label: x.name })) },
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [{ value: "draft", label: "Draft" }, { value: "posted", label: "Posted" }, { value: "voided", label: "Voided" }] },
        ]}
        dates={{ from: from_, to: to_ }} />
      {list.length === 0 ? <EmptyState title="No supplier payments yet" /> : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Payment no.</TableHead><TableHead>Date</TableHead><TableHead>Supplier</TableHead>
              <TableHead>Reference</TableHead><TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead><TableHead className="w-10 text-right">Actions</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.document_number ?? "—"}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.document_date)}</TableCell>
                  <TableCell className="text-sm">{r.supplier?.name}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.reference ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.amount)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right">
                    <TxnActions id={r.id} status={r.document_status} canOwner={canOwner} voidAction={voidSupplierPayment}
                      extraItems={[{ label: "View", href: `/purchases/supplier-payments/${r.id}` }]} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager basePath="/purchases/supplier-payments" params={{ q, status, branch, supplier, from: from_, to: to_ }} page={page} pageSize={size} total={total} />
    </div>
  );
}
