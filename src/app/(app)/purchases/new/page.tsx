import type { Metadata } from "next";
import Link from "next/link";
import { requirePermissionPage } from "@/lib/auth/guards";
import { getActiveContext, can } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { branchPaymentOptions } from "@/lib/payment-methods";
import { selectAll } from "@/lib/supabase/batch";
import { flattenProducts } from "@/lib/products";
import { isFeatureEnabled } from "@/lib/features";
import { expireOrders } from "@/lib/purchases/order-actions";
import { addDays } from "@/lib/reports/scope";
import { todayISO } from "@/lib/format";
import { PageHeader } from "@/components/ui/page-header";
import { branchStep } from "@/lib/branch-step";
import { BranchChoice, ChosenBranch } from "@/components/layout/branch-choice";
import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { PurchaseForm, type AdvanceOpt, type OrderPrefill } from "./purchase-form";

export const metadata: Metadata = { title: "Create Purchase" };

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function NewPurchasePage(props: { searchParams: SP }) {
  await requirePermissionPage("purchases.create");
  const base = await getActiveContext();
  const sp = await props.searchParams;
  const admin = createAdminClient();
  let ctx = base;

  // Receiving against a purchase order: the order's branch. Otherwise users with
  // several branches choose the branch first.
  const orderId = typeof sp.order === "string" ? sp.order : null;
  let order: OrderPrefill | undefined;
  if (!orderId) {
    const step = branchStep(base, sp);
    if (step.choose) return <BranchChoice title="Create Purchase" branches={base.branches} current={base.branchId} />;
    ctx = step.ctx;
  }
  if (orderId) {
    await expireOrders(ctx.companyId);
    const { data: po } = await admin.from("purchase_orders")
      .select("id, company_id, branch_id, supplier_id, document_number, status, lines:purchase_order_lines(product_id, quantity, qty_received, line_no)")
      .eq("id", orderId).maybeSingle();
    const pending = po && po.company_id === ctx.companyId && ["confirmed", "partially_received"].includes(po.status);
    if (!pending) return <div><PageHeader title="Create Purchase" /><EmptyState title="This purchase order is not pending" description="It may have been received in full, closed, or removed after 30 days." /></div>;
    if (!base.branches.some((x) => x.id === po.branch_id)) {
      return <div><PageHeader title="Create Purchase" /><EmptyState title="This order belongs to a branch you do not work in" description="Goods are received at the branch that ordered them." /></div>;
    }
    ctx = { ...base, branchId: po.branch_id };
    const lines = ((po.lines ?? []) as { product_id: string; quantity: number; qty_received: number; line_no: number }[]).sort((a, b) => a.line_no - b.line_no);
    order = { id: po.id, number: po.document_number ?? "", supplierId: po.supplier_id, lines: lines.map((l) => ({ product_id: l.product_id, ordered: Number(l.quantity), received: Number(l.qty_received) })) };
  }

  if (!ctx.branchId) return <div><PageHeader title="Create Purchase" /><EmptyState title="No active branch" /></div>;
  const branch = ctx.branches.find((b) => b.id === ctx.branchId);

  const fxAllowed = !order && can(ctx.user, "fx.enter_rate") && await isFeatureEnabled(ctx.companyId, "fx_settlement");

  const [{ data: products }, { data: taxCodes }, branchAccounts, { data: suppliers }, { data: currencies }, { data: rates }, { data: advances },
    { data: categories }, { data: brands }, { data: units }, recent] = await Promise.all([
    admin.from("products").select("id, sku, barcode, name, tax_code_id, category:product_categories(name), brand:brands(name)").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("tax_codes").select("id, name, rate, is_inclusive").eq("company_id", ctx.companyId).eq("is_active", true).order("code"),
    branchPaymentOptions(ctx.companyId, ctx.branchId),
    admin.from("suppliers").select("id, code, name, phone, payment_terms_days").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    fxAllowed ? admin.from("currencies").select("code, name").eq("is_active", true).eq("is_functional", false).order("code") : Promise.resolve({ data: [] }),
    fxAllowed ? admin.from("exchange_rates").select("currency_code, rate_date, rate").eq("company_id", ctx.companyId).order("rate_date", { ascending: false }).limit(1000) : Promise.resolve({ data: [] }),
    admin.from("supplier_advances").select("id, supplier_id, currency_code, fc_remaining, advance_date, payment:supplier_payments(document_number)").eq("company_id", ctx.companyId).eq("status", "open").gt("fc_remaining", 0),
    admin.from("product_categories").select("id, name").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("brands").select("id, name").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    admin.from("units").select("id, name").eq("company_id", ctx.companyId).eq("is_active", true).order("name"),
    // Latest posted cost per product at this branch (TZS), shown as a hint on each line.
    selectAll<{ product_id: string; unit_cost: number; purchase: { document_date: string } | null }>(() => admin.from("purchase_lines")
      .select("id, product_id, unit_cost, purchase:purchases!inner(document_date, branch_id, document_status, currency_code)")
      .eq("purchase.branch_id", ctx.branchId!).eq("purchase.document_status", "posted").eq("purchase.currency_code", "TZS")
      .gte("purchase.document_date", addDays(todayISO(), -365)).order("id")),
  ]);
  const lastCosts: Record<string, number> = {};
  const lastDate: Record<string, string> = {};
  for (const r of recent) {
    const d = r.purchase?.document_date ?? "";
    if (!lastDate[r.product_id] || d > lastDate[r.product_id]) { lastDate[r.product_id] = d; lastCosts[r.product_id] = Number(r.unit_cost); }
  }
  const advanceOpts: AdvanceOpt[] = ((advances ?? []) as unknown as Array<{ id: string; supplier_id: string; currency_code: string; fc_remaining: number; advance_date: string; payment: { document_number: string | null } | null }>)
    .filter((a) => a.currency_code === "TZS" || fxAllowed)
    .map((a) => ({ id: a.id, supplier_id: a.supplier_id, currency_code: a.currency_code, fc_remaining: Number(a.fc_remaining), label: `Advance ${a.payment?.document_number ?? ""} (${a.advance_date})` }));

  return (
    <div>
      <PageHeader title={order ? "Receive Purchase Order" : "Create Purchase"}
        description={<ChosenBranch branch={branch} canChange={!order && base.branches.length > 1} />}
        actions={<div className="flex gap-2">
          {!order && can(ctx.user, "purchases.order") && <Button asChild variant="outline" size="sm"><Link href="/purchases/orders">Purchase orders</Link></Button>}
          <Button asChild variant="outline" size="sm"><Link href="/purchases/history">Purchases History</Link></Button>
        </div>} />
      <PurchaseForm branchId={ctx.branchId}
        products={flattenProducts(products)}
        taxCodes={(taxCodes ?? []).map((t) => ({ ...t, rate: Number(t.rate) })) as never}
        accounts={branchAccounts as never} suppliers={(suppliers ?? []).map((s) => ({ ...s, payment_terms_days: Number(s.payment_terms_days ?? 0) }))}
        currencies={(currencies ?? []) as never} fxAllowed={fxAllowed}
        tableRates={((rates ?? []) as Array<{ currency_code: string; rate_date: string; rate: number }>).map((r) => ({ currency: r.currency_code, date: r.rate_date, rate: Number(r.rate) }))}
        advances={advanceOpts} categories={categories ?? []} brands={brands ?? []} units={units ?? []} lastCosts={lastCosts} order={order} />
    </div>
  );
}
