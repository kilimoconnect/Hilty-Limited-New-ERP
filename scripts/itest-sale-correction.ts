/**
 * Edit posted sale (migration 0048): a correction draft points at a posted
 * sale; posting it reverses the original (stock and accounts), keeps the
 * original as voided "<number> (replaced)" and posts the correction under the
 * original number. Owner only; refused when later payments exist.
 * One transaction, ROLLED BACK. PGlite only.
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-sale-correction runs only against the PGlite test database (npm run test:db).");
  process.exit(1);
}

let passed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { console.error(`  FAIL ${name} ${detail}`); process.exitCode = 1; }
}
async function one<T = string>(db: Client, sql: string, p: unknown[] = []): Promise<T> {
  const { rows } = await db.query(sql, p);
  return (rows[0] ? Object.values(rows[0])[0] : null) as T;
}
async function fails(db: Client, sql: string, p: unknown[], expect: string): Promise<boolean> {
  await db.query("savepoint sp");
  try { await db.query(sql, p); await db.query("release savepoint sp"); return false; }
  catch (e) { await db.query("rollback to savepoint sp"); return (e as Error).message.toLowerCase().includes(expect.toLowerCase()); }
}
let k = 0;
const key = () => `sc-key-${++k}-${Math.random().toString(36).slice(2)}`;
const n = (x: unknown) => Number(x);

async function main() {
  const db = createDbClient();
  await db.connect();
  await db.query("begin");
  try {
    const co = await one(db, "select id from companies where code='HILTY'");
    const owner = await one(db, "select id from user_profiles where is_primary_owner");
    const hq = await one(db, "select id from branches where company_id=$1 and code='HQ'", [co]);
    const unit = await one(db, "select id from units where company_id=$1 limit 1", [co]);
    const walkin = await one(db, "select id from customers where company_id=$1 and code='WALK-IN'", [co]);
    const cash = await one(db, "select id from payment_accounts where company_id=$1 and is_active and account_type='cash' limit 1", [co]);
    const sup = await one(db, "insert into suppliers(company_id, code, name) values ($1,'SC-SUP','Correction Supplier') returning id", [co]);
    const prod = await one(db, "insert into products(company_id, sku, name, base_unit_id, selling_price) values ($1,'SC-A','Correction Product',$2,200) returning id", [co, unit]);
    const pur = await one(db, "insert into purchases(company_id, branch_id, supplier_id, document_date, created_by) values ($1,$2,$3,current_date,$4) returning id", [co, hq, sup, owner]);
    await db.query("insert into purchase_lines(purchase_id, product_id, quantity, unit_cost, tax_rate, is_recoverable, track_inventory, line_no) values ($1,$2,20,100,0,true,true,1)", [pur, prod]);
    await db.query("select post_purchase($1,$2,$3)", [pur, owner, key()]);
    const stock = async () => n(await one(db, "select quantity from stock_balances where branch_id=$1 and product_id=$2", [hq, prod]));

    const draft = async (qty: number, price: number, paid: number, amends: string | null) => {
      const s = await one(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, grand_total, amends_sale_id) values ($1,$2,current_date,$3,$4,$5,$6) returning id", [co, hq, walkin, owner, qty * price, amends]);
      await db.query("insert into sale_lines(sale_id, product_id, quantity, unit_price, tax_rate, track_inventory, line_no) values ($1,$2,$3,$4,0,true,1)", [s, prod, qty, price]);
      if (paid > 0) await db.query("insert into sale_payments(sale_id, payment_account_id, amount) values ($1,$2,$3)", [s, cash, paid]);
      return s;
    };

    // Original: 5 x 200 = 1,000 paid in cash.
    const orig = await draft(5, 200, 1000, null);
    await db.query("select post_sale($1,$2,$3)", [orig, owner, key()]);
    const num = await one(db, "select document_number from sales where id=$1", [orig]);
    check("original posted with an invoice number", /\d/.test(String(num)), String(num));
    check("stock after the original: 20 - 5 = 15", await stock() === 15, String(await stock()));
    const revenueBefore = n(await one(db, "select coalesce(sum(jl.credit - jl.debit),0) from journal_lines jl join journal_entries je on je.id=jl.journal_id join chart_of_accounts a on a.id=jl.account_id where je.company_id=$1 and a.code='4100'", [co]));

    // Correction: 3 x 250 = 750 paid in cash.
    const corr = await draft(3, 250, 750, orig);
    check("only one open correction per sale", await fails(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, amends_sale_id) values ($1,$2,current_date,$3,$4,$5)", [co, hq, walkin, owner, orig], "sales_one_open_amendment"));
    check("the original stays posted while the correction is a draft", (await one(db, "select document_status from sales where id=$1", [orig])) === "posted");

    const dir = await one(db, "insert into auth.users(email) values ('dirsc@test.local') returning id");
    await db.query("insert into user_profiles(id, email, full_name, role_id, default_company_id, is_active) values ($1,'dirsc@test.local','D',(select id from roles where code='DIRECTOR'),$2,true)", [dir, co]);
    await db.query("insert into user_company_access(user_id, company_id) values ($1,$2)", [dir, co]);
    check("only the Owner can post a correction", await fails(db, "select post_sale($1,$2,$3)", [corr, dir, key()], "only the owner"));

    await db.query("select post_sale($1,$2,$3)", [corr, owner, key()]);
    const o = (await db.query("select document_status, document_number, replaced_by_sale_id from sales where id=$1", [orig])).rows[0];
    const c = (await db.query("select document_status, document_number, grand_total, amends_sale_id from sales where id=$1", [corr])).rows[0];
    check("the correction keeps the original number", c.document_status === "posted" && c.document_number === num, JSON.stringify(c));
    check("the original is kept as voided '<number> (replaced)'", o.document_status === "voided" && o.document_number === `${num} (replaced)` && o.replaced_by_sale_id === corr, JSON.stringify(o));
    check("corrected total 750", n(c.grand_total) === 750);
    check("stock follows the correction: 20 - 3 = 17", await stock() === 17, String(await stock()));
    const revenueAfter = n(await one(db, "select coalesce(sum(jl.credit - jl.debit),0) from journal_lines jl join journal_entries je on je.id=jl.journal_id join chart_of_accounts a on a.id=jl.account_id where je.company_id=$1 and a.code='4100'", [co]));
    check("revenue moves from 1,000 to 750 (net change -250)", Math.round(revenueAfter - revenueBefore) === -250, `${revenueBefore} -> ${revenueAfter}`);
    check("the books still balance", n(await one(db, "select coalesce(sum(debit) - sum(credit),0) from journal_lines jl join journal_entries je on je.id=jl.journal_id where je.company_id=$1", [co])) === 0);
    const revDate = await one(db, "select entry_date::text from journal_entries where source_type='sale_void' and source_id=$1", [orig]);
    const origDate = await one(db, "select document_date::text from sales where id=$1", [orig]);
    check("the reversal is dated on the original sale's date", revDate === origDate, `${revDate} vs ${origDate}`);

    // Correcting the corrected sale again: "(replaced 2)" is not needed because the number moves on; the old copy is renamed again.
    const corr2 = await draft(4, 250, 1000, corr);
    await db.query("select post_sale($1,$2,$3)", [corr2, owner, key()]);
    check("a second correction also keeps the number", (await one(db, "select document_number from sales where id=$1", [corr2])) === num);
    check("the earlier versions are kept with distinct names",
      (await one(db, "select document_number from sales where id=$1", [corr])) === `${num} (replaced 2)`, String(await one(db, "select document_number from sales where id=$1", [corr])));
    check("stock: 20 - 4 = 16", await stock() === 16, String(await stock()));

    // Refused when a customer payment was received later.
    const cust = await one(db, "insert into customers(company_id, code, name) values ($1,'SC-CUST','Credit Customer') returning id", [co]);
    const credit = await one(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, grand_total, due_date, is_credit) values ($1,$2,current_date,$3,$4,400,current_date+30,true) returning id", [co, hq, cust, owner]);
    await db.query("insert into sale_lines(sale_id, product_id, quantity, unit_price, tax_rate, track_inventory, line_no) values ($1,$2,2,200,0,true,1)", [credit, prod]);
    await db.query("select post_sale($1,$2,$3)", [credit, owner, key()]);
    const rc = await one(db, "insert into customer_receipts(company_id, branch_id, customer_id, payment_account_id, amount, created_by) values ($1,$2,$3,$4,400,$5) returning id", [co, hq, cust, cash, owner]);
    await db.query("insert into customer_receipt_allocations(receipt_id, sale_id, amount) values ($1,$2,400)", [rc, credit]);
    await db.query("select post_customer_receipt($1,$2,null)", [rc, owner]);
    const corr3 = await one(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, grand_total, amends_sale_id, due_date, is_credit) values ($1,$2,current_date,$3,$4,400,$5,current_date+30,true) returning id", [co, hq, cust, owner, credit]);
    await db.query("insert into sale_lines(sale_id, product_id, quantity, unit_price, tax_rate, track_inventory, line_no) values ($1,$2,2,200,0,true,1)", [corr3, prod]);
    check("a sale with a later customer payment cannot be corrected", await fails(db, "select post_sale($1,$2,$3)", [corr3, owner, key()], "customer payments"));
    check("...and stays posted", (await one(db, "select document_status from sales where id=$1", [credit])) === "posted");

    const anon = n(await one(db, "select count(*) from information_schema.role_routine_grants where routine_name = '_replace_amended_sale' and grantee in ('anon','authenticated')"));
    check("the replace function is not callable by anon / authenticated", anon === 0, String(anon));
  } finally {
    await db.query("rollback");
    await db.end();
  }
  console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
