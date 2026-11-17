import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { Pager, PAGE_SIZE, pageOf } from "@/components/reports/pager";
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
  const page = pageOf(await props.searchParams);
  await requirePermissionPage("purchases.record_payment");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canOwner = can(ctx.user, "transactions.void");

  const { data: rows, count } = await admin.from("supplier_payments")
    .select("id, document_number, document_date, amount, reference, document_status, supplier:suppliers(name), branch:branches(code)", { count: "exact" })
    .eq("company_id", ctx.companyId).order("document_date", { ascending: false }).order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  const total = count ?? 0;
  const list = (rows ?? []) as unknown as Array<{ id: string; document_number: string | null; document_date: string; amount: number; reference: string | null; document_status: string; supplier: { name: string } | null; branch: { code: string } | null }>;

  return (
    <div>
      <PageHeader title="Supplier Payments" description="Payments made to suppliers against outstanding documents."
        actions={<Button asChild><Link href="/purchases/supplier-payments/new">Record Payment</Link></Button>} />
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
      <Pager basePath="/purchases/supplier-payments" params={{}} page={page} pageSize={PAGE_SIZE} total={total} />
    </div>
  );
}
