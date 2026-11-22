/**
 * Sales from photos: what is read from a photo of handwritten cash-sale
 * receipts and the day's notebook page, and the checks that decide which
 * receipts may become drafts. Shared by the server and the review page.
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

export interface ReadNoteLine {
  key: string;
  photo: number;
  date: string | null;
  label: string;
  amount: number;
  kind: "payment" | "expense" | "ignore";
  /** Payment account (branch payment method) the money is on. */
  account_id: string | null;
  /** Expense only: the category, and the method it was paid from. */
  category_id: string | null;
  paid_from_account_id: string | null;
}

export interface PhotoReadResult {
  receipts: ReadReceipt[];
  notebook: ReadNoteLine[];
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** "w-guard  wo 4lt." -> "w-guard wo 4lt" (the key of the short-form memory). */
export function normalizeAlias(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[.,;:]+$/g, "").trim().slice(0, 120);
}

/** The reference stored on the sale, used to spot a receipt entered twice. */
export const receiptReference = (number: string) => `Receipt ${number.trim()}`;

export const linesTotal = (r: ReadReceipt) => round2(r.lines.reduce((s, l) => s + (Number(l.amount) || 0), 0));

/**
 * Why a receipt cannot become a draft. Empty = it matches and can be drafted.
 * A receipt whose lines do not add up to its written total is left for the
 * user to enter by hand.
 */
export function receiptIssues(r: ReadReceipt): string[] {
  const issues: string[] = [];
  if (r.existing_sale_id) issues.push("Already entered: a sale with this receipt number exists.");
  if (!r.date) issues.push("No date could be read.");
  if (r.lines.length === 0) issues.push("No items could be read.");
  const sum = linesTotal(r);
  if (r.written_total === null) issues.push("The receipt total could not be read.");
  else if (Math.abs(sum - r.written_total) > 0.5)
    issues.push(`Total mismatch: the items add up to ${sum.toLocaleString("en-US")}, the receipt says ${r.written_total.toLocaleString("en-US")}.`);
  for (const l of r.lines) {
    if (!(l.qty > 0)) issues.push(`"${l.text}": quantity could not be read.`);
    if (!(l.amount > 0)) issues.push(`"${l.text}": amount could not be read.`);
    if (!l.product_id) issues.push(`"${l.text}": product not matched.`);
  }
  return issues;
}

/** Only a mismatch that the user can fix on the review page (choosing a product). */
export const onlyUnmatched = (r: ReadReceipt) => {
  const i = receiptIssues(r);
  return i.length > 0 && i.every((x) => x.endsWith("product not matched."));
};
