import { connectOld } from "./old-db";
(async () => {
  const c = await connectOld();
  const { rows } = await c.query(`
    select t.table_schema s, t.table_name n, t.table_type ty,
      case when t.table_type='BASE TABLE' then (xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text::int end as rows
    from information_schema.tables t
    where t.table_schema not in ('pg_catalog','information_schema','auth','storage','realtime','supabase_functions','extensions','graphql','graphql_public','pgsodium','pgsodium_masks','vault','net','supabase_migrations','cron','_realtime','pgbouncer')
      and not (t.table_schema='public' and t.table_type='BASE TABLE')
    order by 1,2`);
  for (const r of rows) console.log(`${r.s}.${r.n}\t${r.ty}\t${r.rows ?? ""}`);
  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
