import { createDbClient } from "../db";
import { writeFileSync } from "node:fs";
(async () => {
  const c = createDbClient(); await c.connect();
  const names = process.argv.slice(3);
  const { rows } = await c.query(`select p.proname, pg_get_functiondef(p.oid) d from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname = any($1)`, [names]);
  writeFileSync(process.argv[2], rows.map((r) => `\n-- ===== ${r.proname}\n${r.d}`).join("\n"));
  await c.end();
})();
