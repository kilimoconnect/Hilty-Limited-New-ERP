"use server";

import { revalidatePath } from "next/cache";
import { assertOwner } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeAuditLog } from "@/lib/audit";
import { OWNER_ROLE } from "@/lib/auth/permissions";

export interface RoleActionResult {
  ok: boolean;
  error?: string;
}

export async function setRolePermissions(
  roleId: string,
  permissionCodes: string[],
): Promise<RoleActionResult> {
  let user;
  try {
    user = await assertOwner();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Not authorized." };
  }

  const admin = createAdminClient();

  const { data: role } = await admin
    .from("roles")
    .select("id, code")
    .eq("id", roleId)
    .maybeSingle();
  if (!role) return { ok: false, error: "Role not found." };
  if (role.code === OWNER_ROLE) {
    return { ok: false, error: "The Owner role is protected and always has full access." };
  }

  const { data: perms } = await admin
    .from("permissions")
    .select("id, code")
    .in("code", permissionCodes.length ? permissionCodes : ["__none__"]);
  const permIds = (perms ?? []).map((p) => p.id);

  // Replace the role's permission set.
  await admin.from("role_permissions").delete().eq("role_id", roleId);
  if (permIds.length) {
    const rows = permIds.map((pid) => ({ role_id: roleId, permission_id: pid }));
    const { error } = await admin.from("role_permissions").insert(rows);
    if (error) return { ok: false, error: error.message };
  }

  await writeAuditLog({
    userId: user.id,
    action: "role.update_permissions",
    resourceType: "role",
    resourceId: roleId,
    newValues: { permissions: permissionCodes },
  });

  revalidatePath("/admin/roles");
  return { ok: true };
}

