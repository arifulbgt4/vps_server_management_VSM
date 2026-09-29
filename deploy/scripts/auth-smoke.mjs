import { randomUUID } from "node:crypto";

const signinPath = "/api/v1/auth/signin";

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function headerIncludes(response, name, value) {
  return (response.headers.get(name) || "")
    .split(",")
    .some((part) => part.trim().toLowerCase() === value.toLowerCase());
}

async function request(panelUrl, options) {
  return fetch(new URL(signinPath, panelUrl), {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
}

export async function checkAuthPreflight(name, panelUrl, origin) {
  const response = await request(panelUrl, {
    method: "OPTIONS",
    headers: {
      origin,
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  });

  requireCondition(response.ok, `${name} auth preflight returned HTTP ${response.status}`);
  requireCondition(response.headers.get("access-control-allow-origin") === origin, `${name} auth preflight rejected ${origin}`);
  requireCondition(response.headers.get("access-control-allow-credentials") === "true", `${name} auth preflight rejected credentials`);
  requireCondition(headerIncludes(response, "access-control-allow-methods", "POST"), `${name} auth preflight rejected POST`);
  requireCondition(headerIncludes(response, "access-control-allow-headers", "content-type"), `${name} auth preflight rejected content-type`);
}

export async function checkInvalidCustomerSignin(panelUrl, origin) {
  const response = await request(panelUrl, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      email: `vsm-auth-smoke-${randomUUID()}@example.invalid`,
      password: "synthetic-invalid-password",
      realm: "customer",
    }),
  });
  const body = await response.json().catch(() => ({}));

  requireCondition(
    response.status === 401 && body?.error?.code === "INVALID_CREDENTIALS",
    `Customer invalid sign-in returned HTTP ${response.status}, code ${body?.error?.code || "none"}`,
  );
  requireCondition(response.headers.get("access-control-allow-origin") === origin, "Customer sign-in response rejected the panel origin");
}
