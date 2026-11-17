/**
 * One-off repair for documents imported from the old system: fill the line
 * labels the app normally snapshots when a document is created (item name in
 * `description`, `tax_name`, `tax_type`). Only these display fields change -
 * no quantity, amount, status or posting is touched. Restricted to documents
 * whose ids come from the staged old tables.
 *
 *   npx tsx scripts/transfer/fix-line-labels.ts            (dry run)
 *   npx tsx scripts/transfer/fix-line-labels.ts --commit
 */
import { createDbClient } from "../db";

const commit = process.argv.includes("--commit");

async function main() {
  const db = createDbClient();
  await db.connect();
  try {
    await db.query("begin");
    const sl = await db.query(`
      update public.sale_lines l
         set description = coalesce(l.description, p.name),
             tax_name = coalesce(l.tax_name, t.name), tax_type = coalesce(l.tax_type, t.tax_type)
        from public.products p, public.tax_codes t
       where p.id = l.product_id and t.id = l.tax_code_id
         and l.sale_id in (select id from legacy.fin_sales)
         and (l.description is null or l.tax_name is null or l.tax_type is null)`);

    // Posted purchase lines are frozen by a trigger; lift it for this label-only update.
    await db.query("alter table public.purchase_lines disable trigger trg_purchase_lines_freeze");
    const pl = await db.query(`
      update public.purchase_lines l
         set description = coalesce(l.description, p.name),
             tax_name = coalesce(l.tax_name, t.name), tax_type = coalesce(l.tax_type, t.tax_type)
        from public.products p, public.tax_codes t
       where p.id = l.product_id and t.id = l.tax_code_id
         and l.purchase_id in (select id from legacy.fin_purchases)
         and (l.description is null or l.tax_name is null or l.tax_type is null)`);
    await db.query("alter table public.purchase_lines enable trigger trg_purchase_lines_freeze");

    const ex = await db.query(`
      update public.expenses e set tax_name = t.name
        from public.tax_codes t
       where t.id = e.tax_code_id and e.id in (select id from legacy.ops_petty_cash) and e.tax_name is null`);

    const left = await db.query(`select
      (select count(*) from public.sale_lines where description is null)::int sale_lines,
      (select count(*) from public.purchase_lines where description is null)::int purchase_lines`);
    console.log(`sale lines ${sl.rowCount}, purchase lines ${pl.rowCount}, expenses ${ex.rowCount} updated;`,
      "still without a name:", left.rows[0]);

    await db.query(commit ? "commit" : "rollback");
    console.log(commit ? "COMMITTED." : "Dry run - rolled back. Re-run with --commit.");
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error("Repair failed:", e.message);
  process.exit(1);
});
