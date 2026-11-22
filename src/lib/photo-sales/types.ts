/**
 * Sales from photos: the items read from photos of handwritten cash-sale
 * receipts, and the checks that decide which receipts may become drafts.
 * Shared by the server and the review page.
 */

export interface ReadLine {
  qty: number;
  /** The item as written ("W-guard wo 4lt"). */
  text: string;
  /** Line total in TZS as written (VAT inclusive). */
  amount: number;
  product_id: string | null;
  /** How the product was found: the short-form memory, the reader, or by hand. */
  match: "memory" | "reader" | "user" | null;
}

export interface ReadReceipt {
  key: string;
  /** Index of the photo it came from (0-based). */
  photo: number;
  number: string;
  date: string | null;
  written_total: number | null;
  lines: ReadLine[];
  /** A sale with this receipt number already exists at the branch. */
  existing_sale_id: string | null;
}

export interface PhotoReadResult {
  receipts: ReadReceipt[];
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** "w-guard  wo 4lt." -> "w-guard wo 4lt" (the key of the short-form memory). */
export function normalizeAlias(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:]+$/g, "").trim().slice(0, 120);
}

/** The reference stored on a combined sale: "Receipts 0195, 0196, 0197". */
export const receiptsReference = (numbers: string[]) =>
  `${numbers.length === 1 ? "Receipt" : "Receipts"} ${numbers.map((n) => n.trim()).join(", ")}`.slice(0, 250);

/** Receipt numbers on a stored reference ("Receipt 0197" or "Receipts 0195, 0196"). */
export function referenceNumbers(ref: string | null | undefined): string[] {
  if (!ref || !/^receipts?\s/i.test(ref)) return [];
  return ref.replace(/^receipts?\s+/i, "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
}

export const linesTotal = (r: ReadReceipt) => round2(r.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));

/**
 * Why a receipt cannot become a draft yet. Empty = every item has a quantity,
 * an amount and a product, and the receipt has a date. (Payments and the
 * receipt's total are left to the draft.)
 */
export function receiptIssues(r: ReadReceipt): string[] {
  const issues: string[] = [];
  if (r.existing_sale_id) issues.push("Already entered: a sale with this receipt number exists.");
  if (!r.date) issues.push("No date could be read.");
  if (r.lines.length === 0) issues.push("No items could be read.");
  for (const l of r.lines) {
    if (!(l.qty > 0)) issues.push(`"${l.text}": quantity could not be read.`);
    if (!(l.amount > 0)) issues.push(`"${l.text}": price could not be read.`);
    if (!l.product_id) issues.push(`"${l.text}": product not matched.`);
  }
  return issues;
}

