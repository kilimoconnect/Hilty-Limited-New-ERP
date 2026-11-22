import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { branchPaymentOptions } from "@/lib/payment-methods";
import { normalizeAlias, receiptReference, round2, type PhotoReadResult, type ReadNoteLine, type ReadReceipt } from "./types";

/**
 * Reads one photo of handwritten cash-sale receipts and/or the day's notebook
 * page with an OpenAI vision model. The model sees the product list (short
 * codes), the remembered short forms, the branch's payment methods and the
 * expense categories, and answers in a fixed JSON shape. Server only: the API
 * key never reaches the browser.
 */

const MODEL = process.env.OPENAI_VISION_MODEL || "gpt-4o";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["receipts", "notebook"],
  properties: {
    receipts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["number", "date", "written_total", "blank", "lines"],
        properties: {
          number: { type: "string", description: "Printed receipt number, e.g. 0197" },
          date: { type: ["string", "null"], description: "YYYY-MM-DD, or null if not written" },
          written_total: { type: ["number", "null"], description: "TOTAL written on the receipt in TZS" },
          blank: { type: "boolean", description: "true when the receipt has no items written" },
          lines: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["qty", "text", "amount", "product_code"],
              properties: {
                qty: { type: "number" },
                text: { type: "string", description: "Item exactly as written" },
                amount: { type: "number", description: "Line amount in TZS as written (the line total, not the unit price)" },
                product_code: { type: ["string", "null"], description: "Code from the product list, or null when unsure" },
              },
            },
          },
        },
      },
    },
    notebook: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["date", "label", "amount", "kind", "method_code", "category_code"],
        properties: {
          date: { type: ["string", "null"] },
          label: { type: "string" },
          amount: { type: "number" },
          kind: { type: "string", enum: ["payment", "expense"] },
          method_code: { type: ["string", "null"], description: "Payment method code for a payment line" },
          category_code: { type: ["string", "null"], description: "Expense category code for an expense line" },
        },
      },
    },
  },
} as const;

type Raw = {
  receipts: { number: string; date: string | null; written_total: number | null; blank: boolean; lines: { qty: number; text: string; amount: number; product_code: string | null }[] }[];
  notebook: { date: string | null; label: string; amount: number; kind: "payment" | "expense"; method_code: string | null; category_code: string | null }[];
};

export class ReaderError extends Error {}

