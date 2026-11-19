/** Unit tests for the per-role limits (no database). */
import { backdateError, discountError, pettyCashError, type RoleLimits } from "../src/lib/auth/limit-rules";

let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { console.error(`  FAIL ${name} ${detail}`); process.exitCode = 1; }
}
const none: RoleLimits = { backdateDays: null, maxDiscountPct: null, pettyCashCap: null };
const today = "2026-11-19";

// Back-dating
check("no limit: any past or future date is allowed", backdateError(none, "2025-01-01", today) === null && backdateError(none, "2027-01-01", today) === null);
const todayOnly = { ...none, backdateDays: 0 };
check("0 days: today is allowed", backdateError(todayOnly, today, today) === null);
check("0 days: yesterday is refused", backdateError(todayOnly, "2026-11-18", today) !== null);
const twoDays = { ...none, backdateDays: 2 };
check("2 days: the 17th is allowed on the 19th", backdateError(twoDays, "2026-11-17", today) === null);
check("2 days: the 16th is refused on the 19th", (backdateError(twoDays, "2026-11-16", today) ?? "").includes("2026-11-17"));
check("a limit refuses future dates", backdateError(twoDays, "2026-11-20", today) !== null);
check("the window crosses month ends (1 Dec, 3 days back -> 28 Nov allowed)", backdateError({ ...none, backdateDays: 3 }, "2026-11-28", "2026-12-01") === null);
check("timestamps are read by their date part", backdateError(todayOnly, "2026-11-19T10:00:00+03:00", today) === null);

// Discounts
const tenPct = { ...none, maxDiscountPct: 10 };
const line = (o: Partial<{ quantity: number; unit_price: number; original_price: number | null; discount: number; description: string }>) =>
  ({ quantity: 2, unit_price: 100000, original_price: 100000, discount: 0, description: "SILK WHITE 20LT", ...o });
check("no discount limit: anything goes", discountError(none, [line({ discount: 150000 })]) === null);
check("10% allowed: a 20,000 discount on 200,000 (10%) passes", discountError(tenPct, [line({ discount: 20000 })]) === null);
check("10% allowed: a 20,001 discount is refused and names the item", (discountError(tenPct, [line({ discount: 20001 })]) ?? "").includes("SILK WHITE 20LT"));
check("a lower unit price counts as a discount (85,000 on 100,000 = 15%)", discountError(tenPct, [line({ unit_price: 85000 })]) !== null);
check("selling above the list price is fine", discountError(tenPct, [line({ unit_price: 120000 })]) === null);
check("lines without a list price are skipped (free items)", discountError(tenPct, [line({ unit_price: 0, original_price: 0 })]) === null);

// Petty cash
const cap = { ...none, pettyCashCap: 50000 };
check("no cap: any cash expense is allowed", pettyCashError(none, 1_000_000, true) === null);
check("cap 50,000: 50,000 from cash passes", pettyCashError(cap, 50000, true) === null);
check("cap 50,000: 50,001 from cash is refused", pettyCashError(cap, 50001, true) !== null);
check("cap only applies to cash tills (bank payment is not limited)", pettyCashError(cap, 900000, false) === null);

console.log(`\n${passed} role-limit checks passed.`);
