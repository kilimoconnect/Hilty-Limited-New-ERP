import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { todayISO } from "@/lib/format";
import type { CurrentUser } from "@/lib/auth/session";
import { backdateError as rulesBackdateError, type RoleLimits } from "@/lib/auth/limit-rules";

/**
 * Per-role limits (roles.backdate_days / max_discount_pct / petty_cash_cap,
 * migration 0038). NULL means no limit; the Owner is never limited.
 * Checked by the server actions before they post, since they are the only
 * callers of the posting functions.
 */
export type { RoleLimits } from "@/lib/auth/limit-rules";
export { discountError, pettyCashError } from "@/lib/auth/limit-rules";


const NONE: RoleLimits = { backdateDays: null, maxDiscountPct: null, pettyCashCap: null };

export async function roleLimits(user: CurrentUser): Promise<RoleLimits> {
  if (user.isOwner || !user.role) return NONE;
  const { data } = await createAdminClient().from("roles")
    .select("backdate_days, max_discount_pct, petty_cash_cap").eq("id", user.role.id).maybeSingle();
  if (!data) return NONE;
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return { backdateDays: n(data.backdate_days), maxDiscountPct: n(data.max_discount_pct), pettyCashCap: n(data.petty_cash_cap) };
}

/** Error message when the document date is outside the role's back-dating window, else null. */
export function backdateError(limits: RoleLimits, documentDate: string | null | undefined): string | null {
  return rulesBackdateError(limits, documentDate, todayISO());
}

/** Back-dating check for a posting by this user, given the document date. */
export async function postingDateError(user: CurrentUser, documentDate: string | null | undefined): Promise<string | null> {
  return backdateError(await roleLimits(user), documentDate);
}

/** Back-dating check that reads the date from the stored document (table.column for id). */
export async function storedDateError(user: CurrentUser, table: string, column: string, id: string): Promise<string | null> {
  if (user.isOwner) return null;
  const { data } = await createAdminClient().from(table).select(column).eq("id", id).maybeSingle();
  const date = (data as Record<string, unknown> | null)?.[column];
  return postingDateError(user, typeof date === "string" ? date : null);
}
