import { createDbClient } from "../db";
import { connectOld } from "./old-db";
(async () => {
  const old = await connectOld(); const db = createDbClient(); await db.connect();
  const o = await old.query("select email, md5(encrypted_password) h from auth.users order by email");
  const n = await db.query("select email, md5(encrypted_password) h from auth.users order by email");
  const nm = new Map(n.rows.map((r) => [r.email, r.h]));
  for (const r of o.rows) console.log(`  ${r.email.padEnd(22)} password ${nm.get(r.email) === r.h ? "same as old" : r.email === "info@hilty.co.tz" ? "new (set for Owner)" : "DIFFERENT"}`);
  const c = await old.query("select (select count(*) from fin.sales) s, (select count(*) from fin.purchases) p, (select count(*) from ops.petty_cash) e, (select count(*) from ops.cash_transfers) ct, (select count(*) from auth.users) u");
  console.log("old DB counts (unchanged):", c.rows[0]);
  const v = await db.query(`
    select p.sku, left(p.name,30) name, b.code, o.weighted_avg_cost old_avg, n.avg_unit_cost new_avg,
           (select round(avg(l.unit_cost),2) from legacy.fin_purchase_lines l join legacy.fin_purchases h on h.id=l.purchase_id where l.product_id=p.id and l.vat_mode='INCL') last_cost_incl_vat
      from public.stock_balances n join legacy.public_stock o on o.product_id=n.product_id and o.branch_id=n.branch_id
      join public.products p on p.id=n.product_id join public.branches b on b.id=n.branch_id
     where n.quantity>0 order by abs(o.weighted_avg_cost-n.avg_unit_cost)*n.quantity desc limit 6`);
  console.table(v.rows);
  await old.end(); await db.end();
})();
