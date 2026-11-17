/** Read-only: explains the difference between the old and new closing stock value. */
import { createDbClient } from "../db";
(async () => {
  const db = createDbClient(); await db.connect();
  const q = async (title: string, sql: string) => { const r = await db.query(sql); console.log(`\n${title}`); console.table(r.rows); };

  await q("1. Closing stock value: old vs new, split by whether the item was purchased after the opening", `
    with o as (select legacy.br(branch_id) b, product_id, quantity_on_hand q, weighted_avg_cost c from legacy.public_stock where quantity_on_hand <> 0),
         n as (select branch_id b, product_id, quantity q, stock_value v from public.stock_balances where quantity <> 0),
         bought as (select distinct legacy.br(h.branch_id) b, l.product_id from legacy.fin_purchase_lines l join legacy.fin_purchases h on h.id = l.purchase_id
                    union select distinct legacy.br(t.to_branch_id), l.product_id from legacy.fin_transfer_lines l join legacy.fin_transfers t on t.id = l.transfer_id)
    select case when bt.product_id is null then 'opening stock only (never bought/received)' else 'bought or received after opening' end as items,
           count(*)::int lines, round(sum(o.q * o.c)) old_value, round(sum(n.v)) new_value, round(sum(o.q * o.c) - sum(n.v)) difference
      from o join n on n.b = o.b and n.product_id = o.product_id
      left join bought bt on bt.b = o.b and bt.product_id = o.product_id
     group by 1 order by 1`);

  await q("2. Opening stock (3 Jan 2026): old opening cost vs product purchase price / later purchase cost", `
    with op as (select k.product_id, legacy.br(k.branch_id) b, k.qty, k.unit_cost from legacy.public_kardex k where k.movement_type = 'OPENING_BALANCE'),
         pu as (select l.product_id, avg(l.unit_cost) incl, avg(case when upper(l.vat_mode)='INCL' then l.unit_cost/1.18 else l.unit_cost end) ex
                  from legacy.fin_purchase_lines l group by 1)
    select count(*)::int opening_lines, round(sum(op.qty*op.unit_cost)) opening_value,
           count(pu.product_id)::int later_bought,
           count(*) filter (where pu.product_id is not null and abs(op.unit_cost - pu.incl) <= abs(op.unit_cost - pu.ex))::int closer_to_price_incl_vat,
           count(*) filter (where pu.product_id is not null and abs(op.unit_cost - pu.incl) >  abs(op.unit_cost - pu.ex))::int closer_to_price_ex_vat
      from op left join pu on pu.product_id = op.product_id`);

  await q("3. How the old system valued purchases (kardex purchase cost vs invoice price)", `
    select count(*)::int purchase_moves,
           count(*) filter (where abs(k.unit_cost - l.unit_cost) < 0.5)::int at_price_incl_vat,
           count(*) filter (where abs(k.unit_cost - round(l.unit_cost/1.18, 2)) < 0.5)::int at_price_ex_vat
      from legacy.public_kardex k join legacy.fin_purchases h on h.doc_no = k.doc_no
      join legacy.fin_purchase_lines l on l.purchase_id = h.id and l.product_id = k.product_id
     where k.movement_type = 'PURCHASE' and upper(l.vat_mode) = 'INCL'`);

  await q("4. Examples: opening-only items (old vs new avg cost)", `
    with bought as (select distinct legacy.br(h.branch_id) b, l.product_id from legacy.fin_purchase_lines l join legacy.fin_purchases h on h.id = l.purchase_id
                    union select distinct legacy.br(t.to_branch_id), l.product_id from legacy.fin_transfer_lines l join legacy.fin_transfers t on t.id = l.transfer_id)
    select br.code, p.sku, left(p.name,28) name, o.quantity_on_hand qty, o.weighted_avg_cost old_avg, n.avg_unit_cost new_avg,
           (select k.unit_cost from legacy.public_kardex k where k.movement_type='OPENING_BALANCE' and k.product_id=o.product_id and k.branch_id=o.branch_id limit 1) opening_cost
      from legacy.public_stock o join public.stock_balances n on n.branch_id = legacy.br(o.branch_id) and n.product_id = o.product_id
      join public.products p on p.id = o.product_id join public.branches br on br.id = n.branch_id
     where o.quantity_on_hand > 0 and not exists (select 1 from bought x where x.b = n.branch_id and x.product_id = o.product_id)
     order by abs(o.weighted_avg_cost - n.avg_unit_cost) * o.quantity_on_hand desc limit 6`);
  await db.end();
})();
