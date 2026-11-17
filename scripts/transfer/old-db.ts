import { config } from "dotenv";
import { Client } from "pg";

config({ path: ".env.local" });

/** Read-only client for the OLD Hilty system. Every session is forced read-only. */
export async function connectOld(): Promise<Client> {
  const url = process.env.OLD_DATABASE_URL;
  if (!url) throw new Error("OLD_DATABASE_URL is not set in .env.local");
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("set session characteristics as transaction read only");
  await c.query("set default_transaction_read_only = on");
  return c;
}
