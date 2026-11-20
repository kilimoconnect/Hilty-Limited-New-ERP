/**
 * The branch filter of a list or report page (?branch=).
 *
 *   ?branch=<id>  that branch (one of the user's)
 *   ?branch=all   every branch the user works in
 *   (none)        the branch selected in the header - not "all branches"
 *
 * `branch` is what the page filters by ("" = all of the user's branches);
 * `branchParam` is what the filter shows and what links / paging carry, so a
 * chosen "All branches" is kept when moving to the next page.
 */
export function pageBranch(
  ctx: { branchId: string | null; branches: { id: string }[] },
  sp: Record<string, string | string[] | undefined>,
): { branch: string; branchParam: string } {
  const v = sp.branch;
  const raw = typeof v === "string" ? v : Array.isArray(v) ? v[0] ?? "" : "";
  if (raw === "all") return { branch: "", branchParam: "all" };
  if (raw && ctx.branches.some((b) => b.id === raw)) return { branch: raw, branchParam: raw };
  const active = ctx.branchId && ctx.branches.some((b) => b.id === ctx.branchId) ? ctx.branchId : "";
  return { branch: active, branchParam: active || "all" };
}
