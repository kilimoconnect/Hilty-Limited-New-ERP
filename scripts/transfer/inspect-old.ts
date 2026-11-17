import { connectOld } from "./old-db";
(async () => {
  const c = await connectOld();
  const { rows } = await c.query(`
    select t.table_schema s, t.table_name n,
      (xpath('/row/c/text()', query_to_xml(format('select count(*) c from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text::int as rows
    from information_schema.tables t
    where t.table_type='BASE TABLE' and t.table_schema in ('public','auth')
    order by 1,2`);
  for (const r of rows) console.log(`${r.s}.${r.n}\t${r.rows}`);
  const mig = await c.query(`select to_regclass('public.schema_migrations') is not null as has`);
  if (mig.rows[0].has) {
    const m = await c.query(`select name from public.schema_migrations order by 1`);
    console.log("migrations:", m.rows.map((r) => r.name).join(", "));
  }
  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
