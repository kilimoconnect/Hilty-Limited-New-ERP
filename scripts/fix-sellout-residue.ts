/**
 * One-off correction for migration 0037: before it, a stock-out that emptied an
 * item left the rounding residue (cents) in GL 1150 while the stock balance
 * went to zero. This posts ONE manual control-adjustment journal moving that
 * residue, per branch, to cost of sales (Dr 5100 / Cr 1150), so the inventory
 * valuation and the Inventory account agree again. Posted through the normal
 * manual-journal function: numbered, visible under Journals, voidable.
 *
 *   npx tsx scripts/fix-sellout-residue.ts            (dry run)
 *   npx tsx scripts/fix-sellout-residue.ts --commit
 */
import { createDbClient } from "./db";

const commit = process.argv.includes("--commit");

async function main() {
  const db = createDbClient();
  await db.connect();
  try {
    await db.query("begin");
    const co = (await db.query("select id from companies where code = 'HILTY'")).rows[0].id as string;
    const owner = (await db.query("select id from user_profiles where is_primary_owner")).rows[0].id as string;

    // Residue per branch: value left when the balance hit zero minus the value booked out.
    const { rows: res } = await db.query<{ branch_id: string; code: string; residue: string }>(`
      with m as (select sm.*, lag(sm.balance_value) over (partition by sm.branch_id, sm.product_id order by sm.created_at, sm.id) prev_value
                   from public.stock_movements sm where sm.company_id = $1)
      select m.branch_id, b.code, round(sum(coalesce(m.prev_value, 0) - m.movement_value), 2) residue
        from m join public.branches b on b.id = m.branch_id
       where m.qty_out > 0 and m.balance_qty = 0
       group by 1, 2 having round(sum(coalesce(m.prev_value, 0) - m.movement_value), 2) <> 0 order by 2`, [co]);
    const gap = async () => (await db.query(`select
        (select coalesce(sum(l.debit - l.credit), 0) from public.journal_lines l join public.journal_entries j on j.id = l.journal_id
          join public.chart_of_accounts a on a.id = l.account_id where j.company_id = $1 and a.code = '1150')
      - (select coalesce(sum(stock_value), 0) from public.stock_balances where company_id = $1) as gap`, [co])).rows[0].gap;
    console.log("Residue by branch:", res.map((r) => `${r.code} ${r.residue}`).join(", ") || "none");
    console.log("GL 1150 minus stock before:", await gap());
    if (!res.length) { await db.query("rollback"); console.log("Nothing to correct."); return; }

    const acc = async (code: string) => (await db.query("select id from public.chart_of_accounts where company_id = $1 and code = $2", [co, code])).rows[0].id as string;
    const inv = await acc("1150"), cogs = await acc("5100");
    const draft = (await db.query(`insert into public.manual_journal_drafts(company_id, journal_date, reference, description, notes, created_by)
      values ($1, current_date, 'STOCK-ROUNDING', 'Stock rounding on sell-outs before migration 0037',
              'When an item sold out, the cents left from average-cost rounding stayed in Inventory (1150) while the stock balance went to zero. Moved to cost of sales.', $2)
      returning id`, [co, owner])).rows[0].id as string;
    let no = 0;
    for (const r of res) {
      const v = Number(r.residue);
      const [dr, cr] = v > 0 ? [cogs, inv] : [inv, cogs];
      const amt = Math.abs(v);
      await db.query(`insert into public.manual_journal_draft_lines(draft_id, account_id, branch_id, debit, credit, description, line_no)
        values ($1,$2,$3,$4,0,$5,$6), ($1,$7,$3,0,$4,$5,$8)`,
        [draft, dr, r.branch_id, amt, `Sell-out rounding ${r.code}`, ++no, cr, ++no]);
    }
    await db.query("select public.post_manual_journal($1, $2, $3, true)", [draft, owner, `stock-rounding-${draft}`]);
    const num = (await db.query("select document_number from public.manual_journal_drafts where id = $1", [draft])).rows[0].document_number;
    console.log(`Journal ${num} posted; GL 1150 minus stock after:`, await gap());

    await db.query(commit ? "commit" : "rollback");
    console.log(commit ? "COMMITTED." : "Dry run - rolled back. Re-run with --commit.");
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error("Correction failed:", e.message); process.exit(1); });
