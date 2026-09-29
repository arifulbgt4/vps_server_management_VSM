import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { checkAuthPreflight, checkInvalidCustomerSignin } from "./auth-smoke.mjs";

const origin = "https://app.example.test";

async function withPanel({ allowOrigin = true, signinStatus = 401, signinCode = "INVALID_CREDENTIALS" } = {}, run) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      path: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString(),
    });
    const corsHeaders = allowOrigin ? { "access-control-allow-origin": origin } : {};
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...corsHeaders,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
      });
      response.end();
      return;
    }
    response.writeHead(signinStatus, { ...corsHeaders, "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: signinCode } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("checks panel proxy preflight and synthetic customer sign-in", async () => {
  await withPanel({}, async (panelUrl, requests) => {
    await checkAuthPreflight("customer", panelUrl, origin);
    await checkInvalidCustomerSignin(panelUrl, origin);
    assert.deepEqual(requests.map((request) => request.method), ["OPTIONS", "POST"]);
    assert.deepEqual(requests.map((request) => request.path), ["/api/v1/auth/signin", "/api/v1/auth/signin"]);
    assert.equal(requests[0].headers.origin, origin);
    assert.equal(requests[0].headers["access-control-request-method"], "POST");
    assert.equal(requests[1].headers.origin, origin);
    const payload = JSON.parse(requests[1].body);
    assert.match(payload.email, /^vsm-auth-smoke-[a-f0-9-]+@example\.invalid$/);
    assert.equal(payload.realm, "customer");
  });
});

test("rejects an auth preflight that omits the panel origin", async () => {
  await withPanel({ allowOrigin: false }, async (panelUrl) => {
    await assert.rejects(checkAuthPreflight("customer", panelUrl, origin), /rejected/);
  });
});

test("rejects a 500 auth response that the old homepage smoke missed", async () => {
  await withPanel({ signinStatus: 500, signinCode: "INTERNAL_ERROR" }, async (panelUrl) => {
    await assert.rejects(checkInvalidCustomerSignin(panelUrl, origin), /HTTP 500/);
  });
});
