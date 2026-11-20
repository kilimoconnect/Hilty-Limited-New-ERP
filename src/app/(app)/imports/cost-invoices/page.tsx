import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { ListToolbar } from "@/components/common/list-toolbar";
import { Pager, pageOf, pageSizeOf, dateParam } from "@/components/reports/pager";
import { isFeatureEnabled } from "@/lib/features";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatMoney } from "@/lib/format";
import { VoidCostInvoiceButton } from "./void-button";
import { pageBranch } from "@/lib/branch-filter";

export const metadata: Metadata = { title: "Cost Invoices" };

export default async function CostInvoicesPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await props.searchParams;
  const page = pageOf(sp);
  const size = pageSizeOf(sp);
  await requirePermissionPage("cost_invoices.view");
  const ctx = await getActiveContext();
  if (!(await isFeatureEnabled(ctx.companyId, "imports"))) {
    return <div><PageHeader title="Cost Invoices" /><EmptyState title="Importation is not enabled" /></div>;
  }
  const admin = createAdminClient();
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const term = q.replace(/[,()]/g, " ").trim();
  // No ?branch= -> the header branch; ?branch=all -> every branch of the user.
  const { branch, branchParam } = pageBranch(ctx, sp);
  const supplier = typeof sp.supplier === "string" ? sp.supplier : "";
  const from_ = dateParam(sp, "from"), to_ = dateParam(sp, "to");
  const { data: supplierOptions } = await admin.from("suppliers").select("id, name").eq("company_id", ctx.companyId).order("name");
  let query = admin.from("cost_invoices")
    .select("id, document_number, document_date, document_kind, document_status, supplier_invoice_number, net_total, tax_total, grand_total, supplier:suppliers(name), credited:credited_invoice_id(document_number), lines:cost_invoice_lines(cost_source:cost_sources(import_shipment:import_shipments(id, document_number), rebag_order:rebag_orders(id, document_number)))", { count: "exact" })
    .eq("company_id", ctx.companyId).neq("document_status", "draft").order("document_date", { ascending: false }).order("id", { ascending: false })
      .range((page - 1) * size, page * size - 1);
  if (branch) query = query.eq("branch_id", branch);
  if (supplier) query = query.eq("supplier_id", supplier);
  if (from_) query = query.gte("document_date", from_);
  if (to_) query = query.lte("document_date", to_);
  if (term) query = query.or(`document_number.ilike.%${term}%,supplier_invoice_number.ilike.%${term}%`);
  const { data, count } = await query;
  type Row = {
    id: string; document_number: string | null; document_date: string; document_kind: string; document_status: string;
    supplier_invoice_number: string | null; net_total: number; tax_total: number; grand_total: number;
    supplier: { name: string } | null; credited: { document_number: string | null } | null;
    lines: { cost_source: { import_shipment: { id: string; document_number: string | null } | null; rebag_order: { id: string; document_number: string | null } | null } | null }[];
  };
  const rows = (data ?? []) as unknown as Row[];
  return (
    <div>
      <PageHeader title="Cost Invoices" description="Freight, clearing, port, transport and other service invoices (TZS) for import shipments."
        actions={can(ctx.user, "cost_invoices.post") ? <Button asChild><Link href="/imports/cost-invoices/new">New cost invoice</Link></Button> : null} />
      <ListToolbar searchValue={q} searchPlaceholder="Search invoice no / supplier invoice..."
        selects={[
          { name: "branch", placeholder: "All branches", value: branchParam, width: "w-[140px]", options: ctx.branches.map((b) => ({ value: b.id, label: b.code })) },
          { name: "supplier", placeholder: "All suppliers", value: supplier, width: "w-[190px]", options: (supplierOptions ?? []).map((o) => ({ value: o.id, label: o.name })) },
        ]}
        dates={{ from: from_, to: to_ }} />
      {rows.length === 0 ? <EmptyState title="No cost invoices yet" /> : (
        <Card><CardContent className="p-0">
          <Table>
            <TableHeader><TableRow>
              <TableHead>Number</TableHead><TableHead>Date</TableHead><TableHead>Supplier</TableHead><TableHead>Supplier doc.</TableHead>
              <TableHead>Shipments / rebagging</TableHead><TableHead className="text-right">Net</TableHead><TableHead className="text-right">Tax</TableHead>
              <TableHead className="text-right">Total (TZS)</TableHead><TableHead>Status</TableHead><TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {rows.map((r) => {
                const ships = new Map<string, string>();
                r.lines.forEach((l) => {
                  const s = l.cost_source?.import_shipment; if (s) ships.set(`/imports/${s.id}`, s.document_number ?? "—");
                  const o = l.cost_source?.rebag_order; if (o) ships.set(`/inventory/rebagging/${o.id}`, o.document_number ?? "—");
                });
                const sign = r.document_kind === "credit_note" ? -1 : 1;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.document_number ?? "—"}
                      {r.document_kind === "credit_note" && <p className="text-xs text-muted-foreground">Credit note for {r.credited?.document_number ?? "—"}</p>}</TableCell>
                    <TableCell>{formatDate(r.document_date)}</TableCell>
                    <TableCell className="text-sm">{r.supplier?.name ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.supplier_invoice_number ?? "—"}</TableCell>
                    <TableCell className="text-xs">{ships.size === 0 ? <span className="text-muted-foreground">Expense only</span> :
                      Array.from(ships).map(([id, no]) => <Link key={id} className="mr-2 font-mono underline" href={id}>{no}</Link>)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(sign * Number(r.net_total))}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(sign * Number(r.tax_total))}</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{formatMoney(sign * Number(r.grand_total))}</TableCell>
                    <TableCell><Badge variant={r.document_status === "posted" ? "success" : "secondary"}>{r.document_status}</Badge></TableCell>
                    <TableCell>{r.document_status === "posted" && r.document_kind === "invoice" && can(ctx.user, "cost_invoices.void") && <VoidCostInvoiceButton id={r.id} label={r.document_number ?? ""} />}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent></Card>
      )}
      <Pager basePath="/imports/cost-invoices" params={{ q, branch: branchParam, supplier, from: from_, to: to_ }} page={page} pageSize={size} total={count ?? 0} />
    </div>
  );
}
