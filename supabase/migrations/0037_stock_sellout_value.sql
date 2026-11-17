-- =============================================================================
-- Hilty ERP - Migration 0037: a sell-out takes the exact remaining stock value.
--
-- record_stock_movement (0006) valued every stock-out at round(qty * average
-- cost). When the issue emptied the item at that branch it then set the
-- balance value to zero, so the rounding residue (a few cents) vanished from
-- the stock subledger while GL 1150 still held it: the inventory valuation and
-- the Inventory account drifted apart by those cents on each sell-out.
--
-- A stock-out that empties the balance now takes exactly the value left, as
-- _stock_out_avg (0029) already does; the posting functions use the returned
-- value for cost of sales and the 1150 credit, so stock and GL stay equal.
--
-- Additive: no posted row is changed. Residue from sell-outs posted before
-- this migration is corrected with a dated control-adjustment journal
-- (Dr 5100 Cost of goods sold / Cr 1150 Inventory).
-- =============================================================================

create or replace function public.record_stock_movement(
  p_company uuid, p_branch uuid, p_product uuid,
  p_movement_type text, p_source_type text, p_source_id uuid, p_source_number text,
  p_qty_in numeric, p_qty_out numeric, p_in_unit_cost numeric, p_user uuid
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  bal public.stock_balances;
  new_qty numeric(18,4);
  new_value numeric(18,2);
  new_avg numeric(18,4);
  move_cost numeric(18,4);
  move_value numeric(18,2);
begin
  select * into bal from public.stock_balances
    where company_id = p_company and branch_id = p_branch and product_id = p_product
    for update;
  if not found then
    insert into public.stock_balances(company_id, branch_id, product_id)
      values (p_company, p_branch, p_product)
      returning * into bal;
  end if;

  if coalesce(p_qty_in,0) > 0 then
    move_cost := coalesce(p_in_unit_cost, 0);
    move_value := round(p_qty_in * move_cost, 2);
    new_qty := bal.quantity + p_qty_in;
    new_value := bal.stock_value + move_value;
    if new_qty > 0 then new_avg := round(new_value / new_qty, 4); else new_avg := bal.avg_unit_cost; end if;
  elsif coalesce(p_qty_out,0) > 0 then
    if bal.quantity - p_qty_out < 0 then
      raise exception 'Insufficient stock (available %, requested %)', bal.quantity, p_qty_out
        using errcode = 'P0001';
    end if;
    move_cost := bal.avg_unit_cost;
    new_qty := bal.quantity - p_qty_out;
    if new_qty = 0 then
      -- Emptying the balance: take exactly what is left, rounding residue included.
      move_value := bal.stock_value;
      new_value := 0;
    else
      move_value := round(p_qty_out * move_cost, 2);
      new_value := bal.stock_value - move_value;
    end if;
    new_avg := bal.avg_unit_cost;
  else
    return 0;
  end if;

  insert into public.stock_movements(
    company_id, branch_id, product_id, movement_type, source_type, source_id, source_number,
    qty_in, qty_out, unit_cost, movement_value, balance_qty, avg_cost_after, balance_value, created_by)
  values (
    p_company, p_branch, p_product, p_movement_type, p_source_type, p_source_id, p_source_number,
    coalesce(p_qty_in,0), coalesce(p_qty_out,0), move_cost, move_value, new_qty, new_avg, new_value, p_user);

  update public.stock_balances
    set quantity = new_qty, avg_unit_cost = new_avg, stock_value = new_value,
        last_movement_at = now(), updated_at = now()
    where id = bal.id;

  return move_value;
end; $$;
