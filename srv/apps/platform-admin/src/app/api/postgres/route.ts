import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  createDatabaseForExistingRole,
  createDatabaseWithRole,
  deleteDatabaseAndRole,
  deleteDatabaseOnly,
  getDatabaseConnection,
  listPostgresResources,
  rotateRolePassword,
} from "@/lib/postgres";

export const dynamic = "force-dynamic";

async function unauthorized() {
  if (await isAuthenticated()) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET() {
  const denied = await unauthorized();
  if (denied) return denied;

  try {
    return NextResponse.json(await listPostgresResources());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "PostgreSQL request failed" },
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
        await createDatabaseWithRole(body.database, body.role),
        { status: 201 },
      );
    }

    if (body.action === "create-existing-role") {
      return NextResponse.json(
        await createDatabaseForExistingRole(body.database, body.role),
        { status: 201 },
      );
    }

    if (body.action === "get-connection") {
      return NextResponse.json(await getDatabaseConnection(body.database));
    }

    if (body.action === "rotate-password") {
      return NextResponse.json(
        await rotateRolePassword(body.role, body.database),
      );
    }

    if (body.action === "delete-database") {
      return NextResponse.json(await deleteDatabaseOnly(body.database));
    }

    if (body.action === "delete") {
      return NextResponse.json(
        await deleteDatabaseAndRole(body.database, body.role),
      );
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "PostgreSQL request failed" },
      { status: 400 },
    );
  }
}
