/**
 * Step 3 of the old-system transfer: replay the staged old documents through
 * the new ERP's posting functions (see import.sql), then reconcile against the
 * old system.
 *
 *   npx tsx scripts/transfer/run-import.ts            (dry run: everything rolled back)
 *   npx tsx scripts/transfer/run-import.ts --commit   (keeps the result)
 *   add --reset to first clear a previous import (see RESET_TABLES)
 *
 * Prerequisites: stage.ts has been run; users.ts --commit for logins/profiles.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "pg";
import { createDbClient } from "../db";

const commit = process.argv.includes("--commit");
const reset = process.argv.includes("--reset");
const OPENING_DATE = "2026-01-01";

// Tables that hold only documents and their postings. --reset empties them so
// the import can run again; settings, master data, users and the chart of
// accounts are kept. Refused if any document did not come from the old system.
const RESET_TABLES = [
  "sale_payments", "sale_lines", "sales",
  "purchase_payments", "purchase_lines", "purchases", "supplier_payables", "supplier_payable_events",
  "expense_payments", "expenses", "cash_transfers",
  "stock_transfer_receipt_lines", "stock_transfer_receipts", "stock_transfer_dispatch_lines", "stock_transfer_dispatches",
  "stock_transfer_events", "stock_transfer_lines", "stock_transfers",
  "inventory_opening_lines", "inventory_openings",
  "stock_movements", "stock_balances", "journal_lines", "journal_entries",
  "transaction_status_history", "idempotency_keys",
];

async function resetPreviousImport(db: Client) {
  const { rows } = await db.query(`select
      (select count(*) from public.sales where id not in (select id from legacy.fin_sales))
    + (select count(*) from public.purchases where id not in (select id from legacy.fin_purchases))
    + (select count(*) from public.expenses where id not in (select id from legacy.ops_petty_cash))
    + (select count(*) from public.cash_transfers where id not in (select id from legacy.ops_cash_transfers))
    + (select count(*) from public.stock_transfers where id not in (select id from legacy.fin_transfers))
    + (select count(*) from public.inventory_openings where reference is distinct from 'Old system opening stock')
    + (select count(*) from public.journal_entries where source_type not in
        ('sale','purchase','expense','cash_transfer','inventory_opening','stock_transfer_dispatch','stock_transfer_receipt')) as n`);
  if (Number(rows[0].n) > 0) {
    throw new Error(`${rows[0].n} document(s) were entered in the new system - refusing to reset.`);
  }
  // Every table that references the cleared ones must be cleared with them; that
  // is only allowed when it is empty (e.g. returns, receipts never used yet).
  const set = new Set(RESET_TABLES);
  for (let grew = true; grew; ) {
    grew = false;
    const { rows: refs } = await db.query<{ t: string }>(
      `select distinct c.conrelid::regclass::text as t from pg_constraint c
        where c.contype = 'f' and c.confrelid::regclass::text = any($1::text[]) and not (c.conrelid::regclass::text = any($1::text[]))`,
      [[...set].map((t) => t)]);
    for (const { t } of refs) {
      const name = t.replace(/^public\./, "");
      const { rows: c } = await db.query(`select exists (select 1 from public.${name}) as has`);
      if (c[0].has) throw new Error(`Table ${name} references imported documents and holds data - refusing to reset.`);
      set.add(name);
      grew = true;
    }
  }
  await db.query(`truncate ${[...set].map((t) => `public.${t}`).join(", ")}`);
  await db.query("update public.document_sequences set current_number = 0, updated_at = now()");
  console.log(`Reset: previous import cleared (${set.size} document tables, ${set.size - RESET_TABLES.length} of them already empty; numbering restarted).`);
}

const SUMMARY = `select (select round(sum(total_cost)) from public.inventory_openings where document_status='posted') opening_stock,
  (select round(sum(net_total)) from public.sales where document_status='posted') sales_net,
  (select round(sum(cogs_total)) from public.sales where document_status='posted') cogs,
  (select round(sum(net_total) - sum(cogs_total)) from public.sales where document_status='posted') gross_profit,
  (select round(sum(stock_value)) from public.stock_balances) closing_stock,
  (select round(sum(quantity)) from public.stock_balances) closing_qty`;

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
    await table(db, "Before", SUMMARY);
    if (reset) await resetPreviousImport(db);
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

    await table(db, "After", SUMMARY);

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
