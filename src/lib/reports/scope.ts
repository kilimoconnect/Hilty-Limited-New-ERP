import { todayISO } from "@/lib/format";
import type { ActiveContext } from "@/lib/context";

type SP = Record<string, string | string[] | undefined>;
const one = (sp: SP, k: string) => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Branches a report may cover: null = every branch (Owner, no filter); [] = none
 * (a branch the user cannot see); otherwise the chosen branch or the user's branches.
 */
export function reportBranches(ctx: ActiveContext, branch: string): string[] | null {
  const mine = ctx.user.isOwner ? null : ctx.user.branchIds;
  if (!branch) return mine;
  return mine && !mine.includes(branch) ? [] : [branch];
}

/** Report period from ?start=&end=, defaulting to the month to date. */
export function reportPeriod(sp: SP, defaultStart?: string): { start: string; end: string } {
  const today = todayISO();
  const end = isDate(one(sp, "end")) ? one(sp, "end") : today;
  let start = isDate(one(sp, "start")) ? one(sp, "start") : (defaultStart ?? `${today.slice(0, 8)}01`);
  if (start > end) start = end;
  return { start, end };
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
