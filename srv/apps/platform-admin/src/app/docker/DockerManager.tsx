"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./docker.module.css";

type NetworkInfo = {
  network: string;
  ip: string;
};

type PortInfo = {
  container_port: string;
  published: Array<{ host_ip: string; host_port: string }>;
};

type DockerService = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  health?: string | null;
  restart_count: number;
  uptime_seconds: number;
  networks: NetworkInfo[];
  ports: PortInfo[];
  usage: {
    cpu_percent: number;
    memory_bytes: number;
    memory_percent: number;
    pids: number;
  };
  limits: {
    cpu_percent: number | null;
    cpu_cores: number | null;
    memory_percent: number | null;
    memory_bytes: number | null;
  };
  managed_limits?: {
    cpu_percent: number | null;
    memory_percent: number | null;
  } | null;
};

type HostInfo = {
  cpus: number;
  cpu_usage_percent: number | null;
  cpu_available_percent: number | null;
  cpu_used_cores: number | null;
  cpu_available_cores: number | null;
  memory_bytes: number;
  memory_used_bytes: number | null;
  memory_available_bytes: number | null;
  memory_usage_percent: number | null;
  disk_total_bytes: number | null;
  disk_used_bytes: number | null;
  disk_available_bytes: number | null;
  disk_usage_percent: number | null;
  disk_path: string;
};

type LimitDraft = {
  cpu: string;
  memory: string;
};

const emptyHost: HostInfo = {
  cpus: 0,
  cpu_usage_percent: null,
  cpu_available_percent: null,
  cpu_used_cores: null,
  cpu_available_cores: null,
  memory_bytes: 0,
  memory_used_bytes: null,
  memory_available_bytes: null,
  memory_usage_percent: null,
  disk_total_bytes: null,
  disk_used_bytes: null,
  disk_available_bytes: null,
  disk_usage_percent: null,
  disk_path: "/srv",
};

