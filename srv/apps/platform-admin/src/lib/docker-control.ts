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

export async function listDockerServices() {
  return agentRequest("/services");
}

export async function controlDockerService(name: unknown, action: unknown) {
  if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{1,127}$/.test(name)) {
    throw new Error("Invalid container name");
  }
  if (action !== "start" && action !== "stop" && action !== "restart") {
    throw new Error("Unsupported Docker action");
  }

  return agentRequest(`/services/${encodeURIComponent(name)}/${action}`, {
    method: "POST",
  });
}
