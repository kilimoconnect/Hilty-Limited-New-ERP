import { assertActiveUser, assertBranchAccess } from "@/lib/auth/guards";
import { userHasPermission } from "@/lib/auth/session";
import { getActiveContext } from "@/lib/context";
import { writeAuditLog } from "@/lib/audit";
import { readPhoto, ReaderError } from "@/lib/photo-sales/reader";

// Reading a photo with the vision model can take 10-40 seconds.
export const maxDuration = 60;

/**
 * POST { branchId, photo, image: "data:image/jpeg;base64,..." } -> what was
 * read from the photo. Reads only; nothing is saved here.
 */
export async function POST(req: Request) {
  let user;
  try { user = await assertActiveUser(); } catch { return Response.json({ error: "Not signed in." }, { status: 401 }); }
  if (!userHasPermission(user, "sales.create")) return Response.json({ error: "You do not have permission to create sales." }, { status: 403 });

  let body: { branchId?: string; photo?: number; image?: string };
  try { body = await req.json(); } catch { return Response.json({ error: "Bad request." }, { status: 400 }); }
  const { branchId, image } = body;
  const photo = Number(body.photo ?? 0);
  if (!branchId || !/^[0-9a-f-]{36}$/i.test(branchId)) return Response.json({ error: "Choose the branch." }, { status: 400 });
  if (!image || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) return Response.json({ error: "Send a JPEG, PNG or WebP photo." }, { status: 400 });
  if (image.length > 6_000_000) return Response.json({ error: "The photo is too large." }, { status: 413 });
  try { assertBranchAccess(user, branchId); } catch { return Response.json({ error: "You do not work in this branch." }, { status: 403 }); }

  try {
    const ctx = await getActiveContext();
    const result = await readPhoto({ image, companyId: ctx.companyId, branchId, photo });
    await writeAuditLog({ userId: user.id, companyId: ctx.companyId, branchId, action: "photo_sales.read", resourceType: "branch", resourceId: branchId });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof ReaderError ? e.message : "The photo could not be read. Try again.";
    if (!(e instanceof ReaderError)) console.error("photo-sales read failed", e);
    return Response.json({ error: msg }, { status: 502 });
  }
}
