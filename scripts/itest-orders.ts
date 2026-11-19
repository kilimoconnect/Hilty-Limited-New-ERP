/**
 * Purchase orders (migration 0040): suggested quantities, received
 * quantities from posted purchases, statuses and the 30-day expiry.
 * One transaction, ROLLED BACK. PGlite only.
 */
import { createDbClient } from "./db";
import type { Client } from "pg";

if (!process.env.LETIQ_PGLITE_DIR) {
  console.error("itest-orders runs only against the PGlite test database (npm run test:db).");
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
const key = () => `po-key-${++k}-${Math.random().toString(36).slice(2)}`;
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
    const sup = await one(db, "insert into suppliers(company_id, code, name) values ($1,'PO-SUP','PO Supplier') returning id", [co]);
    const sup2 = await one(db, "insert into suppliers(company_id, code, name) values ($1,'PO-SUP2','Other Supplier') returning id", [co]);
    const prod = await one(db, "insert into products(company_id, sku, name, base_unit_id) values ($1,'PO-A','PO Product A',$2) returning id", [co, unit]);
    const prodB = await one(db, "insert into products(company_id, sku, name, base_unit_id, preferred_supplier_id) values ($1,'PO-B','PO Product B',$2,$3) returning id", [co, unit, sup2]);

    const purchase = async (supplier: string, product: string, qty: number, order: string | null, post = true) => {
      const id = await one(db, "insert into purchases(company_id, branch_id, supplier_id, document_date, created_by, purchase_order_id) values ($1,$2,$3,current_date,$4,$5) returning id", [co, hq, supplier, owner, order]);
      await db.query("insert into purchase_lines(purchase_id, product_id, quantity, unit_cost, tax_rate, is_recoverable, track_inventory, line_no) values ($1,$2,$3,100,0,true,true,1)", [id, product, qty]);
      if (post) await db.query("select post_purchase($1,$2,$3)", [id, owner, key()]);
      return id;
    };
    const sell = async (product: string, qty: number) => {
      const s = await one(db, "insert into sales(company_id, branch_id, document_date, customer_id, created_by, grand_total) values ($1,$2,current_date,$3,$4,$5) returning id", [co, hq, walkin, owner, qty * 200]);
      await db.query("insert into sale_lines(sale_id, product_id, quantity, unit_price, tax_rate, track_inventory, line_no) values ($1,$2,$3,200,0,true,1)", [s, product, qty]);
      await db.query("insert into sale_payments(sale_id, payment_account_id, amount) values ($1,$2,$3)", [s, cash, qty * 200]);
      await db.query("select post_sale($1,$2,$3)", [s, owner, key()]);
    };

    // Stock in (supplier sup is now the "last purchase" supplier), then 60 sold.
    await purchase(sup, prod, 100, null);
    await purchase(sup, prodB, 10, null);
    await sell(prod, 60);

    const sugg = async (product: string) => (await db.query(
      "select * from report_reorder_suggestions($1,$2,12,'sales',14,7,30,null,null,null,$3::uuid[])", [co, hq, [product]])).rows[0];
    let s = await sugg(prod);
    check("suggestion: product with < 1 month history averages over 1 month", n(s.months_used) === 1 && n(s.avg_monthly) === 60, JSON.stringify(s));
    check("suggestion: 6/9/12 month averages are empty without that much history", s.avg_6 === null && s.avg_9 === null && s.avg_12 === null);
    check("suggestion: on hand 40", n(s.on_hand) === 40);
    // daily = 60 / 30.4375; reorder = ceil(daily * 21) = 42; target = daily * 51 = 100.53 -> 101 - 40 = 61
    check("suggestion: reorder level = ceil(daily x (lead + safety))", n(s.reorder_level) === 42, String(s.reorder_level));
    check("suggestion: quantity = ceil(daily x 51 - on hand)", n(s.suggested) === 61, String(s.suggested));
    check("suggestion: supplier from the last posted purchase", s.supplier_id === sup && s.supplier_source === "last_purchase");
    const sb = await sugg(prodB);
    check("suggestion: preferred supplier wins over the last purchase", sb.supplier_id === sup2 && sb.supplier_source === "preferred");
    const bySup = (await db.query("select product_id from report_reorder_suggestions($1,$2,12,'sales',14,7,30,$3::uuid[],null,null,null)", [co, hq, [sup2]])).rows;
    check("suggestion: supplier filter uses the resolved supplier", bySup.length === 1 && bySup[0].product_id === prodB);
    const pb = await one(db, "select avg_monthly from report_reorder_suggestions($1,$2,12,'purchases',14,7,30,null,null,null,$3::uuid[])", [co, hq, [prod]]);
    check("suggestion: 'purchases' basis averages past purchases", n(pb) === 100, String(pb));

    // Order 61, confirmed.
    const num = await one(db, "select next_document_number($1,$2,'purchase_order')", [co, hq]);
    check("order number uses the PO sequence", /^PO\d+$/.test(String(num)), String(num));
    const po = await one(db, "insert into purchase_orders(company_id, branch_id, supplier_id, document_number, status, confirmed_at) values ($1,$2,$3,$4,'confirmed',now()) returning id", [co, hq, sup, num]);
    await db.query("insert into purchase_order_lines(order_id, product_id, quantity, line_no) values ($1,$2,61,1)", [po, prod]);
    s = await sugg(prod);
    check("suggestion: an open order counts as on order and lowers the suggestion", n(s.on_order) === 61 && n(s.suggested) === 0, JSON.stringify(s));

    // A draft purchase does not receive anything; posting does.
    const d1 = await purchase(sup, prod, 40, po, false);
    check("draft purchase: nothing received", n(await one(db, "select qty_received from purchase_order_lines where order_id=$1", [po])) === 0);
    await db.query("select post_purchase($1,$2,$3)", [d1, owner, key()]);
    check("posted purchase: 40 received", n(await one(db, "select qty_received from purchase_order_lines where order_id=$1", [po])) === 40);
    check("status partly received", (await one(db, "select status from purchase_orders where id=$1", [po])) === "partially_received");
    s = await sugg(prod);
    check("suggestion: on order is what is still pending (21)", n(s.on_order) === 21, String(s.on_order));

    const last = await purchase(sup, prod, 21, po);
    check("second delivery completes the order", (await one(db, "select status from purchase_orders where id=$1", [po])) === "received");
    await db.query("select void_purchase($1,$2,'test')", [last, owner]);
    check("voiding a delivery reopens the order", (await one(db, "select status from purchase_orders where id=$1", [po])) === "partially_received"
      && n(await one(db, "select qty_received from purchase_order_lines where order_id=$1", [po])) === 40);

    // 30-day expiry: nothing received -> deleted; partly received -> closed.
    const stale = await one(db, "insert into purchase_orders(company_id, branch_id, supplier_id, document_number, status, expires_at) values ($1,$2,$3,'PO-STALE','confirmed',now() - interval '1 day') returning id", [co, hq, sup]);
    await db.query("insert into purchase_order_lines(order_id, product_id, quantity, line_no) values ($1,$2,5,1)", [stale, prod]);
    const staleDraft = await purchase(sup, prod, 5, stale, false);
    const fresh = await one(db, "insert into purchase_orders(company_id, branch_id, supplier_id, document_number, status) values ($1,$2,$3,'PO-FRESH','confirmed') returning id", [co, hq, sup]);
    await db.query("update purchase_orders set expires_at = now() - interval '1 day' where id=$1", [po]);
    const touched = n(await one(db, "select expire_purchase_orders($1)", [co]));
    check("expiry: two orders touched", touched === 2, String(touched));
    check("expiry: unreceived order deleted", n(await one(db, "select count(*) from purchase_orders where id=$1", [stale])) === 0);
    check("expiry: its draft purchase stays, unlinked", (await one(db, "select coalesce(purchase_order_id::text,'none') from purchases where id=$1", [staleDraft])) === "none");
    check("expiry: partly received order closed", (await one(db, "select status from purchase_orders where id=$1", [po])) === "closed");
    check("expiry: an order within 30 days is kept", (await one(db, "select status from purchase_orders where id=$1", [fresh])) === "confirmed");
    check("closed order no longer counts as on order", n((await sugg(prod)).on_order) === 0);

    const anon = n(await one(db, "select count(*) from information_schema.role_routine_grants where routine_name in ('report_reorder_suggestions','expire_purchase_orders','refresh_purchase_order') and grantee in ('anon','authenticated')"));
    check("order functions are not callable by anon / authenticated", anon === 0, String(anon));
  } finally {
    await db.query("rollback");
    await db.end();
  }
  console.log(`\n${passed} checks passed${process.exitCode ? " (with failures)" : ""}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
