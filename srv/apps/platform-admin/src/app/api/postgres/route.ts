import { NextResponse } from "next/server";
import {
  createDatabaseWithRole,
  deleteDatabaseAndRole,
  listPostgresResources,
  rotateRolePassword,
} from "@/lib/postgres";

export const dynamic = "force-dynamic";

export async function GET() {
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
  try {
    const body = await request.json();

    if (body.action === "create") {
      return NextResponse.json(
        await createDatabaseWithRole(body.database, body.role),
        { status: 201 },
      );
    }

    if (body.action === "rotate-password") {
      return NextResponse.json(await rotateRolePassword(body.role));
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
