import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  createRedisUser,
  deleteRedisUser,
  getRedisConnection,
  listRedisResources,
  rotateRedisPassword,
} from "@/lib/redis";

export const dynamic = "force-dynamic";

async function unauthorized() {
  if (await isAuthenticated()) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET() {
  const denied = await unauthorized();
  if (denied) return denied;

  try {
    return NextResponse.json(await listRedisResources());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Redis request failed" },
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
      return NextResponse.json(await createRedisUser(body.username), { status: 201 });
    }

    if (body.action === "rotate-password") {
      return NextResponse.json(await rotateRedisPassword(body.username));
    }

    if (body.action === "get-connection") {
      return NextResponse.json(await getRedisConnection(body.username));
    }

    if (body.action === "delete-user") {
      return NextResponse.json(await deleteRedisUser(body.username));
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Redis request failed" },
      { status: 400 },
    );
  }
}
