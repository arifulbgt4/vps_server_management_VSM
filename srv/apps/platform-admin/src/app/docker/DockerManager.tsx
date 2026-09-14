"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./docker.module.css";

type DockerService = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
};

export default function DockerManager() {
  const [services, setServices] = useState<DockerService[]>([]);
  const [message, setMessage] = useState("Loading Docker services...");
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/docker", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load Docker services");
    setServices(data.services || []);
    setMessage("Docker control agent connected");
  }, []);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  async function control(service: DockerService, action: "start" | "stop" | "restart") {
    if (action === "stop" && !window.confirm(`Stop ${service.name}?`)) return;
    if (action === "restart" && !window.confirm(`Restart ${service.name}?`)) return;

    setBusy(service.name);
    try {
      const response = await fetch("/api/docker", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: service.name, action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Docker action failed");
      setMessage(`${service.name}: ${action} requested`);
      await new Promise((resolve) => setTimeout(resolve, 900));
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Docker action failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.topbar}>
          <div>
            <a className={styles.back} href="/">← Platform Admin</a>
            <h1>Docker Services</h1>
            <p>Start, stop and restart only explicitly allowlisted production containers.</p>
          </div>
          <div className={styles.actions}>
            <span className={styles.status}>{message}</span>
            <button type="button" onClick={() => refresh().catch((error) => setMessage(error.message))}>
              Refresh
            </button>
          </div>
        </header>

        <section className={styles.panel}>
          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>Service</th>
                  <th>Image</th>
                  <th>State</th>
                  <th>Status</th>
                  <th>Controls</th>
                </tr>
              </thead>
              <tbody>
                {services.map((service) => (
                  <tr key={service.id}>
                    <td><code>{service.name}</code></td>
                    <td><code>{service.image}</code></td>
                    <td><span className={service.state === "running" ? styles.online : styles.offline}>{service.state}</span></td>
                    <td>{service.status}</td>
                    <td className={styles.controls}>
                      <button
                        type="button"
                        disabled={busy === service.name || service.state === "running"}
                        onClick={() => control(service, "start")}
                      >
                        Start
                      </button>
                      <button
                        type="button"
                        disabled={busy === service.name || service.state !== "running"}
                        onClick={() => control(service, "restart")}
                      >
                        Restart
                      </button>
                      <button
                        type="button"
                        className={styles.danger}
                        disabled={busy === service.name || service.state !== "running"}
                        onClick={() => control(service, "stop")}
                      >
                        Stop
                      </button>
                    </td>
                  </tr>
                ))}
                {services.length === 0 && (
                  <tr>
                    <td colSpan={5} className={styles.empty}>No allowlisted containers were found.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <p className={styles.note}>
          The web app does not mount the Docker socket. A separate private control agent owns the socket and enforces an exact container allowlist.
        </p>
      </section>
    </main>
  );
}
