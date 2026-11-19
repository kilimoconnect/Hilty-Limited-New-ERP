/**
 * Step 2 of the old-system transfer: recreate every OLD login in the NEW
 * Supabase project with the same user id and the same (bcrypt) password hash,
 * so people sign in with their existing passwords.
 *
 *   npx tsx scripts/transfer/users.ts            (dry run: lists what it would do)
 *   npx tsx scripts/transfer/users.ts --commit
 *   npx tsx scripts/transfer/users.ts --commit --only=someone@hilty.co.tz
 *
 * Logins that already exist in the new project (by email) are left alone; the
 * new Owner account keeps the password set for it. User profiles, roles and
 * branch access are created by the import step, not here.
 */
import { createClient } from "@supabase/supabase-js";
import { connectOld } from "./old-db";

const commit = process.argv.includes("--commit");
// --only=a@x,b@y limits the run to those emails (e.g. to restore one login).
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice(7).split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)) : null;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const existing = new Map<string, string>();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    for (const u of data.users) if (u.email) existing.set(u.email.toLowerCase(), u.id);
    if (data.users.length < 200) break;
  }

  const old = await connectOld();
  const { rows } = await old.query<{
    id: string; email: string; encrypted_password: string | null; phone: string | null;
    email_confirmed_at: string | null; raw_user_meta_data: Record<string, unknown> | null;
  }>(`select id, email, encrypted_password, phone, email_confirmed_at, raw_user_meta_data
        from auth.users where email is not null and deleted_at is null order by email`);
  await old.end();

  let created = 0;
  for (const u of rows) {
    const email = u.email.toLowerCase();
    if (only && !only.has(email)) continue;
    if (existing.has(email)) {
      console.log(`  keep    ${email} (already in new project)`);
      continue;
    }
    if (!u.encrypted_password) {
      console.log(`  SKIP    ${email} (no password in old system)`);
      continue;
    }
    if (!commit) {
      console.log(`  create  ${email} (id ${u.id}, old password kept)`);
      continue;
    }
    const { error } = await admin.auth.admin.createUser({
      id: u.id,
      email,
      password_hash: u.encrypted_password,
      email_confirm: true,
      user_metadata: u.raw_user_meta_data ?? {},
    } as Parameters<typeof admin.auth.admin.createUser>[0]);
    if (error) {
      console.error(`  FAIL    ${email}: ${error.message}`);
      process.exitCode = 1;
    } else {
      created++;
      console.log(`  created ${email}`);
    }
  }
  console.log(commit ? `\n${created} login(s) created.` : "\nDry run - nothing created. Re-run with --commit.");
}

main().catch((e) => {
  console.error("User transfer failed:", e.message);
  process.exit(1);
});
