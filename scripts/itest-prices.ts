/**
 * Selling prices follow sales, upward only (migration 0044): posting a sale
 * above the selling price raises it; lower sales never lower it; the one-off
 * revision uses the most common recent sale price. Every change is logged.
 * One transaction, ROLLED BACK. PGlite only.
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-prices runs only against the PGlite test database (npm run test:db).");
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
let k = 0;
const key = () => `pr-key-${++k}-${Math.random().toString(36).slice(2)}`;
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
    const sup = await one(db, "insert into suppliers(company_id, code, name) values ($1,'PR-SUP','Price Supplier') returning id", [co]);
    const walkin = await one(db, "select id from customers where company_id=$1 and code='WALK-IN'", [co]);
    const cash = await one(db, "select id from payment_accounts where company_id=$1 and is_active and account_type='cash' limit 1", [co]);
    const prod = await one(db, "insert into products(company_id, sku, name, base_unit_id, selling_price) values ($1,'PR-A','Price Product A',$2,1000) returning id", [co, unit]);
    const prodB = await one(db, "insert into products(company_id, sku, name, base_unit_id, selling_price) values ($1,'PR-B','Price Product B',$2,500) returning id", [co, unit]);

    const pur = await one(db, "insert into purchases(company_id, branch_id, supplier_id, document_date, created_by) values ($1,$2,$3,current_date,$4) returning id", [co, hq, sup, owner]);
    await db.query("insert into purchase_lines(purchase_id, product_id, quantity, unit_cost, tax_rate, is_recoverable, track_inventory, line_no) values ($1,$2,100,100,0,true,true,1),($1,$3,100,100,0,true,true,2)", [pur, prod, prodB]);
    await db.query("select post_purchase($1,$2,$3)", [pur, owner, key()]);

    const sell = async (product: string, price: number, post = true) => {
      const s = await one(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, grand_total) values ($1,$2,current_date,$3,$4,$5) returning id", [co, hq, walkin, owner, price]);
      await db.query("insert into sale_lines(sale_id, product_id, quantity, unit_price, tax_rate, track_inventory, line_no) values ($1,$2,1,$3,0,true,1)", [s, product, price]);
      await db.query("insert into sale_payments(sale_id, payment_account_id, amount) values ($1,$2,$3)", [s, cash, price]);
      if (post) await db.query("select post_sale($1,$2,$3)", [s, owner, key()]);
      return s;
    };
    const price = async (p: string) => n(await one(db, "select selling_price from products where id=$1", [p]));
    const changes = async (p: string) => n(await one(db, "select count(*) from product_price_changes where product_id=$1", [p]));

    await sell(prod, 1200, false);
    check("a draft sale does not change the price", await price(prod) === 1000);
    await sell(prod, 1200);
    check("posting a sale above the price raises it", await price(prod) === 1200, String(await price(prod)));
    check("the rise is logged in the price history", await changes(prod) === 1);
    await sell(prod, 900);
    check("a lower sale never lowers the price", await price(prod) === 1200);
    await sell(prod, 1200);
    check("a sale at the same price changes nothing", await changes(prod) === 1);

    // B: sold 600 twice and 800 once -> most common is 600 (> 500).
    await db.query("alter table sales disable trigger trg_sales_raise_prices");
    await sell(prodB, 600); await sell(prodB, 600); await sell(prodB, 800);
    await db.query("alter table sales enable trigger trg_sales_raise_prices");
    check("with the trigger off the price stays", await price(prodB) === 500);
    const revised = n(await one(db, "select revise_prices_from_recent_sales($1, 30)", [co]));
    check("revision raises prices", revised >= 1, String(revised));
    check("revision uses the most common recent price", await price(prodB) === 600, String(await price(prodB)));
    check("revision leaves a product already above its sales alone", await price(prod) === 1200);
    check("revision is logged", await changes(prodB) === 1);
    check("running the revision again changes nothing for B", n(await one(db, "select revise_prices_from_recent_sales($1, 30)", [co])) === 0 && await price(prodB) === 600);

    const anon = n(await one(db, "select count(*) from information_schema.role_routine_grants where routine_name in ('raise_prices_from_sale','revise_prices_from_recent_sales','trg_sale_raise_prices') and grantee in ('anon','authenticated')"));
    check("price functions are not callable by anon / authenticated", anon === 0, String(anon));
  } finally {
    await db.query("rollback");
    await db.end();
  }
  console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
