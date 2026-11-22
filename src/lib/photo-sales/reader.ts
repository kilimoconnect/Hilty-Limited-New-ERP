import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { makeMatcher } from "./matcher";
import { normalizeAlias, receiptReference, round2, type PhotoReadResult, type ReadReceipt } from "./types";

/**
 * Reads the items on one photo of handwritten cash-sale receipts with an
 * OpenAI vision model. The model sees the product list (short codes) and the
 * remembered short forms, and answers in a fixed JSON shape. Server only: the API
 * key never reaches the browser.
 */

// Handwritten digits need a strong vision model. Tried in order until one is available
// on the account; OPENAI_VISION_MODEL puts a chosen model first.
const MODELS = Array.from(new Set([process.env.OPENAI_VISION_MODEL, "gpt-5", "gpt-4.1", "gpt-4o"].filter(Boolean) as string[]));
const isReasoning = (m: string) => /^(gpt-5|o\d)/.test(m);

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["receipts"],
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
  },
} as const;

type Raw = {
  receipts: { number: string; date: string | null; written_total: number | null; blank: boolean; lines: { qty: number; text: string; amount: number; product_code: string | null }[] }[];
};

export class ReaderError extends Error {}

export async function readPhoto(opts: { image: string; companyId: string; branchId: string; photo: number }): Promise<PhotoReadResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new ReaderError("Reading photos is not set up yet: the OpenAI API key (OPENAI_API_KEY) is missing on the server.");
  const admin = createAdminClient();
  const [{ data: products }, { data: aliases }] = await Promise.all([
    admin.from("products").select("id, sku, name, selling_price").eq("company_id", opts.companyId).eq("is_active", true).order("name"),
    admin.from("photo_item_aliases").select("alias, product_id, uses").eq("company_id", opts.companyId).order("uses", { ascending: false }).limit(400),
  ]);
  const prods = products ?? [];
  const codeOf = new Map(prods.map((p, i) => [p.id, `P${i + 1}`]));
  const idOfCode = new Map(prods.map((p, i) => [`P${i + 1}`, p.id]));
  const aliasMap = new Map((aliases ?? []).map((a) => [a.alias, a.product_id]));
  const match = makeMatcher(prods.map((p) => ({ id: p.id, name: p.name, price: Number(p.selling_price) })));

  const prompt = [
    "You read photos from a paint and hardware shop in Tanzania (Hilty Limited).",
    "A photo shows handwritten CASH SALE receipts (printed receipt number such as 0197, a date, lines of Qty / Particulars / Shs, and a TOTAL).",
    "Your job is to read the items on each receipt accurately. Ignore anything that is not a cash-sale receipt (e.g. a notebook page).",
    "",
    "Rules:",
    "- Read every receipt in the photo, including blank ones (blank=true, no lines). Use the printed number.",
    "- Dates are written day/month/year with a 2-digit year (21/11/26 = 2026-11-21). Return YYYY-MM-DD. If a receipt has no date, return null.",
    "- Amounts are Tanzanian shillings; '380,000' = 380000, '3500' = 3500, '1,500' = 1500. A trailing '/=' or '=' is not a digit.",
    "- The Shs column is the LINE TOTAL for that quantity, not the unit price. Copy it exactly as written; do not correct the receipt.",
    "- written_total is the number written next to TOTAL. Do not compute it.",
    "- 'qty' is the number in the Qty column ('1roll' = 1, '1ctn' = 1).",
    "- CHECK YOURSELF before answering, for every receipt:",
    "  1. Add up the line amounts. If the sum is not exactly the written TOTAL, look again at each digit of each amount and quantity:",
    "     handwritten 1/7, 3/5/8, 2/7, 0/6, 4/9 are easily confused, and thousands are written like '3,000' or '3000'.",
    "  2. Compare each line with the usual price in the product list: amount / qty is normally close to the usual price",
    "     (e.g. an R BRUSH PVC is about 3,400, so '3000' is far more likely than '7000').",
    "  3. Choose the reading that makes the lines add up to the TOTAL and agrees with the usual prices.",
    "  Only if the receipt still does not add up after this, return what is written; never invent lines.",
    "- product_code: choose the product from the list that the item text means. Short forms are common:",
    "  'W-guard' = WEATHER GUARD, 'R-brush' = R BRUSH (roller brush), 's/s' or '5/5' often a size, 'O-paint' = oil paint, 'F-tape' = fibre tape, 'E paint' = E PAINTS,",
    "  sizes like 20l/20lt, 4lt, 1lt, 3\" = 3inch. Match colour and size. If you are not sure, return null rather than guessing.",
    "- Known short forms (always use these when the text matches):",
    ...(aliases ?? []).slice(0, 400).map((a) => `  "${a.alias}" => ${codeOf.get(a.product_id) ?? "?"}`).filter((l) => !l.endsWith("?")),
    "- Return receipts: [] if there are none.",
    "",
    "Product list (code|name|usual price TZS):",
    ...prods.map((p, i) => `P${i + 1}|${p.name}|${Number(p.selling_price)}`),
  ].join("\n");

  let json: { choices?: { message?: { content?: string } }[] } | null = null;
  let lastError = "";
  for (const model of MODELS) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      // Stay inside the 300-second server limit.
      signal: AbortSignal.timeout(280_000),
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        ...(isReasoning(model) ? { reasoning_effort: "low" } : { temperature: 0 }),
        response_format: { type: "json_schema", json_schema: { name: "receipts", strict: true, schema: SCHEMA } },
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: [
            { type: "text", text: "Read this photo. Check every receipt's lines against its TOTAL before you answer." },
            { type: "image_url", image_url: { url: opts.image, detail: "high" } },
          ] },
        ],
      }),
    }).catch((e: unknown) => {
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"))
        throw new ReaderError("Reading this photo took too long. Try again, or photograph fewer receipts per photo.");
      throw e;
    });
    if (res.ok) { json = await res.json(); break; }
    const body = await res.text().catch(() => "");
    const msg = (() => { try { return String(JSON.parse(body).error?.message ?? ""); } catch { return ""; } })();
    lastError = `The photo reader failed (${res.status})${msg ? `: ${msg}` : "."}`;
    // Model not available on this account (or not allowed these options): try the next one.
    const modelProblem = res.status === 404 || (res.status === 400 && /model|reasoning|temperature|unsupported/i.test(msg)) || res.status === 403;
    if (!modelProblem) break;
  }
  if (!json) throw new ReaderError(lastError || "The photo reader failed.");
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
      const qty = Number(l.qty) || 0, amount = round2(Number(l.amount) || 0);
      const remembered = aliasMap.get(normalizeAlias(l.text));
      const fromReader = l.product_code ? idOfCode.get(l.product_code) ?? null : null;
      // Backup: the shop's short forms, sizes and the unit price.
      const fromMatcher = !remembered && !fromReader ? match(String(l.text ?? ""), qty > 0 ? amount / qty : null) : null;
      const product_id = remembered ?? fromReader ?? fromMatcher;
      return {
        qty, text: String(l.text ?? "").trim(), amount,
        product_id, match: remembered ? "memory" as const : product_id ? "reader" as const : null,
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


  return { receipts };
}
