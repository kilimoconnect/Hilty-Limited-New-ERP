import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { ListToolbar } from "@/components/common/list-toolbar";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { voidFinancialOpening } from "@/lib/cash/actions";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { DocStatusBadge } from "@/components/common/doc-status-badge";
import { TxnActions } from "@/components/common/txn-actions";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { NewOpeningButton } from "./opening-form";

export const metadata: Metadata = { title: "Financial Opening Balances" };

export default async function FinancialOpeningsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  await requirePermissionPage("cash_accounts.opening_balance");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const canOwner = can(ctx.user, "transactions.void");

  const { data: accounts } = await admin.from("payment_accounts").select("id, name").eq("company_id", ctx.companyId).eq("is_active", true).order("code");
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const term = q.replace(/[,()]/g, " ").trim();
  const status = typeof sp.status === "string" ? sp.status : "";
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  let query = admin.from("financial_opening_balances")
    .select("id, document_number, opening_date, reference, total_debit, total_credit, document_status", { count: "exact" })
    .eq("company_id", ctx.companyId).order("created_at", { ascending: false }).order("id", { ascending: false })
      .range((page - 1) * size, page * size - 1);
  if (status) query = query.eq("document_status", status);
  if (from_) query = query.gte("opening_date", from_);
  if (to_) query = query.lte("opening_date", to_);
  if (term) query = query.or(`document_number.ilike.%${term}%,reference.ilike.%${term}%,description.ilike.%${term}%`);
  const { data: rows, count } = await query;
  const list = (rows ?? []) as unknown as Array<{ id: string; document_number: string | null; opening_date: string; reference: string | null; total_debit: number; total_credit: number; document_status: string }>;

  return (
    <div>
      <PageHeader title="Financial Opening Balances" description="Initial cash, bank and mobile-money balances. Owner only."
        actions={<NewOpeningButton accounts={(accounts ?? []) as never} />} />
      <ListToolbar searchValue={q} searchPlaceholder="Search opening no / reference..."
        selects={[
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [{ value: "draft", label: "Draft" }, { value: "posted", label: "Posted" }, { value: "voided", label: "Voided" }] },
        ]}
        dates={{ from: from_, to: to_ }} />
      {list.length === 0 ? <EmptyState title="No opening balances yet" description="Post one to establish starting account balances." /> : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Document</TableHead><TableHead>Date</TableHead><TableHead>Reference</TableHead><TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead><TableHead>Status</TableHead><TableHead className="w-10 text-right">Actions</TableHead></TableRow></TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-xs">{r.document_number ?? "—"}</TableCell>
                  <TableCell className="text-sm">{formatDate(r.opening_date)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.reference ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.total_debit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(r.total_credit)}</TableCell>
                  <TableCell><DocStatusBadge status={r.document_status} /></TableCell>
                  <TableCell className="text-right"><TxnActions id={r.id} status={r.document_status} canOwner={canOwner} voidAction={voidFinancialOpening} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager basePath="/cash-and-banks/opening-balances" params={{ q, status, from: from_, to: to_ }} page={page} pageSize={size} total={count ?? 0} />
    </div>
  );
}
