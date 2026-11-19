import "server-only";

import type { ActiveContext } from "@/lib/context";

type SP = Record<string, string | string[] | undefined>;

/**
 * Create pages (sale, purchase, expense, cash transfer, stock transfer) start
 * with the branch for users who work in more than one: the page opens only
 * with ?branch=<id> (one of the user's branches). Users with one branch go
 * straight in.
 */
export function branchStep(ctx: ActiveContext, sp: SP): { choose: true } | { choose: false; ctx: ActiveContext } {
  const asked = typeof sp.branch === "string" ? sp.branch : null;
  if (asked && ctx.branches.some((b) => b.id === asked)) return { choose: false, ctx: { ...ctx, branchId: asked } };
  if (ctx.branches.length > 1) return { choose: true };
  return { choose: false, ctx };
}
