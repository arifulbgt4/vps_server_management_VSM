import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  controlDockerService,
  getDockerLogs,
  listDockerServices,
  setDockerLimits,
} from "@/lib/docker-control";

export const dynamic = "force-dynamic";

async function unauthorized() {
  if (await isAuthenticated()) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET() {
  const denied = await unauthorized();
  if (denied) return denied;

  try {
    return NextResponse.json(await listDockerServices());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Docker services request failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = await unauthorized();
  if (denied) return denied;

  try {
    const body = await request.json();

    if (body.action === "logs") {
      return NextResponse.json(await getDockerLogs(body.name, body.tail));
    }

    if (body.action === "set-limits") {
      return NextResponse.json(
        await setDockerLimits(body.name, body.cpu_percent, body.memory_percent),
      );
    }

    return NextResponse.json(await controlDockerService(body.name, body.action));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Docker action failed" },
      { status: 400 },
    );
  }
}
