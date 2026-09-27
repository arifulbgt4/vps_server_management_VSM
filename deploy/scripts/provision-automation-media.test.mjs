import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./provision-automation-media.mjs", import.meta.url));
const accountId = "00000000-0000-4000-8000-000000000001";
const accountName = "n8n-automation-shared";
const hasFlock = spawnSync("flock", ["--version"], { stdio: "ignore" }).status === 0;

async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "vsm-media-init-"));
  const keyFile = join(directory, "media_api_key");
  const adminTokenFile = join(directory, "admin_token");
  writeFileSync(adminTokenFile, "test-admin-token\n", { mode: 0o600 });
  const state = { user: null, key: null, creates: 0, rotations: 0, createDelayMs: 0 };
  const server = createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const admin = req.headers.authorization === "Bearer test-admin-token";
    if (req.url === "/api/v1/storage" && req.method === "GET") {
      return req.headers.authorization === `Bearer ${state.key}` && state.user
        ? send(200, { storage: state.user })
        : send(401, { error: "unauthorized" });
    }
    if (!admin) return send(401, { error: "unauthorized" });
    if (req.url === "/api/v1/admin/users" && req.method === "GET") {
      return send(200, { users: state.user ? [state.user] : [] });
    }
    if (req.url === "/api/v1/admin/users" && req.method === "POST") {
      if (state.createDelayMs) await new Promise((resolve) => setTimeout(resolve, state.createDelayMs));
      state.creates += 1;
      state.user = { id: accountId, name: accountName, is_active: true };
      state.key = "ms_live_create_example";
      return send(201, { user: state.user, api_key: state.key });
    }
    if (req.url === `/api/v1/admin/users/${accountId}/rotate-key` && req.method === "POST") {
      state.rotations += 1;
      state.key = "ms_live_rotate_example";
      return send(200, { user: state.user, api_key: state.key });
    }
    send(404, { error: "not_found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const provision = (extraEnv = {}) => new Promise((resolve, reject) => {
    const child = spawn(
      hasFlock ? "flock" : process.execPath,
      hasFlock ? ["-x", `${keyFile}.lock`, process.execPath, script] : [script],
      {
        env: {
          ...process.env,
          MEDIA_BASE_URL: baseUrl,
          MEDIA_API_KEY_FILE: keyFile,
          MEDIA_ADMIN_TOKEN_FILE: adminTokenFile,
          ...extraEnv,
        },
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
  try {
    await run({ keyFile, state, provision });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
}

test("provisions once, keeps the key private, and validates on rerun", async () => {
  await fixture(async ({ keyFile, state, provision }) => {
    const first = await provision();
    assert.equal(first.code, 0);
    assert.equal(readFileSync(keyFile, "utf8").trim(), state.key);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.equal(first.output.includes(state.key), false);

    const second = await provision();
    assert.equal(second.code, 0);
    assert.equal(state.creates, 1);
    assert.equal(state.rotations, 0);
    assert.equal(second.output.includes(state.key), false);
  });
});

test("existing account requires explicit recovery before rotating its key", async () => {
  await fixture(async ({ keyFile, state, provision }) => {
    state.user = { id: accountId, name: accountName, is_active: true };
    state.key = "ms_live_old_example";
    const guarded = await provision();
    assert.equal(guarded.code, 1);
    assert.equal(state.rotations, 0);
    assert.equal(guarded.output.includes(state.key), false);

    const recovered = await provision({ MEDIA_RECOVER_EXISTING: "1" });
    assert.equal(recovered.code, 0);
    assert.equal(state.rotations, 1);
    assert.equal(readFileSync(keyFile, "utf8").trim(), state.key);
    assert.equal(recovered.output.includes(state.key), false);
  });
});

test("invalid local key stops without creating or rotating an account", async () => {
  await fixture(async ({ keyFile, state, provision }) => {
    writeFileSync(keyFile, "ms_live_invalid_example\n", { mode: 0o600 });
    const result = await provision();
    assert.equal(result.code, 1);
    assert.equal(state.creates, 0);
    assert.equal(state.rotations, 0);
  });
});

test("a stale lock file from an interrupted run does not block provisioning", async () => {
  await fixture(async ({ keyFile, state, provision }) => {
    writeFileSync(`${keyFile}.lock`, "stale legacy lock\n", { mode: 0o600 });
    const result = await provision();
    assert.equal(result.code, 0);
    assert.equal(state.creates, 1);
    assert.equal(state.rotations, 0);
    assert.equal(readFileSync(keyFile, "utf8").trim(), state.key);
    assert.equal(result.output.includes(state.key), false);
  });
});

test("concurrent provisioning creates only one shared account", { skip: !hasFlock }, async () => {
  await fixture(async ({ state, provision }) => {
    state.createDelayMs = 100;
    const results = await Promise.all([provision(), provision()]);
    assert.deepEqual(results.map((result) => result.code), [0, 0]);
    assert.equal(state.creates, 1);
    assert.equal(state.rotations, 0);
    for (const result of results) assert.equal(result.output.includes(state.key), false);
  });
});
