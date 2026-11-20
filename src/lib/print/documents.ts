import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { CurrentUser } from "@/lib/auth/session";
import { formatDate, formatMoney, formatQuantity } from "@/lib/format";
import type { PrintDoc } from "@/components/print/document";

/** Every document that has a printout: /print/<kind>/<id>. */
export const PRINT_KINDS = [
  "sale", "receipt", "purchase-order", "purchase", "purchase-return", "sales-return", "expense",
  "cash-transfer", "supplier-payment", "other-income", "stock-adjustment", "stock-transfer",
] as const;
export type PrintKind = (typeof PRINT_KINDS)[number];

export interface Loaded {
  doc: PrintDoc;
  branch: { name: string; address: string | null; phone: string | null } | null;
  /** Browser tab title, also the PDF file name. */
  fileTitle: string;
}

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v ?? 0);
const amt = (v: unknown) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num(v));
const money = (v: unknown, cur = "TZS") => formatMoney(num(v), cur);
const one = <T,>(v: unknown) => (Array.isArray(v) ? v[0] : v) as T | null;
type Party = { name?: string | null; code?: string | null; phone?: string | null; email?: string | null; address?: string | null; tin?: string | null; vat_number?: string | null } | null;
type Br = { name: string; code: string; address: string | null; phone: string | null } | null;
const partyLines = (p: Party) => p ? [p.name, p.address, [p.phone, p.email].filter(Boolean).join("  ·  ") || null,
  [p.tin ? `TIN ${p.tin}` : null, p.vat_number ? `VRN ${p.vat_number}` : null].filter(Boolean).join("  ·  ") || null] : ["—"];
const branchOut = (b: Br) => (b ? { name: `${b.name} (${b.code})`, address: b.address, phone: b.phone } : null);
const PARTY = "name, code, phone, email, address, tin, vat_number";
const BRANCH = "name, code, address, phone";

function allowed(user: CurrentUser, perm: string, branchIds: (string | null | undefined)[]): boolean {
  if (!(user.isOwner || user.permissions.has(perm))) return false;
  if (user.isOwner) return true;
  const ids = branchIds.filter(Boolean) as string[];
  return ids.length === 0 || ids.some((b) => user.branchIds.includes(b));
}
const statusOf = (s: unknown) => String(s ?? "posted");
const TITLE_SUFFIX = (n: unknown, party?: string | null) => [n ?? "Draft", party].filter(Boolean).join(" - ");

