/**
 * Step 1 of the old-system transfer: copy the OLD Hilty system's raw tables,
 * unchanged, into the `legacy` schema of the NEW database. The old database is
 * only ever read (the connection is forced read-only).
 *
 *   npx tsx scripts/transfer/stage.ts
 *
 * Each old table <schema>.<table> becomes legacy.<schema>_<table> with the same
 * column types. Re-running drops and re-copies the staged tables. No password
 * hashes are staged (logins are moved by users.ts through the Auth admin API).
 */
import { types } from "pg";
import { createDbClient } from "../db";
import { connectOld } from "./old-db";

// Keep dates/timestamps as the server's text so nothing shifts by time zone.
for (const oid of [1082, 1114, 1184]) types.setTypeParser(oid, (v: string) => v);

export const STAGED_TABLES = [
  "ref.branches", "ref.brands", "ref.categories", "ref.expense_categories", "ref.units", "ref.tax_codes",
  "public.products", "public.product_branches", "public.stock", "public.kardex", "public.ops_contacts",
  "sec.app_users", "sec.roles", "sec.user_roles", "sec.user_branches", "sec.role_permissions", "sec.payment_methods",
  "fin.sales", "fin.sale_lines", "fin.sale_payments",
  "fin.purchases", "fin.purchase_lines", "fin.purchase_payments", "fin.supplier_ledger",
  "fin.transfers", "fin.transfer_lines", "fin.payment_method_ledger",
  "ops.cash_transfers", "ops.petty_cash",
];

async function main() {
  const old = await connectOld();
  const db = createDbClient();
  await db.connect();
  try {
    await db.query("create schema if not exists legacy");
    for (const t of STAGED_TABLES) {
      const [schema, table] = t.split(".");
      const target = `legacy.${schema}_${table}`;
      const cols = await old.query<{ name: string; type: string }>(
        `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type
           from pg_attribute a
          where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped
          order by a.attnum`,
        [t],
      );
      const ddl = cols.rows.map((c) => `"${c.name}" ${c.type}`).join(", ");
      const { rows } = await old.query(`select * from ${schema}.${table}`);

      await db.query("begin");
      await db.query(`drop table if exists ${target}`);
      await db.query(`create table ${target} (${ddl})`);
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        await db.query(
          `insert into ${target} select * from json_populate_recordset(null::${target}, $1::json)`,
          [JSON.stringify(chunk)],
        );
      }
      const { rows: n } = await db.query(`select count(*)::int as n from ${target}`);
      await db.query("commit");
      const ok = n[0].n === rows.length;
      console.log(`  ${ok ? "ok " : "BAD"} ${t.padEnd(28)} -> ${target.padEnd(34)} ${n[0].n}/${rows.length}`);
      if (!ok) process.exitCode = 1;
    }
    console.log("\nStaging complete (old database untouched).");
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    await old.end();
    await db.end();
  }
}

main().catch((e) => {
  console.error("Staging failed:", e.message);
  process.exit(1);
});
