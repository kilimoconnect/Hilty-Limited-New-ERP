import { connectOld } from "./old-db";
const T = process.argv.slice(2);
(async () => {
  const c = await connectOld();
  for (const t of T) {
    const [s, n] = t.split(".");
    const { rows } = await c.query(`select column_name c, data_type d from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position`, [s, n]);
    console.log(`\n## ${t}: ` + rows.map((r) => `${r.c}:${r.d.replace("timestamp with time zone","tstz").replace("character varying","varchar")}`).join(", "));
    const s1 = await c.query(`select * from ${s}.${n} limit 2`);
    for (const r of s1.rows) console.log("  e.g.", JSON.stringify(r).slice(0, 600));
  }
  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
