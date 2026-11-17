import { createDbClient } from "../db";
const T = process.argv.slice(2);
(async () => {
  const c = createDbClient(); await c.connect();
  for (const n of T) {
    if (n.startsWith("q:")) { const r = await c.query(n.slice(2)); console.log(`\n## ${n}`); r.rows.forEach((x) => console.log("  ", JSON.stringify(x).slice(0, 400))); continue; }
    const { rows } = await c.query(`select column_name c, data_type d, is_nullable nn, column_default df from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [n]);
    console.log(`\n## ${n}: ` + rows.map((r) => `${r.c}:${r.d.replace("timestamp with time zone","tstz").replace("character varying","varchar").replace("USER-DEFINED","enum")}${r.nn==="NO"&&!r.df?"*":""}`).join(", "));
  }
  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