/** "Sales Supervisor" -> "SALES_SUPERVISOR" (unique among roles). */
async function uniqueRoleCode(admin: ReturnType<typeof createAdminClient>, name: string): Promise<string> {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "ROLE";
  const { data } = await admin.from("roles").select("code").ilike("code", `${base}%`);
  const taken = new Set((data ?? []).map((r) => r.code));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now()}`;
}

function cleanName(name: string) { return name.replace(/\s+/g, " ").trim(); }

/**
 * Adds a role. Its permissions can be copied from an existing role (not the
 * Owner) and are then set on the page. Owner only, like the rest of Admin.
 */
export async function createRole(input: { name: string; description?: string; copyFromRoleId?: string | null }): Promise<RoleActionResult & { id?: string }> {
  let user;
  try { user = await assertOwner(); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Not authorized." }; }
  const name = cleanName(input.name);
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Give the role a name of 2 to 60 characters." };
  const admin = createAdminClient();
  const { data: same } = await admin.from("roles").select("id").ilike("name", name).limit(1);
  if (same?.length) return { ok: false, error: `A role called "${name}" already exists.` };

  let copy: string[] = [];
  if (input.copyFromRoleId) {
    const { data: src } = await admin.from("roles").select("id, code").eq("id", input.copyFromRoleId).maybeSingle();
    if (!src) return { ok: false, error: "The role to copy from was not found." };
    if (src.code === OWNER_ROLE) return { ok: false, error: "Permissions cannot be copied from the Owner role." };
    const { data: rp } = await admin.from("role_permissions").select("permission_id").eq("role_id", src.id);
    copy = (rp ?? []).map((r) => r.permission_id);
  }

  const code = await uniqueRoleCode(admin, name);
  const { data: role, error } = await admin.from("roles").insert({
    code, name, description: cleanName(input.description ?? "") || null,
    is_system: false, is_protected: false, is_active: true, created_by: user.id, updated_by: user.id,
  }).select("id").single();
  if (error || !role) return { ok: false, error: error?.message ?? "Could not create the role." };
  if (copy.length) {
    const { error: e2 } = await admin.from("role_permissions").insert(copy.map((pid) => ({ role_id: role.id, permission_id: pid })));
    if (e2) return { ok: false, error: e2.message };
  }
  await writeAuditLog({
    userId: user.id, action: "role.create", resourceType: "role", resourceId: role.id,
    newValues: { code, name, copied_from: input.copyFromRoleId ?? null, permissions: copy.length },
  });
  revalidatePath("/admin/roles");
  return { ok: true, id: role.id };
}

/** Renames a role and/or changes its description. The Owner role cannot be changed. */
export async function updateRole(roleId: string, input: { name: string; description?: string }): Promise<RoleActionResult> {
  let user;
  try { user = await assertOwner(); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : "Not authorized." }; }
  const name = cleanName(input.name);
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Give the role a name of 2 to 60 characters." };
  const admin = createAdminClient();
  const { data: role } = await admin.from("roles").select("id, code, name, description").eq("id", roleId).maybeSingle();
  if (!role) return { ok: false, error: "Role not found." };
  if (role.code === OWNER_ROLE) return { ok: false, error: "The Owner role is protected." };
  const { data: same } = await admin.from("roles").select("id").ilike("name", name).neq("id", roleId).limit(1);
  if (same?.length) return { ok: false, error: `A role called "${name}" already exists.` };
  const description = cleanName(input.description ?? "") || null;
  // The code stays the same: it is what the system uses to recognise the role.
  const { error } = await admin.from("roles").update({ name, description, updated_by: user.id, updated_at: new Date().toISOString() }).eq("id", roleId);
  if (error) return { ok: false, error: error.message };
  await writeAuditLog({
    userId: user.id, action: "role.rename", resourceType: "role", resourceId: roleId,
    oldValues: { name: role.name, description: role.description }, newValues: { name, description },
  });
  revalidatePath("/admin/roles"); revalidatePath("/admin/users");
  return { ok: true };
}

export interface RoleLimitsInput {
  /** Days back a document may be dated; null = no limit. */
  backdateDays: number | null;
  /** Largest reduction below list price on a sale line (%); null = no limit. */
  maxDiscountPct: number | null;
  /** Largest expense payable from a cash till; null = no limit. */
  pettyCashCap: number | null;
}

export async function setRoleLimits(roleId: string, input: RoleLimitsInput): Promise<RoleActionResult> {
  let user;
  try {
    user = await assertOwner();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Not authorized." };
  }
  const bad = (v: number | null, max?: number) => v !== null && (!Number.isFinite(v) || v < 0 || (max !== undefined && v > max));
  if (bad(input.backdateDays) || (input.backdateDays !== null && !Number.isInteger(input.backdateDays))) {
    return { ok: false, error: "Back-dating days must be a whole number of 0 or more." };
  }
  if (bad(input.maxDiscountPct, 100)) return { ok: false, error: "Maximum discount must be between 0 and 100%." };
  if (bad(input.pettyCashCap)) return { ok: false, error: "Petty-cash cap must be 0 or more." };

  const admin = createAdminClient();
  const { data: role } = await admin.from("roles")
    .select("id, code, backdate_days, max_discount_pct, petty_cash_cap").eq("id", roleId).maybeSingle();
  if (!role) return { ok: false, error: "Role not found." };
  if (role.code === OWNER_ROLE) return { ok: false, error: "The Owner role is never limited." };

  const { error } = await admin.from("roles").update({
    backdate_days: input.backdateDays, max_discount_pct: input.maxDiscountPct, petty_cash_cap: input.pettyCashCap,
  }).eq("id", roleId);
  if (error) return { ok: false, error: error.message };

  await writeAuditLog({
    userId: user.id, action: "role.update_limits", resourceType: "role", resourceId: roleId,
    oldValues: { backdate_days: role.backdate_days, max_discount_pct: role.max_discount_pct, petty_cash_cap: role.petty_cash_cap },
    newValues: { backdate_days: input.backdateDays, max_discount_pct: input.maxDiscountPct, petty_cash_cap: input.pettyCashCap },
  });
  revalidatePath("/admin/roles");
  return { ok: true };
}
