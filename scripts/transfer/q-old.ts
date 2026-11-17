import { connectOld } from "./old-db";
(async () => {
  const c = await connectOld();
  for (const q of process.argv.slice(2)) {
    try { const r = await c.query(q); console.log(`\n## ${q.slice(0, 120)}`); r.rows.forEach((x) => console.log("  ", JSON.stringify(x).slice(0, 300))); }
    catch (e) { console.log(`\n## ${q.slice(0, 80)}\n   ERR ${(e as Error).message}`); }
  }
  await c.end();
})();
