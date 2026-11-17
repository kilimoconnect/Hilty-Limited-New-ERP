import type { Metadata } from "next";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { ListToolbar } from "@/components/common/list-toolbar";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatMoney } from "@/lib/format";
import { RefundButton } from "./refund-button";

export const metadata: Metadata = { title: "Supplier Credits" };

export default async function SupplierCreditsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  await requirePermissionPage("purchases.view");
  const ctx = await getActiveContext();
  const admin = createAdminClient();
  const supplier = typeof sp.supplier === "string" ? sp.supplier : "";
  const status = typeof sp.status === "string" ? sp.status : "";
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  const { data: suppliers } = await admin.from("suppliers").select("id, name").eq("company_id", ctx.companyId).order("name");
  let creditQuery = admin.from("supplier_credits").select("id, amount, remaining, fc_remaining, currency_code, credit_date, status, supplier:suppliers(name), return:purchase_returns(document_number), refunds:supplier_credit_refunds(amount, refund_date, reference)", { count: "exact" })
      .eq("company_id", ctx.companyId).order("credit_date", { ascending: false }).order("id", { ascending: false })
      .range((page - 1) * size, page * size - 1);
  if (supplier) creditQuery = creditQuery.eq("supplier_id", supplier);
  if (status) creditQuery = creditQuery.eq("status", status);
  if (from_) creditQuery = creditQuery.gte("credit_date", from_);
  if (to_) creditQuery = creditQuery.lte("credit_date", to_);
  const [{ data: credits, count }, { data: accounts }] = await Promise.all([
    creditQuery,
    admin.from("payment_accounts").select("id, name").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
  ]);
  type C = { id: string; amount: number; remaining: number; fc_remaining: number; currency_code: string; credit_date: string; status: string;
    supplier: { name: string } | null; return: { document_number: string | null } | null; refunds: { amount: number; refund_date: string; reference: string | null }[] };
  const rows = (credits ?? []) as unknown as C[];
  const canRefund = can(ctx.user, "purchases.record_payment");
  return (
    <div>
      <PageHeader title="Supplier Credits" description="Credits from returns and supplier credit notes. Use them on later invoices (from the invoice) or record the supplier's cash refund here." />
      <ListToolbar searchPlaceholder="Search..."
        selects={[
          { name: "supplier", placeholder: "All suppliers", value: supplier, width: "w-[200px]", options: (suppliers ?? []).map((x) => ({ value: x.id, label: x.name })) },
          { name: "status", placeholder: "All statuses", value: status, width: "w-[150px]", options: [{ value: "open", label: "Open" }, { value: "used", label: "Used" }, { value: "voided", label: "Voided" }] },
        ]}
        dates={{ from: from_, to: to_ }} />
      {rows.length === 0 ? <EmptyState title="No supplier credits" /> : (
        <Card className="overflow-x-auto">
          <Table>
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Supplier</TableHead><TableHead>Source</TableHead><TableHead className="text-right">Credit</TableHead>
              <TableHead className="text-right">Open</TableHead><TableHead>Refunds</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {rows.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{formatDate(c.credit_date)}</TableCell>
                  <TableCell>{c.supplier?.name}</TableCell>
                  <TableCell className="text-xs">{c.return?.document_number ? `Return ${c.return.document_number}` : "Credit note"}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.currency_code} {formatMoney(Number(c.amount))}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.currency_code === "TZS" ? formatMoney(Number(c.remaining)) : `${c.currency_code} ${formatMoney(Number(c.fc_remaining))}`}</TableCell>
                  <TableCell className="text-xs">{c.refunds.map((r, i) => <p key={i}>{formatDate(r.refund_date)} · {formatMoney(Number(r.amount))}{r.reference && ` · ${r.reference}`}</p>)}</TableCell>
                  <TableCell>{canRefund && c.status === "open" && c.currency_code === "TZS" && Number(c.remaining) > 0 &&
                    <RefundButton creditId={c.id} open={Number(c.remaining)} accounts={(accounts ?? []).map((a) => ({ id: a.id, label: a.name }))} />}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <Pager basePath="/purchases/supplier-credits" params={{ supplier, status, from: from_, to: to_ }} page={page} pageSize={size} total={count ?? 0} />
    </div>
  );
}
