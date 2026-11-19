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
