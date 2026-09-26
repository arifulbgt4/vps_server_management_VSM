import net from "node:net";
import tls from "node:tls";

const strictExternal = (process.env.SMOKE_EXTERNAL_STRICT || "false") === "true";

function tcp(host, port, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${host}:${port} timeout`));
    }, timeout);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function directTls(host, port, servername, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host,
      port,
      servername,
      rejectUnauthorized: true,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${servername}:${port} TLS timeout`));
    }, timeout);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function http(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  } finally {
    clearTimeout(timer);
  }
}

const internal = [
  ["postgres", 5432],
  ["redis", 6379],
  ["mysql", 3306],
  ["mongodb", 27017],
  ["media-service", 8080],
  ["platform-admin", 3000],
  ["automation-customer-panel", 3000],
  ["automation-super-admin-panel", 3001],
  ["n8n", 5678],
  ["automation-api", 4000],
];

let failed = false;

for (const [host, port] of internal) {
  try {
    await tcp(host, port);
    console.log(`PASS tcp ${host}:${port}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL tcp ${host}:${port}: ${error.message}`);
  }
}

for (const url of [
  "http://platform-admin:3000/api/health",
  "http://automation-customer-panel:3000/",
  "http://automation-super-admin-panel:3001/",
  "http://media-service:8080/healthz",
  "http://n8n:5678/healthz/readiness",
  "http://automation-api:4000/healthz",
  "http://automation-api:4000/readyz",
]) {
  try {
    await http(url);
    console.log(`PASS http ${url}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL http ${url}: ${error.message}`);
  }
}

const tlsChecks = [
  ["redis", 6380, process.env.REDIS_DOMAIN || "redis.openmusk.store"],
  ["mongodb-public", 27017, process.env.MONGO_DOMAIN || "mongo.openmusk.store"],
];

for (const [host, port, servername] of tlsChecks) {
  try {
    await directTls(host, port, servername);
    console.log(`PASS tls ${servername}:${port}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL tls ${servername}:${port}: ${error.message}`);
  }
}

const externalUrls = [
  `https://${process.env.ADMIN_DOMAIN || "admin.openmusk.store"}/api/health`,
  `https://${process.env.CUSTOMER_DOMAIN || "app.openmusk.store"}/`,
  `https://${process.env.SUPER_ADMIN_DOMAIN || "saas-admin.openmusk.store"}/`,
  `https://${process.env.MEDIA_DOMAIN || "media.openmusk.store"}/healthz`,
  `https://${process.env.N8N_DOMAIN || "n8n.openmusk.store"}/healthz/readiness`,
  `https://${process.env.API_DOMAIN || "api.openmusk.store"}/healthz`,
];

for (const url of externalUrls) {
  try {
    await http(url);
    console.log(`PASS external ${url}`);
  } catch (error) {
    const label = strictExternal ? "FAIL" : "WARN";
    console.error(`${label} external ${url}: ${error.message}`);
    if (strictExternal) failed = true;
  }
}

if (failed) process.exit(1);
console.log("VSM smoke test passed.");