/** Loads one document as printable data, or null (not found, other company, or no access). */
export async function loadPrintDoc(kind: PrintKind, id: string, user: CurrentUser, companyId: string): Promise<Loaded | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const db = createAdminClient();
  const get = async (table: string, select: string) => {
    const { data } = await db.from(table).select(select).eq("id", id).maybeSingle();
    const r = data as Row | null;
    return r && r.company_id === companyId ? r : null;
  };

  switch (kind) {
    case "sale": {
      const s = await get("sales", `*, customer:customers(${PARTY}), branch:branches(${BRANCH})`);
      if (!s || !allowed(user, "sales.view", [s.branch_id as string])) return null;
      const [{ data: lines }, { data: pays }] = await Promise.all([
        db.from("sale_lines").select("description, quantity, unit_price, discount, tax_name, tax_rate, line_total, line_no").eq("sale_id", id).order("line_no"),
        db.from("sale_payments").select("amount, account:payment_accounts(name)").eq("sale_id", id),
      ]);
      const cust = one<Party>(s.customer);
      const walkIn = typeof s.notes === "string" && s.notes.startsWith("Walk-in:") ? s.notes.slice(8).trim() : null;
      const ls = (lines ?? []) as Row[];
      return {
        branch: branchOut(one<Br>(s.branch)),
        fileTitle: `Invoice ${TITLE_SUFFIX(s.document_number, cust?.name)}`,
        doc: {
          title: num(s.tax_total) > 0 ? "TAX INVOICE" : "INVOICE", number: (s.document_number as string) ?? null, status: statusOf(s.document_status),
          meta: [{ label: "Date", value: formatDate(s.document_date as string) }, { label: "Due date", value: num(s.outstanding) > 0 && s.due_date ? formatDate(s.due_date as string) : null },
            { label: "Customer ref.", value: (s.customer_reference as string) || null }],
          parties: [{ heading: "Bill to", lines: walkIn ? [walkIn, cust?.name] : partyLines(cust) }],
          table: {
            columns: [{ label: "#", width: "28px" }, { label: "Description" }, { label: "Qty", align: "right" }, { label: "Unit price", align: "right" },
              ...(ls.some((l) => num(l.discount) > 0) ? [{ label: "Discount", align: "right" as const }] : []), { label: "VAT", align: "center" }, { label: "Amount", align: "right" }],
            rows: ls.map((l, i) => [i + 1, l.description as string, formatQuantity(l.quantity as number), amt(l.unit_price),
              ...(ls.some((x) => num(x.discount) > 0) ? [amt(l.discount)] : []), num(l.tax_rate) > 0 ? `${num(l.tax_rate)}%` : "—", amt(l.line_total)]),
          },
          totals: [
            ...(num(s.discount_total) > 0 ? [{ label: "Subtotal", value: money(s.subtotal) }, { label: "Discount", value: `- ${money(s.discount_total)}` }] : []),
            { label: "Net amount", value: money(s.net_total) }, { label: "VAT", value: money(s.tax_total) },
            { label: "Total", value: money(s.grand_total), strong: true },
            { label: "Paid", value: money(s.amount_paid) }, { label: "Balance due", value: money(s.outstanding) },
          ],
          sections: (pays ?? []).length ? [{ heading: "Payment received", rows: ((pays ?? []) as Row[]).map((p) => ({ label: one<{ name: string }>(p.account)?.name ?? "—", value: money(p.amount) })) }] : [],
          notes: walkIn ? null : (s.notes as string) || null,
          closing: "Thank you for your business.",
        },
      };
    }

    case "receipt": {
      const r = await get("customer_receipts", `*, customer:customers(${PARTY}), branch:branches(${BRANCH}), account:payment_accounts(name)`);
      if (!r || !allowed(user, "sales.view", [r.branch_id as string])) return null;
      const cust = one<Party & { id?: string }>(r.customer);
      const [{ data: allocs }, { data: open }] = await Promise.all([
        db.from("customer_receipt_allocations").select("amount, sale:sales(document_number, document_date, grand_total)").eq("receipt_id", id),
        db.from("sales").select("outstanding").eq("company_id", companyId).eq("customer_id", r.customer_id as string).eq("document_status", "posted"),
      ]);
      const owing = ((open ?? []) as Row[]).reduce((a, x) => a + num(x.outstanding), 0);
      return {
        branch: branchOut(one<Br>(r.branch)),
        fileTitle: `Receipt ${TITLE_SUFFIX(r.document_number, cust?.name)}`,
        doc: {
          title: "PAYMENT RECEIPT", number: (r.document_number as string) ?? null, status: statusOf(r.document_status),
          meta: [{ label: "Date", value: formatDate(r.document_date as string) }, { label: "Received into", value: one<{ name: string }>(r.account)?.name },
            { label: "Reference", value: (r.reference as string) || null }],
          parties: [{ heading: "Received from", lines: partyLines(cust) }],
          table: {
            columns: [{ label: "Invoice" }, { label: "Invoice date" }, { label: "Invoice total", align: "right" }, { label: "Amount applied", align: "right" }],
            rows: ((allocs ?? []) as Row[]).map((a) => { const sl = one<Row>(a.sale); return [sl?.document_number as string, formatDate(sl?.document_date as string), amt(sl?.grand_total), amt(a.amount)]; }),
            empty: "Received on account (not applied to an invoice).",
          },
          totals: [{ label: "Amount received", value: money(r.amount), strong: true }, { label: "Customer still owes", value: money(owing) }],
          notes: (r.notes as string) || null,
          closing: "Thank you for your payment.",
        },
      };
    }

    case "purchase-order": {
      const o = await get("purchase_orders", `*, supplier:suppliers(${PARTY}), branch:branches(${BRANCH}), lines:purchase_order_lines(quantity, note, line_no, description, product:products(sku, name, unit:units(symbol)))`);
      if (!o || o.status === "cancelled" || !allowed(user, "purchases.view", [o.branch_id as string])) return null;
      const sup = one<Party>(o.supplier); const br = one<Br>(o.branch);
      const ls = ((o.lines ?? []) as Row[]).sort((a, b) => num(a.line_no) - num(b.line_no));
      const total = ls.reduce((a, l) => a + num(l.quantity), 0);
      return {
        branch: branchOut(br),
        fileTitle: `Purchase Order ${TITLE_SUFFIX(o.document_number, sup?.name)}`,
        doc: {
          title: "PURCHASE ORDER", number: (o.document_number as string) ?? null, status: o.status === "draft" ? "draft" : "posted",
          meta: [{ label: "Order date", value: formatDate(o.order_date as string) }, { label: "Deliver by", value: o.expected_date ? formatDate(o.expected_date as string) : null },
            { label: "Reference", value: (o.reference as string) || null }],
          parties: [{ heading: "Supplier", lines: partyLines(sup) }, { heading: "Deliver to", lines: [br ? `Hilty Limited — ${br.name}` : null, br?.address, br?.phone] }],
          table: {
            columns: [{ label: "#", width: "28px" }, { label: "Item" }, { label: "Code" }, { label: "Unit", align: "center" }, { label: "Quantity", align: "right" }, { label: "Note" }],
            rows: ls.map((l, i) => { const p = one<{ sku: string; name: string; unit: unknown }>(l.product); return [i + 1, p?.name ?? (l.description as string), p?.sku, one<{ symbol: string | null }>(p?.unit)?.symbol ?? "", formatQuantity(l.quantity as number), (l.note as string) ?? ""]; }),
          },
          totals: [{ label: "Items", value: String(ls.length) }, { label: "Total quantity", value: formatQuantity(total), strong: true }],
          notes: (o.notes as string) || null,
        },
      };
    }

    case "purchase": {
      const p = await get("purchases", `*, supplier:suppliers(${PARTY}), branch:branches(${BRANCH}), po:purchase_orders(document_number)`);
      if (!p || !allowed(user, "purchases.view", [p.branch_id as string])) return null;
      const [{ data: lines }, { data: pays }] = await Promise.all([
        db.from("purchase_lines").select("description, quantity, unit_cost, discount, tax_rate, gross_amount, fc_gross_amount, line_no, product:products(sku)").eq("purchase_id", id).order("line_no"),
        db.from("purchase_payments").select("amount, account:payment_accounts(name)").eq("purchase_id", id),
      ]);
      const sup = one<Party>(p.supplier); const cur = (p.currency_code as string) || "TZS"; const fc = cur !== "TZS";
      return {
        branch: branchOut(one<Br>(p.branch)),
        fileTitle: `Purchase ${TITLE_SUFFIX(p.document_number, sup?.name)}`,
        doc: {
          title: "PURCHASE", number: (p.document_number as string) ?? null, status: statusOf(p.document_status),
          meta: [{ label: "Date", value: formatDate(p.document_date as string) }, { label: "Supplier invoice", value: (p.supplier_invoice_number as string) || null },
            { label: "Invoice date", value: p.supplier_invoice_date ? formatDate(p.supplier_invoice_date as string) : null },
            { label: "Due date", value: num(p.outstanding) > 0 && p.due_date ? formatDate(p.due_date as string) : null },
            { label: "Purchase order", value: one<{ document_number: string }>(p.po)?.document_number ?? null },
            { label: "Currency", value: fc ? `${cur} @ ${p.exchange_rate}` : null }],
          parties: [{ heading: "Supplier", lines: partyLines(sup) }],
          table: {
            columns: [{ label: "#", width: "28px" }, { label: "Description" }, { label: "Code" }, { label: "Qty", align: "right" }, { label: `Unit cost${fc ? ` (${cur})` : ""}`, align: "right" }, { label: "VAT", align: "center" }, { label: `Amount${fc ? ` (${cur})` : ""}`, align: "right" }],
            rows: ((lines ?? []) as Row[]).map((l, i) => [i + 1, l.description as string, one<{ sku: string }>(l.product)?.sku, formatQuantity(l.quantity as number), amt(l.unit_cost),
              num(l.tax_rate) > 0 ? `${num(l.tax_rate)}%` : "—", amt(fc ? l.fc_gross_amount : l.gross_amount)]),
          },
          totals: [
            { label: "Net amount", value: money(p.net_total) }, { label: "VAT", value: money(p.tax_total) },
            { label: "Total", value: money(p.grand_total), strong: true },
            ...(fc ? [{ label: `Total in ${cur}`, value: money(p.fc_grand_total, cur) }] : []),
            { label: "Paid", value: money(p.amount_paid) }, { label: "Outstanding", value: money(p.outstanding) },
          ],
          sections: (pays ?? []).length ? [{ heading: "Paid from", rows: ((pays ?? []) as Row[]).map((x) => ({ label: one<{ name: string }>(x.account)?.name ?? "—", value: money(x.amount) })) }] : [],
          notes: (p.notes as string) || null,
        },
      };
    }

    case "purchase-return": {
      const r = await get("purchase_returns", `*, supplier:suppliers(${PARTY}), branch:branches(${BRANCH}), purchase:purchases(document_number, supplier_invoice_number)`);
      if (!r || !allowed(user, "purchases.view", [r.branch_id as string])) return null;
      const { data: lines } = await db.from("purchase_return_lines").select("quantity, unit_price, tax_rate, line_total, line_no, product:products(sku, name)").eq("return_id", id).order("line_no");
      const sup = one<Party>(r.supplier); const pur = one<Row>(r.purchase);
      const settle: Record<string, string> = { reduce_payable: "Reduce the amount owed", supplier_credit: "Supplier credit", refund: "Refund", mixed: "Mixed" };
      return {
        branch: branchOut(one<Br>(r.branch)),
        fileTitle: `Purchase Return ${TITLE_SUFFIX(r.document_number, sup?.name)}`,
        doc: {
          title: "DEBIT NOTE", number: (r.document_number as string) ?? null, status: statusOf(r.document_status),
          meta: [{ label: "Date", value: formatDate(r.document_date as string) }, { label: "Purchase", value: pur?.document_number as string },
            { label: "Supplier invoice", value: (pur?.supplier_invoice_number as string) || null }, { label: "Settlement", value: settle[r.settlement_method as string] ?? (r.settlement_method as string) }],
          parties: [{ heading: "Returned to", lines: partyLines(sup) }],
          table: {
            columns: [{ label: "#", width: "28px" }, { label: "Item" }, { label: "Code" }, { label: "Qty", align: "right" }, { label: "Unit price", align: "right" }, { label: "VAT", align: "center" }, { label: "Amount", align: "right" }],
            rows: ((lines ?? []) as Row[]).map((l, i) => { const pr = one<{ sku: string; name: string }>(l.product); return [i + 1, pr?.name, pr?.sku, formatQuantity(l.quantity as number), amt(l.unit_price), num(l.tax_rate) > 0 ? `${num(l.tax_rate)}%` : "—", amt(l.line_total)]; }),
          },
          totals: [{ label: "Net amount", value: money(r.net_total) }, { label: "VAT", value: money(r.tax_total) }, { label: "Total returned", value: money(r.total), strong: true },
            ...(num(r.refund_amount) > 0 ? [{ label: "Refunded", value: money(r.refund_amount) }] : []),
            ...(num(r.payable_reduction) > 0 ? [{ label: "Payable reduced", value: money(r.payable_reduction) }] : []),
            ...(num(r.credit_amount) > 0 ? [{ label: "Supplier credit", value: money(r.credit_amount) }] : [])],
          notes: [r.reason, r.notes].filter(Boolean).join("\n") || null,
        },
      };
    }

    case "sales-return": {
      const r = await get("sales_returns", `*, customer:customers(${PARTY}), branch:branches(${BRANCH}), sale:sales(document_number, document_date)`);
      if (!r || !allowed(user, "sales.view", [r.branch_id as string])) return null;
      const { data: lines } = await db.from("sales_return_lines").select("quantity, unit_price, tax_rate, line_total, line_no, product:products(sku, name)").eq("return_id", id).order("line_no");
      const cust = one<Party>(r.customer); const sale = one<Row>(r.sale);
      const how: Record<string, string> = { payment_account: "Refund", receivable: "Reduce the amount owed", mixed: "Mixed" };
      return {
        branch: branchOut(one<Br>(r.branch)),
        fileTitle: `Credit Note ${TITLE_SUFFIX(r.document_number, cust?.name)}`,
        doc: {
          title: "CREDIT NOTE", number: (r.document_number as string) ?? null, status: statusOf(r.document_status),
          meta: [{ label: "Date", value: formatDate(r.document_date as string) }, { label: "Invoice", value: sale?.document_number as string },
            { label: "Invoice date", value: sale ? formatDate(sale.document_date as string) : null }, { label: "Settlement", value: how[r.refund_method as string] ?? (r.refund_method as string) }],
          parties: [{ heading: "Customer", lines: partyLines(cust) }],
          table: {
            columns: [{ label: "#", width: "28px" }, { label: "Item" }, { label: "Code" }, { label: "Qty", align: "right" }, { label: "Unit price", align: "right" }, { label: "VAT", align: "center" }, { label: "Amount", align: "right" }],
            rows: ((lines ?? []) as Row[]).map((l, i) => { const pr = one<{ sku: string; name: string }>(l.product); return [i + 1, pr?.name, pr?.sku, formatQuantity(l.quantity as number), amt(l.unit_price), num(l.tax_rate) > 0 ? `${num(l.tax_rate)}%` : "—", amt(l.line_total)]; }),
          },
          totals: [{ label: "Net amount", value: money(r.net_total) }, { label: "VAT", value: money(r.tax_total) }, { label: "Total credited", value: money(r.total), strong: true },
            ...(num(r.refund_amount) > 0 ? [{ label: "Refunded", value: money(r.refund_amount) }] : []),
            ...(num(r.receivable_reduction) > 0 ? [{ label: "Balance reduced", value: money(r.receivable_reduction) }] : [])],
          notes: [r.reason, r.notes].filter(Boolean).join("\n") || null,
        },
      };
    }

    case "expense": {
      const e = await get("expenses", `*, supplier:suppliers(${PARTY}), branch:branches(${BRANCH}), category:expense_categories(name, description)`);
      if (!e || !allowed(user, "expenses.view", [e.branch_id as string])) return null;
      const { data: pays } = await db.from("expense_payments").select("amount, account:payment_accounts(name)").eq("expense_id", id);
      const sup = one<Party>(e.supplier); const cat = one<{ name: string; description: string | null }>(e.category);
      return {
        branch: branchOut(one<Br>(e.branch)),
        fileTitle: `Expense ${TITLE_SUFFIX(e.document_number, cat?.name)}`,
        doc: {
          title: "EXPENSE VOUCHER", number: (e.document_number as string) ?? null, status: statusOf(e.document_status),
          meta: [{ label: "Date", value: formatDate(e.document_date as string) }, { label: "Reference", value: (e.reference as string) || null },
            { label: "Due date", value: num(e.outstanding) > 0 && e.due_date ? formatDate(e.due_date as string) : null }],
          parties: sup ? [{ heading: "Paid to", lines: partyLines(sup) }] : [],
          table: {
            columns: [{ label: "Category" }, { label: "Description" }, { label: "VAT", align: "center" }, { label: "Amount", align: "right" }],
            rows: [[[cat?.name, cat?.description].filter(Boolean).join(" — "), (e.description as string) ?? "", num(e.tax_rate) > 0 ? `${num(e.tax_rate)}%` : "—", amt(e.grand_total)]],
          },
          totals: [{ label: "Net amount", value: money(e.net_total) }, { label: "VAT", value: money(e.tax_total) }, { label: "Total", value: money(e.grand_total), strong: true },
            { label: "Paid", value: money(e.amount_paid) }, ...(num(e.outstanding) > 0 ? [{ label: "Still owed", value: money(e.outstanding) }] : [])],
          sections: (pays ?? []).length ? [{ heading: "Paid from", rows: ((pays ?? []) as Row[]).map((x) => ({ label: one<{ name: string }>(x.account)?.name ?? "—", value: money(x.amount) })) }] : [],
        },
      };
    }

    case "cash-transfer": {
      const t = await get("cash_transfers", `*, source:payment_accounts!cash_transfers_source_account_id_fkey(name), dest:payment_accounts!cash_transfers_destination_account_id_fkey(name), sbranch:branches!cash_transfers_source_branch_id_fkey(${BRANCH}), dbranch:branches!cash_transfers_destination_branch_id_fkey(${BRANCH})`);
      if (!t || !allowed(user, "cash_transfers.view", [t.source_branch_id as string, t.destination_branch_id as string])) return null;
      const sb = one<Br>(t.sbranch); const dbr = one<Br>(t.dbranch);
      return {
        branch: branchOut(sb ?? dbr),
        fileTitle: `Cash Transfer ${TITLE_SUFFIX(t.document_number)}`,
        doc: {
          title: "CASH TRANSFER", number: (t.document_number as string) ?? null, status: statusOf(t.document_status),
          meta: [{ label: "Date", value: formatDate(t.transfer_date as string) }, { label: "Reference", value: (t.reference as string) || null }],
          parties: [{ heading: "From", lines: [one<{ name: string }>(t.source)?.name, sb ? `${sb.name} (${sb.code})` : null] },
            { heading: "To", lines: [one<{ name: string }>(t.dest)?.name, dbr ? `${dbr.name} (${dbr.code})` : null] }],
          totals: [{ label: "Amount transferred", value: money(t.amount), strong: true },
            ...(num(t.fee) > 0 ? [{ label: "Fee", value: money(t.fee) }, { label: "Total taken from source", value: money(num(t.amount) + num(t.fee)) }] : [])],
          notes: (t.description as string) || null,
        },
      };
    }

    case "supplier-payment": {
      const p = await get("supplier_payments", `*, supplier:suppliers(${PARTY}), branch:branches(${BRANCH})`);
      if (!p || !allowed(user, "purchases.view", [p.branch_id as string])) return null;
      const [{ data: allocs }, { data: funds }] = await Promise.all([
        db.from("supplier_payment_allocations").select("amount, fc_amount, payable:supplier_payables(source_type, purchase:purchases(document_number, supplier_invoice_number), expense:expenses(document_number))").eq("payment_id", id),
        db.from("supplier_payment_funding").select("amount, reference, account:payment_accounts(name)").eq("payment_id", id),
      ]);
      const sup = one<Party>(p.supplier); const cur = (p.currency_code as string) || "TZS";
      return {
        branch: branchOut(one<Br>(p.branch)),
        fileTitle: `Supplier Payment ${TITLE_SUFFIX(p.document_number, sup?.name)}`,
        doc: {
          title: "PAYMENT VOUCHER", number: (p.document_number as string) ?? null, status: statusOf(p.document_status),
          meta: [{ label: "Date", value: formatDate(p.document_date as string) }, { label: "Reference", value: (p.reference as string) || null }, { label: "Currency", value: cur !== "TZS" ? cur : null }],
          parties: [{ heading: "Paid to", lines: partyLines(sup) }],
          table: {
            columns: [{ label: "Document" }, { label: "Supplier invoice" }, { label: "Type" }, { label: "Amount paid", align: "right" }],
            rows: ((allocs ?? []) as Row[]).map((a) => { const pay = one<Row>(a.payable); const pu = one<Row>(pay?.purchase); const ex = one<Row>(pay?.expense);
              return [(pu?.document_number ?? ex?.document_number) as string, (pu?.supplier_invoice_number as string) ?? "", pay?.source_type === "expense" ? "Expense" : "Purchase", amt(cur !== "TZS" ? a.fc_amount : a.amount)]; }),
            empty: "Advance payment (not applied to an invoice yet).",
          },
          totals: [{ label: "Amount paid", value: money(cur !== "TZS" ? p.fc_total : p.amount, cur), strong: true },
            ...(num(p.bank_charges) > 0 ? [{ label: "Bank charges", value: money(p.bank_charges) }] : [])],
          sections: (funds ?? []).length ? [{ heading: "Paid from", rows: ((funds ?? []) as Row[]).map((x) => ({ label: [one<{ name: string }>(x.account)?.name, x.reference].filter(Boolean).join(" · "), value: money(x.amount) })) }] : [],
          notes: (p.notes as string) || null,
        },
      };
    }

    case "other-income": {
      const t = await get("other_income_transactions", `*, branch:branches(${BRANCH}), type:other_income_types(name)`);
      if (!t || !allowed(user, "other_income.view", [t.branch_id as string])) return null;
      const { data: recs } = await db.from("other_income_receipts").select("amount, reference, account:payment_accounts(name)").eq("transaction_id", id);
      return {
        branch: branchOut(one<Br>(t.branch)),
        fileTitle: `Receipt ${TITLE_SUFFIX(t.document_number, t.received_from as string)}`,
        doc: {
          title: "OFFICIAL RECEIPT", number: (t.document_number as string) ?? null, status: statusOf(t.document_status),
          meta: [{ label: "Date", value: formatDate(t.document_date as string) }, { label: "Reference", value: (t.reference as string) || null }],
          parties: [{ heading: "Received from", lines: [(t.received_from as string) || "—"] }],
          table: {
            columns: [{ label: "Income" }, { label: "Description" }, { label: "VAT", align: "center" }, { label: "Amount", align: "right" }],
            rows: [[one<{ name: string }>(t.type)?.name, (t.description as string) ?? "", num(t.tax_rate) > 0 ? `${num(t.tax_rate)}%` : "—", amt(t.grand_total)]],
          },
          totals: [{ label: "Net amount", value: money(t.net_total) }, { label: "VAT", value: money(t.tax_total) }, { label: "Total received", value: money(t.grand_total), strong: true }],
          sections: (recs ?? []).length ? [{ heading: "Received into", rows: ((recs ?? []) as Row[]).map((x) => ({ label: one<{ name: string }>(x.account)?.name ?? "—", value: money(x.amount) })) }] : [],
          notes: (t.notes as string) || null,
          closing: "Thank you.",
        },
      };
    }

    case "stock-adjustment": {
      const a = await get("stock_adjustments", `*, branch:branches(${BRANCH})`);
      if (!a || !allowed(user, "inventory.view", [a.branch_id as string])) return null;
      const showCost = user.isOwner || user.permissions.has("inventory.view_cost");
      const { data: lines } = await db.from("stock_adjustment_lines").select("quantity, unit_cost, total_value, line_no, product:products(sku, name, unit:units(symbol))").eq("adjustment_id", id).order("line_no");
      const up = a.direction === "increase";
      return {
        branch: branchOut(one<Br>(a.branch)),
        fileTitle: `Stock Adjustment ${TITLE_SUFFIX(a.document_number)}`,
        doc: {
          title: "STOCK ADJUSTMENT", number: (a.document_number as string) ?? null, status: statusOf(a.document_status),
          meta: [{ label: "Date", value: formatDate(a.adjustment_date as string) }, { label: "Direction", value: up ? "Increase (+)" : "Decrease (−)" }, { label: "Reference", value: (a.reference as string) || null }],
          parties: [{ heading: "Reason", lines: [(a.reason as string) || "—", (a.description as string) || null] }],
          table: {
            columns: [{ label: "#", width: "28px" }, { label: "Item" }, { label: "Code" }, { label: "Unit", align: "center" }, { label: "Quantity", align: "right" },
              ...(showCost ? [{ label: "Unit cost", align: "right" as const }, { label: "Value", align: "right" as const }] : [])],
            rows: ((lines ?? []) as Row[]).map((l, i) => { const p = one<{ sku: string; name: string; unit: unknown }>(l.product);
              return [i + 1, p?.name, p?.sku, one<{ symbol: string | null }>(p?.unit)?.symbol ?? "", `${up ? "+" : "−"}${formatQuantity(l.quantity as number)}`, ...(showCost ? [amt(l.unit_cost), amt(l.total_value)] : [])]; }),
          },
          totals: showCost ? [{ label: "Total value", value: money(a.total_value), strong: true }] : [],
        },
      };
    }

    case "stock-transfer": {
      const t = await get("stock_transfers", `*, source:branches!stock_transfers_source_branch_id_fkey(${BRANCH}), dest:branches!stock_transfers_destination_branch_id_fkey(${BRANCH})`);
      if (!t || !allowed(user, "inventory.transfer_view", [t.source_branch_id as string, t.destination_branch_id as string])) return null;
      const { data: lines } = await db.from("stock_transfer_lines").select("qty_requested, qty_dispatched, qty_received, line_no, product:products(sku, name, unit:units(symbol))").eq("transfer_id", id).order("line_no");
      const src = one<Br>(t.source); const dst = one<Br>(t.dest);
      const ls = (lines ?? []) as Row[];
      const sum = (k: string) => ls.reduce((s, l) => s + num(l[k]), 0);
      const st: Record<string, string> = { draft: "Draft", dispatched: "In transit", in_transit: "In transit", partially_received: "Partly received", received: "Received", closed: "Closed", voided: "Voided" };
      return {
        branch: branchOut(src),
        fileTitle: `Stock Transfer ${TITLE_SUFFIX(t.document_number, dst?.name)}`,
        doc: {
          title: "STOCK TRANSFER", number: (t.document_number as string) ?? null, status: t.status === "voided" ? "voided" : t.status === "draft" ? "draft" : "posted",
          meta: [{ label: "Date", value: formatDate(t.transfer_date as string) }, { label: "Status", value: st[t.status as string] ?? (t.status as string) },
            { label: "Expected", value: t.expected_date ? formatDate(t.expected_date as string) : null }, { label: "Reference", value: (t.reference as string) || null }],
          parties: [{ heading: "From", lines: [src ? `${src.name} (${src.code})` : null, src?.address, src?.phone] },
            { heading: "To", lines: [dst ? `${dst.name} (${dst.code})` : null, dst?.address, dst?.phone] }],
          table: {
            columns: [{ label: "#", width: "28px" }, { label: "Item" }, { label: "Code" }, { label: "Unit", align: "center" }, { label: "Requested", align: "right" }, { label: "Dispatched", align: "right" }, { label: "Received", align: "right" }],
            rows: ls.map((l, i) => { const p = one<{ sku: string; name: string; unit: unknown }>(l.product);
              return [i + 1, p?.name, p?.sku, one<{ symbol: string | null }>(p?.unit)?.symbol ?? "", formatQuantity(l.qty_requested as number), formatQuantity(l.qty_dispatched as number), formatQuantity(l.qty_received as number)]; }),
          },
          totals: [{ label: "Requested", value: formatQuantity(sum("qty_requested")) }, { label: "Dispatched", value: formatQuantity(sum("qty_dispatched")) }, { label: "Received", value: formatQuantity(sum("qty_received")), strong: true }],
          sections: (t.driver_name || t.vehicle_registration) ? [{ heading: "Transport", rows: [
            ...(t.vehicle_registration ? [{ label: "Truck", value: [t.vehicle_registration, t.trailer_registration].filter(Boolean).join(" / ") as string }] : []),
            ...(t.driver_name ? [{ label: "Driver", value: [t.driver_name, t.driver_phone].filter(Boolean).join(" · ") as string }] : []),
          ] }] : [],
          notes: (t.notes as string) || null,
        },
      };
    }
  }
}
