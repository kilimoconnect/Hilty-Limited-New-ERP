/**
 * Pure role-limit rules (no database), shared by the server actions and the
 * unit tests. NULL means no limit. Dates are YYYY-MM-DD in company time.
 */
export interface RoleLimits {
  backdateDays: number | null;
  maxDiscountPct: number | null;
  pettyCashCap: number | null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Error message when the document date is outside the role's back-dating window, else null. */
export function backdateError(limits: RoleLimits, documentDate: string | null | undefined, today: string): string | null {
  if (limits.backdateDays === null || !documentDate) return null;
  const date = String(documentDate).slice(0, 10);
  if (date > today) return "Your role cannot post documents dated in the future.";
  const earliest = addDays(today, -limits.backdateDays);
  if (date < earliest) {
    return limits.backdateDays === 0
      ? "Your role can only post documents dated today."
      : `Your role can only post documents dated from ${earliest} (up to ${limits.backdateDays} day(s) back).`;
  }
  return null;
}

/**
 * Error message when a sale line is reduced below its list price by more than
 * the role allows (line discount and any lower unit price both count), else null.
 */
export function discountError(
  limits: RoleLimits,
  lines: { quantity: number; unit_price: number; original_price: number | null; discount: number; description?: string | null }[],
): string | null {
  if (limits.maxDiscountPct === null) return null;
  for (const l of lines) {
    const list = Number(l.original_price ?? l.unit_price) * Number(l.quantity);
    if (list <= 0) continue;
    const charged = Number(l.unit_price) * Number(l.quantity) - Number(l.discount ?? 0);
    const pct = ((list - charged) / list) * 100;
    if (pct > limits.maxDiscountPct + 1e-9) {
      return `${l.description ?? "A line"} is ${pct.toFixed(1)}% below its price; your role allows at most ${limits.maxDiscountPct}%.`;
    }
  }
  return null;
}

/** Error message when an expense paid from a cash till exceeds the role's petty-cash cap, else null. */
export function pettyCashError(limits: RoleLimits, amount: number, paidFromCash: boolean): string | null {
  if (limits.pettyCashCap === null || !paidFromCash) return null;
  return amount > limits.pettyCashCap + 0.005
    ? `Expenses paid from cash are limited to ${limits.pettyCashCap.toLocaleString("en-US")} for your role.`
    : null;
}
