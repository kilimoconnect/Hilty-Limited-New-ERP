/**
 * Step 3 of the old-system transfer: replay the staged old documents through
 * the new ERP's posting functions (see import.sql), then reconcile against the
 * old system.
 *
 *   npx tsx scripts/transfer/run-import.ts            (dry run: everything rolled back)
 *   npx tsx scripts/transfer/run-import.ts --commit   (keeps the result)
 *
 * Prerequisites: stage.ts has been run; users.ts --commit for logins/profiles.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { createDbClient } from "../db";

const commit = process.argv.includes("--commit");
const OPENING_DATE = "2026-01-01";

async function table(db: Client, title: string, sql: string) {
  const { rows } = await db.query(sql);
  console.log(`\n${title}`);
  if (!rows.length) { console.log("  (none)"); return rows; }
  console.table(rows);
  return rows;
}

async function main() {
  const db = createDbClient();
  await db.connect();
  const t0 = Date.now();
  try {
    await db.query("set statement_timeout = 0");
    await db.query("begin");
    const already = await db.query(
      "select count(*)::int n from public.sales where id in (select id from legacy.fin_sales)").catch(() => ({ rows: [{ n: 0 }] }));
    if (already.rows[0].n > 0) throw new Error("Old documents are already imported - refusing to import twice.");

    await db.query(readFileSync(join(__dirname, "import.sql"), "utf8"));
    await db.query("delete from legacy.import_log");
    await table(db, "Replay result", `select * from legacy.run_import('${OPENING_DATE}')`);

    await table(db, "Failures by reason (first 40)", `
      select step, left(message, 110) as reason, count(*)::int as n, min(doc_no) as example
        from legacy.import_log where not ok group by 1, 2 order by 3 desc limit 40`);

    await table(db, "Documents: old vs new", `
      select 'sales' doc, (select count(*) from legacy.fin_sales where status='POSTED')::int old_n,
             (select sum(total_amount) from legacy.fin_sales where status='POSTED') old_total,
             (select count(*) from public.sales s where s.id in (select id from legacy.fin_sales) and document_status='posted')::int new_n,
             (select sum(grand_total) from public.sales s where s.id in (select id from legacy.fin_sales) and document_status='posted') new_total
      union all select 'purchases', (select count(*) from legacy.fin_purchases)::int, (select sum(total_amount) from legacy.fin_purchases),
             (select count(*) from public.purchases where id in (select id from legacy.fin_purchases) and document_status='posted')::int,
             (select sum(grand_total) from public.purchases where id in (select id from legacy.fin_purchases) and document_status='posted')
      union all select 'purchases unpaid', null, (select sum(balance) from legacy.fin_purchases where balance >= 1), null,
             (select sum(outstanding) from public.purchases where id in (select id from legacy.fin_purchases))
      union all select 'expenses', (select count(*) from legacy.ops_petty_cash)::int, (select sum(amount) from legacy.ops_petty_cash),
             (select count(*) from public.expenses where id in (select id from legacy.ops_petty_cash) and document_status='posted')::int,
             (select sum(grand_total) from public.expenses where id in (select id from legacy.ops_petty_cash) and document_status='posted')
      union all select 'cash transfers', (select count(*) from legacy.ops_cash_transfers)::int, (select sum(amount) from legacy.ops_cash_transfers),
             (select count(*) from public.cash_transfers where id in (select id from legacy.ops_cash_transfers) and document_status='posted')::int,
             (select sum(amount) from public.cash_transfers where id in (select id from legacy.ops_cash_transfers) and document_status='posted')
      union all select 'stock transfers', (select count(*) from legacy.fin_transfers)::int, null,
             (select count(*) from public.stock_transfers where id in (select id from legacy.fin_transfers) and status in ('received','closed'))::int, null`);

    await table(db, "Stock on hand: old vs new (by branch)", `
      with o as (select legacy.br(branch_id) b, product_id, quantity_on_hand q, quantity_on_hand * weighted_avg_cost v from legacy.public_stock),
           n as (select branch_id b, product_id, quantity q, stock_value v from public.stock_balances)
      select br.code, sum(o.q) old_qty, sum(n.q) new_qty,
             count(*) filter (where abs(coalesce(o.q,0) - coalesce(n.q,0)) > 0.0001)::int qty_differences,
             round(sum(o.v)) old_value, round(sum(n.v)) new_value
        from o full join n on n.b = o.b and n.product_id = o.product_id
        join public.branches br on br.id = coalesce(o.b, n.b)
       group by br.code order by br.code`);

    await table(db, "Stock quantity differences (first 15)", `
      with o as (select legacy.br(branch_id) b, product_id, quantity_on_hand q from legacy.public_stock),
           n as (select branch_id b, product_id, quantity q from public.stock_balances)
      select br.code, p.sku, left(p.name, 40) product, o.q old_qty, n.q new_qty
        from o full join n on n.b = o.b and n.product_id = o.product_id
        join public.branches br on br.id = coalesce(o.b, n.b) join public.products p on p.id = coalesce(o.product_id, n.product_id)
       where abs(coalesce(o.q,0) - coalesce(n.q,0)) > 0.0001 order by 1, 2 limit 15`);

    await table(db, "Money balances: old ledger vs new", `
      with o as (select legacy.pa(legacy.br(branch_id), payment_method) pa, sum(case when flow_type='IN' then amount else -amount end) net
                   from legacy.fin_payment_method_ledger where not coalesce(voided, false) group by 1)
      select pa.code, o.net old_balance, public.payment_account_balance(pa.id) new_balance
        from public.payment_accounts pa left join o on o.pa = pa.id
       where pa.is_active and (o.net is not null or public.payment_account_balance(pa.id) <> 0) order by pa.code`);

    await table(db, "Journals balanced", `
      select count(distinct j.id)::int journals, sum(l.debit) debit, sum(l.credit) credit
        from public.journal_entries j join public.journal_lines l on l.journal_id = j.id`);

    await table(db, "Users", `
      select p.email, p.full_name, r.code role, p.is_active,
             (select string_agg(b.code, ',' order by b.code) from public.user_branch_access a join public.branches b on b.id=a.branch_id where a.user_id=p.id) branches
        from public.user_profiles p join public.roles r on r.id = p.role_id order by p.email`);

    if (commit) {
      await db.query(`drop function if exists legacy.run_import(date), legacy.load_master(), legacy.imp_opening(uuid, date),
        legacy.imp_sale(uuid), legacy.imp_purchase(uuid), legacy.imp_expense(uuid), legacy.imp_cash_transfer(uuid),
        legacy.imp_transfer_dispatch(uuid), legacy.imp_transfer_receive(uuid)`);
      await db.query("commit");
      console.log(`\nCOMMITTED in ${Math.round((Date.now() - t0) / 1000)}s.`);
    } else {
      await db.query("rollback");
      console.log(`\nDRY RUN finished in ${Math.round((Date.now() - t0) / 1000)}s - everything rolled back.`);
    }
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
}

main().catch((e) => {
  console.error("Import failed:", e.message);
  process.exit(1);
});
