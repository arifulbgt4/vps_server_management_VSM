import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  createMysqlDatabaseForExistingUser,
  createMysqlDatabaseWithUser,
  deleteMysqlDatabase,
  deleteMysqlDatabaseAndUser,
  getMysqlConnection,
  listMysqlResources,
  rotateMysqlPassword,
} from "@/lib/mysql";

export const dynamic = "force-dynamic";

async function unauthorized() {
  if (await isAuthenticated()) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET() {
  const denied = await unauthorized();
  if (denied) return denied;

  try {
    return NextResponse.json(await listMysqlResources());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MySQL request failed" },
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
        await createMysqlDatabaseWithUser(body.database, body.user),
        { status: 201 },
      );
    }

    if (body.action === "create-existing-user") {
      return NextResponse.json(
        await createMysqlDatabaseForExistingUser(body.database, body.user),
        { status: 201 },
      );
    }

    if (body.action === "get-connection") {
      return NextResponse.json(await getMysqlConnection(body.database, body.user));
    }

    if (body.action === "rotate-password") {
      return NextResponse.json(await rotateMysqlPassword(body.user, body.database));
    }

    if (body.action === "delete-database") {
      return NextResponse.json(await deleteMysqlDatabase(body.database));
    }

    if (body.action === "delete") {
      return NextResponse.json(await deleteMysqlDatabaseAndUser(body.database, body.user));
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MySQL request failed" },
      { status: 400 },
    );
  }
}