export async function readPhoto(opts: { image: string; companyId: string; branchId: string; photo: number }): Promise<PhotoReadResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new ReaderError("Reading photos is not set up yet: the OpenAI API key (OPENAI_API_KEY) is missing on the server.");
  const admin = createAdminClient();
  const [{ data: products }, { data: aliases }, accounts, { data: categories }] = await Promise.all([
    admin.from("products").select("id, sku, name, selling_price").eq("company_id", opts.companyId).eq("is_active", true).order("name"),
    admin.from("photo_item_aliases").select("alias, product_id, uses").eq("company_id", opts.companyId).order("uses", { ascending: false }).limit(400),
    branchPaymentOptions(opts.companyId, opts.branchId),
    admin.from("expense_categories").select("id, code, name").eq("company_id", opts.companyId).eq("is_active", true).order("name"),
  ]);
  const prods = products ?? [];
  const codeOf = new Map(prods.map((p, i) => [p.id, `P${i + 1}`]));
  const idOfCode = new Map(prods.map((p, i) => [`P${i + 1}`, p.id]));
  const aliasMap = new Map((aliases ?? []).map((a) => [a.alias, a.product_id]));
  const methodByCode = new Map(accounts.map((a) => [String(a.code ?? "").toUpperCase(), a.id]));
  const cash = accounts.find((a) => String(a.code ?? "").toUpperCase() === "CASH")?.id ?? accounts[0]?.id ?? null;
  const catByCode = new Map((categories ?? []).map((c) => [c.code, c.id]));

  const prompt = [
    "You read photos from a paint and hardware shop in Tanzania (Hilty Limited).",
    "A photo may show handwritten CASH SALE receipts (printed receipt number such as 0197, a date, lines of Qty / Particulars / Shs, and a TOTAL),",
    "and/or a notebook page listing the day's money: how sales money was received (cash, M-Pesa, NMB bank, CRDB, Mixx, cash deposited) and small expenses (e.g. 'chakula' = food).",
    "",
    "Rules:",
    "- Read every receipt in the photo, including blank ones (blank=true, no lines). Use the printed number.",
    "- Dates are written day/month/year with a 2-digit year (21/11/26 = 2026-11-21). Return YYYY-MM-DD. If a receipt has no date, return null.",
    "- Amounts are Tanzanian shillings; '380,000' = 380000, '3500' = 3500, '1,500' = 1500. A trailing '/=' or '=' is not a digit.",
    "- The Shs column is the LINE TOTAL for that quantity, not the unit price. Copy it exactly as written; do not correct the receipt.",
    "- written_total is the number written next to TOTAL. Do not compute it.",
    "- 'qty' is the number in the Qty column ('1roll' = 1, '1ctn' = 1).",
    "- product_code: choose the product from the list that the item text means. Short forms are common:",
    "  'W-guard' = WEATHER GUARD, 'R-brush' = R BRUSH (roller brush), 's/s' or '5/5' often a size, 'O-paint' = oil paint, 'F-tape' = fibre tape, 'E paint' = E PAINTS,",
    "  sizes like 20l/20lt, 4lt, 1lt, 3\" = 3inch. Match colour and size. If you are not sure, return null rather than guessing.",
    "- Known short forms (always use these when the text matches):",
    ...(aliases ?? []).slice(0, 400).map((a) => `  "${a.alias}" => ${codeOf.get(a.product_id) ?? "?"}`).filter((l) => !l.endsWith("?")),
    "- Notebook lines: kind 'payment' when the line says how sales money was received or deposited; kind 'expense' for money spent.",
    `  method_code for payments, one of: ${accounts.map((a) => `${a.code} (${a.name})`).join(", ") || "none"}. 'Cash deposit' = CASH.`,
    `  category_code for expenses, one of: ${(categories ?? []).map((c) => `${c.code} (${c.name})`).join("; ")}.`,
    "- Return receipts: [] if there are none, notebook: [] if there is no notebook page.",
    "",
    "Product list (code|name|usual price TZS):",
    ...prods.map((p, i) => `P${i + 1}|${p.name}|${Number(p.selling_price)}`),
  ].join("\n");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "receipts_and_notebook", strict: true, schema: SCHEMA } },
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: [
          { type: "text", text: "Read this photo." },
          { type: "image_url", image_url: { url: opts.image, detail: "high" } },
        ] },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const msg = (() => { try { return JSON.parse(body).error?.message as string; } catch { return ""; } })();
    throw new ReaderError(`The photo reader failed (${res.status})${msg ? `: ${msg}` : "."}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new ReaderError("The photo reader returned nothing. Try a clearer photo.");
  let raw: Raw;
  try { raw = JSON.parse(content) as Raw; } catch { throw new ReaderError("The photo reader returned an unreadable answer. Try again."); }

  const okDate = (d: string | null) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null);
  const receipts: ReadReceipt[] = (raw.receipts ?? []).filter((r) => !r.blank && r.lines.length > 0).map((r) => ({
    key: randomUUID(), photo: opts.photo, number: String(r.number ?? "").trim(), date: okDate(r.date),
    written_total: r.written_total === null ? null : round2(Number(r.written_total)),
    existing_sale_id: null,
    lines: r.lines.map((l) => {
      const remembered = aliasMap.get(normalizeAlias(l.text));
      const fromReader = l.product_code ? idOfCode.get(l.product_code) ?? null : null;
      return {
        qty: Number(l.qty) || 0, text: String(l.text ?? "").trim(), amount: round2(Number(l.amount) || 0),
        product_id: remembered ?? fromReader, match: remembered ? "memory" : fromReader ? "reader" : null,
      };
    }),
  }));

  // A receipt number already used on a sale at this branch (not voided) is entered already.
  const refs = receipts.filter((r) => r.number).map((r) => receiptReference(r.number));
  if (refs.length) {
    const { data: existing } = await admin.from("sales").select("id, customer_reference")
      .eq("company_id", opts.companyId).eq("branch_id", opts.branchId).neq("document_status", "voided").in("customer_reference", refs);
    const byRef = new Map((existing ?? []).map((s) => [s.customer_reference, s.id]));
    for (const r of receipts) r.existing_sale_id = byRef.get(receiptReference(r.number)) ?? null;
  }

  const notebook: ReadNoteLine[] = (raw.notebook ?? []).filter((n) => Number(n.amount) > 0).map((n) => ({
    key: randomUUID(), photo: opts.photo, date: okDate(n.date), label: String(n.label ?? "").trim(), amount: round2(Number(n.amount)),
    kind: n.kind === "expense" ? "expense" : "payment",
    account_id: n.kind === "payment" ? methodByCode.get(String(n.method_code ?? "").toUpperCase()) ?? null : null,
    category_id: n.kind === "expense" ? catByCode.get(String(n.category_code ?? "")) ?? null : null,
    paid_from_account_id: n.kind === "expense" ? cash : null,
  }));

  return { receipts, notebook };
}
