import { readFileSync } from "node:fs";

const AGENT_URL = process.env.DOCKER_AGENT_URL || "http://docker-agent:8080";

function token() {
  const path = process.env.DOCKER_AGENT_TOKEN_FILE;
  if (!path) throw new Error("DOCKER_AGENT_TOKEN_FILE is not configured");
  return readFileSync(path, "utf8").trim();
}

async function agentRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${AGENT_URL}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.headers || {}),
      authorization: `Bearer ${token()}`,
    },
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Docker agent returned ${response.status}`);
  return data;
}

function assertName(name: unknown) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(name)) {
    throw new Error("Invalid container name");
  }
  return name;
}

export async function listDockerServices() {
  return agentRequest("/services");
}

export async function controlDockerService(nameInput: unknown, action: unknown) {
  const name = assertName(nameInput);
  if (action !== "start" && action !== "stop" && action !== "restart") {
    throw new Error("Unsupported Docker action");
  }

  return agentRequest(`/services/${encodeURIComponent(name)}/${action}`, {
    method: "POST",
  });
}

export async function getDockerLogs(nameInput: unknown, tailInput?: unknown) {
  const name = assertName(nameInput);
  const tail = Math.min(500, Math.max(20, Number(tailInput || 120) || 120));
  return agentRequest(`/services/${encodeURIComponent(name)}/logs?tail=${tail}`);
}

export async function setDockerLimits(
  nameInput: unknown,
  cpuPercent: unknown,
  memoryPercent: unknown,
) {
  const name = assertName(nameInput);

  return agentRequest(`/services/${encodeURIComponent(name)}/limits`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cpu_percent: cpuPercent === "" || cpuPercent === undefined ? null : cpuPercent,
      memory_percent: memoryPercent === "" || memoryPercent === undefined ? null : memoryPercent,
    }),
  });
}
