import { NextResponse } from "next/server";
import {
  createSessionToken,
  secureCookieEnabled,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  verifyAdminCredentials,
} from "@/lib/auth";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const valid = verifyAdminCredentials(body.username, body.password);

    if (!valid) {
      return NextResponse.json(
        { error: "Invalid username or password" },
        { status: 401 },
      );
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE_NAME, createSessionToken(), {
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookieEnabled(),
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });

    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Login failed" },
      { status: 400 },
    );
  }
}