function formatBytes(bytes: number | null | undefined) {
  const value = Number(bytes || 0);
  if (value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function formatDuration(seconds: number) {
  if (!seconds || seconds < 1) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${Math.max(1, minutes)}m`;
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "Unlimited";
  if (value < 0.1) return `${value.toFixed(2)}%`;
  return `${value.toFixed(1)}%`;
}

function formatHostPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  if (value < 0.1) return `${value.toFixed(2)}%`;
  return `${value.toFixed(1)}%`;
}

function formatCores(value: number | null | undefined) {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2)} CPU${Math.abs(value - 1) < 0.005 ? "" : "s"}`;
}

function usageBarPercent(usage: number, limit: number | null) {
  if (limit && limit > 0) return Math.min(100, (usage / limit) * 100);
  return Math.min(100, usage);
}

function hostBarPercent(value: number | null | undefined) {
  return Math.min(100, Math.max(0, Number(value || 0)));
}

export default function DockerManager() {
  const [services, setServices] = useState<DockerService[]>([]);
  const [host, setHost] = useState<HostInfo>(emptyHost);
  const [message, setMessage] = useState("Loading Docker services...");
  const [busy, setBusy] = useState<string | null>(null);
  const [limitDrafts, setLimitDrafts] = useState<Record<string, LimitDraft>>({});
  const [openLogs, setOpenLogs] = useState<string | null>(null);
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [loadingLogs, setLoadingLogs] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/docker", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load Docker services");

    const nextServices: DockerService[] = data.services || [];
    setServices(nextServices);
    setHost({ ...emptyHost, ...(data.host || {}) });
    setLimitDrafts((current) => {
      const next = { ...current };
      for (const service of nextServices) {
        if (!next[service.name]) {
          next[service.name] = {
            cpu: service.limits.cpu_percent === null ? "" : String(Number(service.limits.cpu_percent.toFixed(2))),
            memory: service.limits.memory_percent === null ? "" : String(Number(service.limits.memory_percent.toFixed(2))),
          };
        }
      }
      return next;
    });
    setMessage("Docker control agent connected");
  }, []);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
    const timer = window.setInterval(() => {
      if (!busy) refresh().catch((error) => setMessage(error.message));
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [refresh, busy]);

  async function post(payload: Record<string, unknown>) {
    const response = await fetch("/api/docker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Docker action failed");
    return data;
  }

  async function control(service: DockerService, action: "start" | "stop" | "restart") {
    if (action === "stop" && !window.confirm(`Stop ${service.name}?`)) return;
    if (action === "restart" && !window.confirm(`Restart ${service.name}?`)) return;

    setBusy(service.name);
    try {
      await post({ name: service.name, action });
      setMessage(`${service.name}: ${action} requested`);
      await new Promise((resolve) => setTimeout(resolve, 900));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Docker action failed");
    } finally {
      setBusy(null);
    }
  }

  function updateDraft(name: string, field: keyof LimitDraft, value: string) {
    setLimitDrafts((current) => ({
      ...current,
      [name]: {
        ...(current[name] || { cpu: "", memory: "" }),
        [field]: value,
      },
    }));
  }

  async function applyLimits(service: DockerService) {
    const draft = limitDrafts[service.name] || { cpu: "", memory: "" };
    const cpu = draft.cpu.trim() === "" ? null : Number(draft.cpu);
    const memory = draft.memory.trim() === "" ? null : Number(draft.memory);

    if (cpu !== null && !Number.isFinite(cpu)) {
      setMessage("CPU limit must be a number or blank for unlimited");
      return;
    }
    if (memory !== null && !Number.isFinite(memory)) {
      setMessage("RAM limit must be a number or blank for unlimited");
      return;
    }

    setBusy(service.name);
    try {
      const data = await post({
        name: service.name,
        action: "set-limits",
        cpu_percent: cpu,
        memory_percent: memory,
      });
      setLimitDrafts((current) => ({
        ...current,
        [service.name]: {
          cpu: data.cpu_percent === null ? "" : String(data.cpu_percent),
          memory: data.memory_percent === null ? "" : String(data.memory_percent),
        },
      }));
      setMessage(`${service.name}: resource limits updated`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update resource limits");
    } finally {
      setBusy(null);
    }
  }

  async function clearLimits(service: DockerService) {
    if (!window.confirm(`Remove CPU and RAM limits from ${service.name}?`)) return;
    setBusy(service.name);
    try {
      const data = await post({
        name: service.name,
        action: "set-limits",
        cpu_percent: null,
        memory_percent: null,
      });
      setLimitDrafts((current) => ({
        ...current,
        [service.name]: {
          cpu: data.cpu_percent === null ? "" : String(data.cpu_percent),
          memory: data.memory_percent === null ? "" : String(data.memory_percent),
        },
      }));
      setMessage(`${service.name}: resource limits removed`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to clear resource limits");
    } finally {
      setBusy(null);
    }
  }

  async function fetchLogs(service: DockerService) {
    setLoadingLogs(service.name);
    try {
      const data = await post({ name: service.name, action: "logs", tail: 150 });
      setLogs((current) => ({ ...current, [service.name]: data.logs || "No logs available." }));
    } catch (error) {
      const text = error instanceof Error ? error.message : "Unable to load logs";
      setLogs((current) => ({ ...current, [service.name]: text }));
      setMessage(text);
    } finally {
      setLoadingLogs(null);
    }
  }

  async function toggleLogs(service: DockerService) {
    if (openLogs === service.name) {
      setOpenLogs(null);
      return;
    }
    setOpenLogs(service.name);
    await fetchLogs(service);
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.topbar}>
          <div>
            <a className={styles.back} href="/">← Platform Admin</a>
            <h1>Docker Services</h1>
            <p>Live host and container metrics, persistent CPU/RAM limits, network details, logs and lifecycle controls.</p>
          </div>
          <div className={styles.actions}>
            <span className={styles.status}>{message}</span>
            <button type="button" disabled={Boolean(busy)} onClick={() => refresh().catch((error) => setMessage(error.message))}>
              Refresh
            </button>
          </div>
        </header>

        <section className={styles.hostResourceGrid}>
          <article className={styles.hostResourceCard}>
            <div className={styles.hostResourceHeader}>
              <span>CPU</span>
              <strong>{host.cpus ? `${host.cpus} CPUs total` : "—"}</strong>
            </div>
            <div className={styles.bar}><span style={{ width: `${hostBarPercent(host.cpu_usage_percent)}%` }} /></div>
            <div className={styles.hostBreakdown}>
              <div>
                <span>Used</span>
                <strong>{formatHostPercent(host.cpu_usage_percent)}</strong>
                <small>{formatCores(host.cpu_used_cores)}</small>
              </div>
              <div>
                <span>Available</span>
                <strong>{formatHostPercent(host.cpu_available_percent)}</strong>
                <small>{formatCores(host.cpu_available_cores)}</small>
              </div>
            </div>
          </article>

          <article className={styles.hostResourceCard}>
            <div className={styles.hostResourceHeader}>
              <span>RAM</span>
              <strong>{host.memory_bytes ? `${formatBytes(host.memory_bytes)} total` : "—"}</strong>
            </div>
            <div className={styles.bar}><span style={{ width: `${hostBarPercent(host.memory_usage_percent)}%` }} /></div>
            <div className={styles.hostBreakdown}>
              <div>
                <span>Used</span>
                <strong>{host.memory_used_bytes === null ? "—" : formatBytes(host.memory_used_bytes)}</strong>
                <small>{formatHostPercent(host.memory_usage_percent)}</small>
              </div>
              <div>
                <span>Available</span>
                <strong>{host.memory_available_bytes === null ? "—" : formatBytes(host.memory_available_bytes)}</strong>
                <small>{host.memory_usage_percent === null ? "—" : formatHostPercent(100 - host.memory_usage_percent)}</small>
              </div>
            </div>
          </article>

          <article className={styles.hostResourceCard}>
            <div className={styles.hostResourceHeader}>
              <span>Disk</span>
              <strong>{host.disk_total_bytes === null ? "—" : `${formatBytes(host.disk_total_bytes)} total`}</strong>
            </div>
            <div className={styles.bar}><span style={{ width: `${hostBarPercent(host.disk_usage_percent)}%` }} /></div>
            <div className={styles.hostBreakdown}>
              <div>
                <span>Used</span>
                <strong>{host.disk_used_bytes === null ? "—" : formatBytes(host.disk_used_bytes)}</strong>
                <small>{formatHostPercent(host.disk_usage_percent)}</small>
              </div>
              <div>
                <span>Available</span>
                <strong>{host.disk_available_bytes === null ? "—" : formatBytes(host.disk_available_bytes)}</strong>
                <small>{host.disk_path || "/srv"} filesystem</small>
              </div>
            </div>
          </article>
        </section>

        <section className={styles.hostSummary}>
          <div><span>Metrics refresh</span><strong>10 sec</strong></div>
          <div><span>Managed services</span><strong>{services.length}</strong></div>
        </section>

        <div className={styles.serviceList}>
          {services.map((service) => {
            const draft = limitDrafts[service.name] || { cpu: "", memory: "" };
            const cpuLimit = service.limits.cpu_percent;
            const memoryLimit = service.limits.memory_percent;
            const cpuBar = usageBarPercent(service.usage.cpu_percent, cpuLimit);
            const memoryBar = usageBarPercent(service.usage.memory_percent, memoryLimit);

            return (
              <article className={styles.serviceCard} key={service.id}>
                <div className={styles.serviceHeader}>
                  <div>
                    <div className={styles.titleLine}>
                      <h2>{service.name}</h2>
                      <span className={service.state === "running" ? styles.online : styles.offline}>{service.state}</span>
                      {service.health && <span className={styles.health}>{service.health}</span>}
                    </div>
                    <code className={styles.image}>{service.image}</code>
                  </div>
                  <div className={styles.controls}>
                    <button type="button" disabled={busy === service.name || service.state === "running"} onClick={() => control(service, "start")}>Start</button>
                    <button type="button" disabled={busy === service.name || service.state !== "running"} onClick={() => control(service, "restart")}>Restart</button>
                    <button type="button" className={styles.danger} disabled={busy === service.name || service.state !== "running"} onClick={() => control(service, "stop")}>Stop</button>
                  </div>
                </div>

                <div className={styles.metricsGrid}>
                  <div className={styles.metricCard}>
                    <div className={styles.metricTop}><span>CPU usage</span><strong>{formatPercent(service.usage.cpu_percent)}</strong></div>
                    <div className={styles.bar}><span style={{ width: `${cpuBar}%` }} /></div>
                    <small>{cpuLimit === null ? "No CPU cap" : `Limit ${formatPercent(cpuLimit)} of host (${service.limits.cpu_cores?.toFixed(2)} CPUs)`}</small>
                  </div>
                  <div className={styles.metricCard}>
                    <div className={styles.metricTop}><span>RAM usage</span><strong>{formatBytes(service.usage.memory_bytes)} · {formatPercent(service.usage.memory_percent)}</strong></div>
                    <div className={styles.bar}><span style={{ width: `${memoryBar}%` }} /></div>
                    <small>{memoryLimit === null ? "No RAM cap" : `Limit ${formatPercent(memoryLimit)} · ${formatBytes(service.limits.memory_bytes)}`}</small>
                  </div>
                  <div className={styles.metricCard}><span>Uptime</span><strong>{formatDuration(service.uptime_seconds)}</strong><small>{service.status}</small></div>
                  <div className={styles.metricCard}><span>Restarts</span><strong>{service.restart_count}</strong><small>{service.usage.pids} PIDs</small></div>
                </div>

                <div className={styles.detailGrid}>
                  <section className={styles.detailPanel}>
                    <h3>Network & ports</h3>
                    <div className={styles.detailRows}>
                      {service.networks.length > 0 ? service.networks.map((network) => (
                        <div key={network.network}><span>{network.network}</span><code>{network.ip || "no IP"}</code></div>
                      )) : <p className={styles.muted}>No network information.</p>}
                      {service.ports.length > 0 ? service.ports.map((port) => (
                        <div key={port.container_port}>
                          <span>{port.container_port}</span>
                          <code>{port.published.length ? port.published.map((item) => `${item.host_ip}:${item.host_port}`).join(", ") : "internal only"}</code>
                        </div>
                      )) : <p className={styles.muted}>No exposed ports.</p>}
                    </div>
                  </section>

                  <section className={styles.detailPanel}>
                    <h3>Resource limits</h3>
                    <p className={styles.helper}>Percentages are of the entire VPS. Blank means unlimited. RAM: 0.5–95%; CPU: 1–100%.</p>
                    <div className={styles.limitInputs}>
                      <label>
                        <span>CPU limit %</span>
                        <input type="number" min="1" max="100" step="0.5" value={draft.cpu} placeholder="Unlimited" disabled={busy === service.name} onChange={(event) => updateDraft(service.name, "cpu", event.target.value)} />
                      </label>
                      <label>
                        <span>RAM limit %</span>
                        <input type="number" min="0.5" max="95" step="0.5" value={draft.memory} placeholder="Unlimited" disabled={busy === service.name} onChange={(event) => updateDraft(service.name, "memory", event.target.value)} />
                      </label>
                    </div>
                    <div className={styles.limitActions}>
                      <button type="button" disabled={busy === service.name} onClick={() => applyLimits(service)}>Apply limits</button>
                      <button type="button" className={styles.secondaryButton} disabled={busy === service.name} onClick={() => clearLimits(service)}>Unlimited</button>
                    </div>
                    {service.managed_limits && <small className={styles.persisted}>Persistent policy active; the agent re-applies it after container recreation.</small>}
                  </section>
                </div>

                <div className={styles.logsHeader}>
                  <button type="button" className={styles.logsButton} disabled={loadingLogs === service.name} onClick={() => toggleLogs(service)}>
                    {openLogs === service.name ? "Hide recent logs" : "View recent logs"}
                  </button>
                  {openLogs === service.name && (
                    <button type="button" className={styles.secondaryButton} disabled={loadingLogs === service.name} onClick={() => fetchLogs(service)}>Refresh logs</button>
                  )}
                </div>
                {openLogs === service.name && (
                  <pre className={styles.logs}>{loadingLogs === service.name ? "Loading logs..." : logs[service.name] || "No logs available."}</pre>
                )}
              </article>
            );
          })}

          {services.length === 0 && <div className={styles.empty}>No allowlisted containers were found.</div>}
        </div>

        <p className={styles.note}>
          Host CPU/RAM statistics come from the VPS host, while disk statistics represent the filesystem backing /srv. Container CPU and RAM limits are enforced through Docker cgroups and re-applied after recreation.
        </p>
      </section>
    </main>
  );
}