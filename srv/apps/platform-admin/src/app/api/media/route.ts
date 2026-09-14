import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  createMediaUser,
  deleteMediaFile,
  deleteMediaUser,
  getMediaOverview,
  listMediaFiles,
  listMediaUsers,
  rotateMediaUserKey,
  updateMediaUser,
} from "@/lib/media-control";

export const dynamic = "force-dynamic";

async function unauthorized() {
  if (await isAuthenticated()) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get("user_id");
    if (userId) {
      return NextResponse.json(await listMediaFiles(userId, Number(url.searchParams.get("limit") || 100)));
    }

    const [overview, users] = await Promise.all([getMediaOverview(), listMediaUsers()]);
    return NextResponse.json({ overview, users: users.users || [] });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Media service request failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;

  try {
    const body = await request.json();

    if (body.action === "create-user") {
      return NextResponse.json(await createMediaUser(body.name, body.quota_bytes));
    }
    if (body.action === "update-user") {
      return NextResponse.json(
        await updateMediaUser(body.user_id, {
          ...(Object.prototype.hasOwnProperty.call(body, "name") ? { name: body.name } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, "quota_bytes") ? { quota_bytes: body.quota_bytes } : {}),
          ...(Object.prototype.hasOwnProperty.call(body, "is_active") ? { is_active: body.is_active } : {}),
        }),
      );
    }
    if (body.action === "rotate-key") {
      return NextResponse.json(await rotateMediaUserKey(body.user_id));
    }
    if (body.action === "delete-user") {
      return NextResponse.json(await deleteMediaUser(body.user_id));
    }
    if (body.action === "delete-file") {
      return NextResponse.json(await deleteMediaFile(body.file_id));
    }

    return NextResponse.json({ error: "Unsupported media action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Media action failed" },
      { status: 400 },
    );
  }
}
