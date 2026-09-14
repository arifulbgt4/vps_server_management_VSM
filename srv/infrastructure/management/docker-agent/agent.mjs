import http from "node:http";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";

const SOCKET_PATH = "/var/run/docker.sock";
const PORT = Number(process.env.PORT || 8080);
const TOKEN_FILE = process.env.DOCKER_AGENT_TOKEN_FILE || "/run/secrets/control_token";
const LIMITS_FILE = process.env.DOCKER_AGENT_LIMITS_FILE || "/data/resource-limits.json";
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

function dockerRequest(method, path, options = {}) {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined
      ? null
      : Buffer.from(JSON.stringify(options.body));

    const request = http.request(
      {
        socketPath: SOCKET_PATH,
        path,
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": payload.length,
            }
          : undefined,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const raw = buffer.toString("utf8");

          if ((response.statusCode || 500) >= 400) {
            let message = raw || `Docker API returned ${response.statusCode}`;
            try {
              message = JSON.parse(raw).message || message;
            } catch {}
            reject(new Error(message));
            return;
          }

          if (options.raw) {
            resolve({ buffer, headers: response.headers, statusCode: response.statusCode });
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
    if (payload) request.write(payload);
    request.end();
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function loadDesiredLimits() {
  try {
    const parsed = JSON.parse(readFileSync(LIMITS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(`Unable to read ${LIMITS_FILE}:`, error.message);
    }
    return {};
  }
}

let desiredLimits = loadDesiredLimits();

function saveDesiredLimits() {
  const slash = LIMITS_FILE.lastIndexOf("/");
  if (slash > 0) mkdirSync(LIMITS_FILE.slice(0, slash), { recursive: true });
  const temp = `${LIMITS_FILE}.tmp`;
  writeFileSync(temp, `${JSON.stringify(desiredLimits, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, LIMITS_FILE);
}

function assertAllowlisted(name) {
  if (!ALLOWLIST.has(name)) throw new Error("Container is not allowlisted");
  return name;
}

function containerName(container) {
  const names = Array.isArray(container.Names) ? container.Names : [];
  const exact = names.map((name) => name.replace(/^\//, "")).find((name) => ALLOWLIST.has(name));
  return exact || null;
}

function activeMemoryUsage(stats) {
  if (!stats?.memory_stats) return 0;
  const raw = Number(stats.memory_stats.usage || 0);
  const memoryStats = stats.memory_stats.stats || {};
  const cache = Number(memoryStats.inactive_file || memoryStats.total_inactive_file || 0);
  return Math.max(0, raw - cache);
}

function cpuUsagePercent(stats, hostCpuCount) {
  if (!stats?.cpu_stats || !stats?.precpu_stats) return 0;
  const cpuNow = Number(stats.cpu_stats.cpu_usage?.total_usage || 0);
  const cpuPrev = Number(stats.precpu_stats.cpu_usage?.total_usage || 0);
  const systemNow = Number(stats.cpu_stats.system_cpu_usage || 0);
  const systemPrev = Number(stats.precpu_stats.system_cpu_usage || 0);
  const cpuDelta = cpuNow - cpuPrev;
  const systemDelta = systemNow - systemPrev;
  const online = Number(
    stats.cpu_stats.online_cpus
      || stats.cpu_stats.cpu_usage?.percpu_usage?.length
      || hostCpuCount
      || 1,
  );

  if (cpuDelta <= 0 || systemDelta <= 0 || online <= 0) return 0;
  const dockerStylePercent = (cpuDelta / systemDelta) * online * 100;
  return dockerStylePercent / Math.max(1, hostCpuCount);
}

function decodeDockerLogs(buffer, tty) {
  if (tty) return buffer.toString("utf8");

  const parts = [];
  let offset = 0;
  let validFrames = 0;

  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (size < 0 || end > buffer.length) break;
    parts.push(buffer.subarray(start, end).toString("utf8"));
    validFrames += 1;
    offset = end;
  }

  return validFrames > 0 && offset === buffer.length
    ? parts.join("")
    : buffer.toString("utf8").replace(/\u0000/g, "");
}

function networkSummary(inspect) {
  return Object.entries(inspect.NetworkSettings?.Networks || {}).map(([network, value]) => ({
    network,
    ip: value?.IPAddress || value?.GlobalIPv6Address || "",
  }));
}

function portSummary(inspect) {
  return Object.entries(inspect.NetworkSettings?.Ports || {}).map(([containerPort, bindings]) => ({
    container_port: containerPort,
    published: Array.isArray(bindings)
      ? bindings.map((binding) => ({
          host_ip: binding.HostIp || "0.0.0.0",
          host_port: binding.HostPort || "",
        }))
      : [],
  }));
}

function currentLimits(inspect, info) {
  const hostCpus = Math.max(1, Number(info.NCPU || 1));
  const hostMemory = Number(info.MemTotal || 0);
  const nanoCpus = Number(inspect.HostConfig?.NanoCpus || 0);
  const memory = Number(inspect.HostConfig?.Memory || 0);

  return {
    cpu_percent: nanoCpus > 0 ? (nanoCpus / (hostCpus * 1e9)) * 100 : null,
    cpu_cores: nanoCpus > 0 ? nanoCpus / 1e9 : null,
    memory_percent: memory > 0 && hostMemory > 0 ? (memory / hostMemory) * 100 : null,
    memory_bytes: memory > 0 ? memory : null,
  };
}

async function serviceDetails(container, info) {
  const name = containerName(container);
  if (!name) return null;

  const encoded = encodeURIComponent(name);
  const inspect = await dockerRequest("GET", `/containers/${encoded}/json`);
  let stats = null;

  if (inspect.State?.Running) {
    try {
      stats = await dockerRequest("GET", `/containers/${encoded}/stats?stream=false&one-shot=true`);
    } catch (error) {
      console.error(`Stats unavailable for ${name}:`, error.message);
    }
  }

  const hostCpus = Math.max(1, Number(info.NCPU || 1));
  const hostMemory = Number(info.MemTotal || 0);
  const memoryUsage = activeMemoryUsage(stats);
  const startedAt = Date.parse(inspect.State?.StartedAt || "");

  return {
    id: container.Id,
    name,
    image: container.Image,
    state: container.State,
    status: container.Status,
    created: container.Created,
    health: inspect.State?.Health?.Status || null,
    restart_count: Number(inspect.RestartCount || 0),
    uptime_seconds: inspect.State?.Running && Number.isFinite(startedAt)
      ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      : 0,
    networks: networkSummary(inspect),
    ports: portSummary(inspect),
    usage: {
      cpu_percent: cpuUsagePercent(stats, hostCpus),
      memory_bytes: memoryUsage,
      memory_percent: hostMemory > 0 ? (memoryUsage / hostMemory) * 100 : 0,
      pids: Number(stats?.pids_stats?.current || 0),
    },
    limits: currentLimits(inspect, info),
    managed_limits: desiredLimits[name] || null,
  };
}

async function listServices() {
  const [containers, info] = await Promise.all([
    dockerRequest("GET", "/containers/json?all=1"),
    dockerRequest("GET", "/info"),
  ]);

  const allowlisted = (containers || []).filter((container) => containerName(container));
  const services = (await Promise.all(allowlisted.map((container) => serviceDetails(container, info))))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    host: {
      cpus: Number(info.NCPU || 0),
      memory_bytes: Number(info.MemTotal || 0),
    },
    services,
  };
}

async function controlService(name, action) {
  assertAllowlisted(name);
  if (!new Set(["start", "stop", "restart"]).has(action)) throw new Error("Unsupported action");

  const query = action === "stop" || action === "restart" ? "?t=20" : "";
  await dockerRequest("POST", `/containers/${encodeURIComponent(name)}/${action}${query}`);
  return { name, action, ok: true };
}

function parseLimitPercent(value, label, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min}% and ${max}%, or left empty for unlimited`);
  }
  return Math.round(number * 100) / 100;
}

async function updateResourceLimits(name, input) {
  assertAllowlisted(name);
  const cpuPercent = parseLimitPercent(input.cpu_percent, "CPU limit", 1, 100);
  const memoryPercent = parseLimitPercent(input.memory_percent, "RAM limit", 0.5, 95);
  const info = await dockerRequest("GET", "/info");
  const inspect = await dockerRequest("GET", `/containers/${encodeURIComponent(name)}/json`);
  const hostCpus = Math.max(1, Number(info.NCPU || 1));
  const hostMemory = Number(info.MemTotal || 0);

  if (hostMemory <= 0) throw new Error("Docker host memory information is unavailable");

  const nanoCpus = cpuPercent === null
    ? 0
    : Math.max(10_000_000, Math.round(hostCpus * 1e9 * (cpuPercent / 100)));
  const memoryBytes = memoryPercent === null
    ? 0
    : Math.max(32 * 1024 * 1024, Math.floor(hostMemory * (memoryPercent / 100)));

  if (memoryBytes > 0 && inspect.State?.Running) {
    const stats = await dockerRequest("GET", `/containers/${encodeURIComponent(name)}/stats?stream=false&one-shot=true`);
    const usage = activeMemoryUsage(stats);
    if (usage > memoryBytes) {
      const usageMb = (usage / 1024 / 1024).toFixed(1);
      const limitMb = (memoryBytes / 1024 / 1024).toFixed(1);
      throw new Error(`RAM limit ${limitMb} MiB is below current usage ${usageMb} MiB`);
    }
  }

  await dockerRequest("POST", `/containers/${encodeURIComponent(name)}/update`, {
    body: {
      NanoCpus: nanoCpus,
      Memory: memoryBytes,
    },
  });

  if (cpuPercent === null && memoryPercent === null) {
    delete desiredLimits[name];
  } else {
    desiredLimits[name] = {
      cpu_percent: cpuPercent,
      memory_percent: memoryPercent,
    };
  }
  saveDesiredLimits();

  return {
    name,
    ok: true,
    cpu_percent: cpuPercent,
    memory_percent: memoryPercent,
    cpu_cores: nanoCpus > 0 ? nanoCpus / 1e9 : null,
    memory_bytes: memoryBytes > 0 ? memoryBytes : null,
  };
}

async function recentLogs(name, tailInput) {
  assertAllowlisted(name);
  const tail = Math.min(500, Math.max(20, Number(tailInput || 120) || 120));
  const encoded = encodeURIComponent(name);
  const inspect = await dockerRequest("GET", `/containers/${encoded}/json`);
  const result = await dockerRequest(
    "GET",
    `/containers/${encoded}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`,
    { raw: true },
  );

  return {
    name,
    tail,
    logs: decodeDockerLogs(result.buffer, Boolean(inspect.Config?.Tty)),
  };
}

async function reconcileLimits() {
  const entries = Object.entries(desiredLimits).filter(([name]) => ALLOWLIST.has(name));
  if (!entries.length) return;

  const info = await dockerRequest("GET", "/info");
  const hostCpus = Math.max(1, Number(info.NCPU || 1));
  const hostMemory = Number(info.MemTotal || 0);
  if (hostMemory <= 0) return;

  for (const [name, limit] of entries) {
    try {
      const inspect = await dockerRequest("GET", `/containers/${encodeURIComponent(name)}/json`);
      const desiredNano = limit.cpu_percent === null
        ? 0
        : Math.max(10_000_000, Math.round(hostCpus * 1e9 * (Number(limit.cpu_percent) / 100)));
      const desiredMemory = limit.memory_percent === null
        ? 0
        : Math.max(32 * 1024 * 1024, Math.floor(hostMemory * (Number(limit.memory_percent) / 100)));
      const currentNano = Number(inspect.HostConfig?.NanoCpus || 0);
      const currentMemory = Number(inspect.HostConfig?.Memory || 0);

      if (currentNano !== desiredNano || currentMemory !== desiredMemory) {
        await dockerRequest("POST", `/containers/${encodeURIComponent(name)}/update`, {
          body: { NanoCpus: desiredNano, Memory: desiredMemory },
        });
        console.log(`Re-applied managed resource limits to ${name}`);
      }
    } catch (error) {
      console.error(`Unable to reconcile limits for ${name}:`, error.message);
    }
  }
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
      json(res, 200, await listServices());
      return;
    }

    const logsMatch = url.pathname.match(/^\/services\/([^/]+)\/logs$/);
    if (req.method === "GET" && logsMatch) {
      json(res, 200, await recentLogs(decodeURIComponent(logsMatch[1]), url.searchParams.get("tail")));
      return;
    }

    const controlMatch = url.pathname.match(/^\/services\/([^/]+)\/(start|stop|restart)$/);
    if (req.method === "POST" && controlMatch) {
      const [, encodedName, action] = controlMatch;
      json(res, 200, await controlService(decodeURIComponent(encodedName), action));
      return;
    }

    const limitsMatch = url.pathname.match(/^\/services\/([^/]+)\/limits$/);
    if (req.method === "POST" && limitsMatch) {
      const body = await readJsonBody(req);
      json(res, 200, await updateResourceLimits(decodeURIComponent(limitsMatch[1]), body));
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
  console.log(`Managed resource limits: ${LIMITS_FILE}`);
});

setTimeout(() => {
  reconcileLimits().catch((error) => console.error("Initial resource-limit reconciliation failed:", error.message));
}, 3000).unref();

setInterval(() => {
  reconcileLimits().catch((error) => console.error("Resource-limit reconciliation failed:", error.message));
}, 30_000).unref();
