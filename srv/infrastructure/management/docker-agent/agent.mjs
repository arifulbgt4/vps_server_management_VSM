import http from "node:http";
import { readFileSync } from "node:fs";

const SOCKET_PATH = "/var/run/docker.sock";
const PORT = Number(process.env.PORT || 8080);
const TOKEN_FILE = process.env.DOCKER_AGENT_TOKEN_FILE || "/run/secrets/control_token";
const TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();
const ALLOWLIST = new Set(
  (process.env.DOCKER_AGENT_ALLOWLIST || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  const header = req.headers.authorization || "";
  return header === `Bearer ${TOKEN}`;
}

function dockerRequest(method, path) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath: SOCKET_PATH, path, method },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if ((response.statusCode || 500) >= 400) {
            let message = raw || `Docker API returned ${response.statusCode}`;
            try {
              message = JSON.parse(raw).message || message;
            } catch {}
            reject(new Error(message));
            return;
          }

          if (!raw) {
            resolve(null);
            return;
          }

          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve(raw);
          }
        });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function containerName(container) {
  const names = Array.isArray(container.Names) ? container.Names : [];
  const exact = names.map((name) => name.replace(/^\//, "")).find((name) => ALLOWLIST.has(name));
  return exact || null;
}

async function listServices() {
  const containers = await dockerRequest("GET", "/containers/json?all=1");
  return (containers || [])
    .map((container) => {
      const name = containerName(container);
      if (!name) return null;
      return {
        id: container.Id,
        name,
        image: container.Image,
        state: container.State,
        status: container.Status,
        created: container.Created,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function controlService(name, action) {
  if (!ALLOWLIST.has(name)) throw new Error("Container is not allowlisted");
  if (!new Set(["start", "stop", "restart"]).has(action)) throw new Error("Unsupported action");

  const query = action === "stop" || action === "restart" ? "?t=20" : "";
  await dockerRequest("POST", `/containers/${encodeURIComponent(name)}/${action}${query}`);
  return { name, action, ok: true };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { status: "ok" });
      return;
    }

    if (!authorized(req)) {
      json(res, 401, { error: "Unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/services") {
      json(res, 200, { services: await listServices() });
      return;
    }

    const match = url.pathname.match(/^\/services\/([^/]+)\/(start|stop|restart)$/);
    if (req.method === "POST" && match) {
      const [, encodedName, action] = match;
      json(res, 200, await controlService(decodeURIComponent(encodedName), action));
      return;
    }

    json(res, 404, { error: "Not found" });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : "Docker agent error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Docker control agent listening on ${PORT}`);
  console.log(`Allowlisted containers: ${[...ALLOWLIST].join(", ") || "none"}`);
});
