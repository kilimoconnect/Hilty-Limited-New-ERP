import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/batch";
import { Pager, PAGE_SIZE, pageOf } from "@/components/reports/pager";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { formatMoney, formatDate } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const metadata: Metadata = { title: "Account Ledger" };
type Params = Promise<{ id: string }>;

const TYPE_LABEL: Record<string, string> = {
  sale: "Sale", customer_receipt: "Customer receipt", sale_void: "Sale void", sales_return: "Sales return",
  purchase: "Purchase", supplier_payment: "Supplier payment", purchase_return: "Purchase return",
  expense: "Expense", other_income: "Other income", cash_transfer: "Cash transfer",
  financial_opening_line: "Opening balance", cash_transfer_void: "Transfer void", expense_void: "Expense void",
};

export default async function AccountLedgerPage(props: { params: Params; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermissionPage("cash_accounts.view_ledger");
  const ctx = await getActiveContext();
  const { id } = await props.params;
  const page = pageOf(await props.searchParams);
  const admin = createAdminClient();

  const { data: pa } = await admin.from("payment_accounts").select("id, code, name, ledger_account_id, company_id").eq("id", id).maybeSingle();
  if (!pa || pa.company_id !== ctx.companyId || !pa.ledger_account_id) notFound();

  // Every line is needed for the running balance; the page then shows 50 at a time.
  type Row = { id: string; debit: number; credit: number; journal: { entry_date: string; created_at: string; source_type: string; source_number: string | null; memo: string | null } };
  const rows = (await selectAll<Row>(() => admin.from("journal_lines")
    .select("id, debit, credit, journal:journal_entries!inner(entry_date, created_at, source_type, source_number, memo)")
    .eq("account_id", pa.ledger_account_id).order("id")))
    .sort((a, b) => a.journal.entry_date.localeCompare(b.journal.entry_date) || a.journal.created_at.localeCompare(b.journal.created_at) || a.id.localeCompare(b.id));
  const all: (Row & { running: number })[] = [];
  for (const r of rows) {
    const prev = all.length ? all[all.length - 1].running : 0;
    all.push({ ...r, running: Math.round((prev + Number(r.debit) - Number(r.credit)) * 100) / 100 });
  }
  const closing = all.length ? all[all.length - 1].running : 0;
  const ledger = all.slice().reverse().slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div>
      <PageHeader title={`Ledger — ${pa.name}`} description="Derived from posted journal entries. Immutable." />
      <Card className="mb-4"><CardContent className="flex flex-wrap gap-8 p-5 text-sm">
        <div><p className="text-xs uppercase text-muted-foreground">Movements</p><p className="font-semibold">{all.length}</p></div>
        <div><p className="text-xs uppercase text-muted-foreground">Closing balance</p><p className="font-semibold tabular-nums">{formatMoney(closing)}</p></div>
      </CardContent></Card>
      {ledger.length === 0 ? <EmptyState title="No transactions on this account yet" /> : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Document</TableHead>
              <TableHead className="text-right">Money in</TableHead><TableHead className="text-right">Money out</TableHead><TableHead className="text-right">Balance</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {ledger.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs tabular-nums">{formatDate(r.journal.entry_date)}</TableCell>
                  <TableCell><Badge variant="secondary" className="text-[11px]">{TYPE_LABEL[r.journal.source_type] ?? r.journal.source_type}</Badge></TableCell>
                  <TableCell className="font-mono text-xs">{r.journal.source_number ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums text-success">{Number(r.debit) > 0 ? formatMoney(r.debit) : ""}</TableCell>
                  <TableCell className="text-right tabular-nums text-destructive">{Number(r.credit) > 0 ? formatMoney(r.credit) : ""}</TableCell>
                  <TableCell className="text-right tabular-nums font-medium">{formatMoney(r.running)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Pager basePath={`/cash-and-banks/accounts/${id}`} params={{}} page={page} pageSize={PAGE_SIZE} total={all.length} />
    </div>
  );
}
