import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  createMongoDatabaseWithUser,
  deleteMongoDatabase,
  deleteMongoDatabaseAndUser,
  getMongoConnection,
  listMongoResources,
  rotateMongoPassword,
} from "@/lib/mongodb";

export const dynamic = "force-dynamic";

async function unauthorized() {
  if (await isAuthenticated()) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET() {
  const denied = await unauthorized();
  if (denied) return denied;

  try {
    return NextResponse.json(await listMongoResources());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MongoDB request failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;

  try {
    const body = await request.json();

    if (body.action === "create") {
      return NextResponse.json(
        await createMongoDatabaseWithUser(body.database, body.user),
        { status: 201 },
      );
    }

    if (body.action === "get-connection") {
      return NextResponse.json(await getMongoConnection(body.database, body.user));
    }

    if (body.action === "rotate-password") {
      return NextResponse.json(await rotateMongoPassword(body.database, body.user));
    }

    if (body.action === "delete-database") {
      return NextResponse.json(await deleteMongoDatabase(body.database));
    }

    if (body.action === "delete") {
      return NextResponse.json(await deleteMongoDatabaseAndUser(body.database, body.user));
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MongoDB request failed" },
      { status: 400 },
    );
  }
}
