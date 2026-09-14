"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import styles from "./postgres.module.css";

type DatabaseRow = {
  name: string;
  owner: string;
  size_bytes: string;
};

type RoleRow = {
  name: string;
  can_login: boolean;
  create_db: boolean;
  create_role: boolean;
  superuser: boolean;
};

type Resources = {
  databases: DatabaseRow[];
  roles: RoleRow[];
};

export default function PostgresManager() {
  const [resources, setResources] = useState<Resources>({ databases: [], roles: [] });
  const [database, setDatabase] = useState("");
  const [role, setRole] = useState("");
  const [rotateRole, setRotateRole] = useState("");
  const [deleteDatabase, setDeleteDatabase] = useState("");
  const [deleteRole, setDeleteRole] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [message, setMessage] = useState("Loading PostgreSQL...");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/postgres", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load PostgreSQL");
    setResources(data);
    setMessage("PostgreSQL connected");
  }, []);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  async function action(payload: Record<string, string>) {
    setBusy(true);
    setSecret(null);
    try {
      const response = await fetch("/api/postgres", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Operation failed");

      if (data.password) {
        setSecret(data.password);
        setMessage(`Password generated for ${data.role}. Copy it now; it is not stored by this UI.`);
      } else {
        setMessage("Operation completed");
      }
      await refresh();
      return data;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operation failed");
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function createPair(event: FormEvent) {
    event.preventDefault();
    try {
      await action({ action: "create", database, role });
      setDatabase("");
      setRole("");
    } catch {}
  }

  async function rotate(event: FormEvent) {
    event.preventDefault();
    try {
      await action({ action: "rotate-password", role: rotateRole });
    } catch {}
  }

  async function remove(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm(`Delete database ${deleteDatabase} and role ${deleteRole}?`)) return;
    try {
      await action({ action: "delete", database: deleteDatabase, role: deleteRole });
      setDeleteDatabase("");
      setDeleteRole("");
    } catch {}
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.topbar}>
          <div>
            <a href="/" className={styles.back}>← Platform Admin</a>
            <h1>PostgreSQL</h1>
            <p>Minimal database and role management over the private postgres_net network.</p>
          </div>
          <span className={styles.status}>{message}</span>
        </div>

        {secret && (
          <section className={styles.secret}>
            <strong>Generated password</strong>
            <code>{secret}</code>
            <button onClick={() => navigator.clipboard.writeText(secret)}>Copy</button>
          </section>
        )}

        <section className={styles.actions}>
          <form className={styles.card} onSubmit={createPair}>
            <h2>Create database + user</h2>
            <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="database_name" required />
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="app_user" required />
            <button disabled={busy}>Create & generate password</button>
          </form>

          <form className={styles.card} onSubmit={rotate}>
            <h2>Rotate user password</h2>
            <input value={rotateRole} onChange={(e) => setRotateRole(e.target.value)} placeholder="app_user" required />
            <button disabled={busy}>Generate new password</button>
          </form>

          <form className={styles.card} onSubmit={remove}>
            <h2>Delete database + user</h2>
            <input value={deleteDatabase} onChange={(e) => setDeleteDatabase(e.target.value)} placeholder="database_name" required />
            <input value={deleteRole} onChange={(e) => setDeleteRole(e.target.value)} placeholder="app_user" required />
            <button className={styles.danger} disabled={busy}>Delete permanently</button>
          </form>
        </section>

        <section className={styles.grid}>
          <div className={styles.tableCard}>
            <h2>Databases</h2>
            <div className={styles.tableWrap}>
              <table>
                <thead><tr><th>Name</th><th>Owner</th><th>Size</th></tr></thead>
                <tbody>
                  {resources.databases.map((item) => (
                    <tr key={item.name}>
                      <td><code>{item.name}</code></td>
                      <td>{item.owner}</td>
                      <td>{formatBytes(Number(item.size_bytes))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className={styles.tableCard}>
            <h2>Roles</h2>
            <div className={styles.tableWrap}>
              <table>
                <thead><tr><th>Name</th><th>Login</th><th>Create DB</th><th>Create role</th></tr></thead>
                <tbody>
                  {resources.roles.map((item) => (
                    <tr key={item.name}>
                      <td><code>{item.name}</code></td>
                      <td>{item.can_login ? "Yes" : "No"}</td>
                      <td>{item.create_db ? "Yes" : "No"}</td>
                      <td>{item.create_role ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
