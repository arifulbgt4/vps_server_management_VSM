"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import styles from "./postgres.module.css";

type DatabaseRow = {
  name: string;
  owner: string;
  size_bytes: string;
  credential_available: boolean;
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

type Connection = {
  host: string;
  port: number;
  sslmode: string;
  database: string;
  role: string;
  url?: string;
};

type Credential = {
  role: string;
  database?: string;
  password: string;
  connection?: Connection | null;
};

type RevealedConnection = {
  role: string;
  password: string;
  url: string;
};

const RESERVED_ROLES = new Set(["postgres", "platform_controller", "platform_app"]);

export default function PostgresManager() {
  const [resources, setResources] = useState<Resources>({ databases: [], roles: [] });
  const [database, setDatabase] = useState("");
  const [role, setRole] = useState("");
  const [existingDatabase, setExistingDatabase] = useState("");
  const [existingRole, setExistingRole] = useState("");
  const [rotateRole, setRotateRole] = useState("");
  const [rotateDatabase, setRotateDatabase] = useState("");
  const [deleteDatabase, setDeleteDatabase] = useState("");
  const [deleteRole, setDeleteRole] = useState("");
  const [deleteRoleToo, setDeleteRoleToo] = useState(false);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [showCredential, setShowCredential] = useState(false);
  const [revealedConnections, setRevealedConnections] = useState<Record<string, RevealedConnection>>({});
  const [message, setMessage] = useState("Loading PostgreSQL...");
  const [busy, setBusy] = useState(false);

  const assignableRoles = useMemo(
    () =>
      resources.roles.filter(
        (item) => item.can_login && !item.superuser && !RESERVED_ROLES.has(item.name),
      ),
    [resources.roles],
  );

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

  async function request(payload: Record<string, string>) {
    const response = await fetch("/api/postgres", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Operation failed");
    return data;
  }

  async function action(payload: Record<string, string>) {
    setBusy(true);
    try {
      const data = await request(payload);

      if (data.password) {
        setCredential({
          role: data.role,
          database: data.database,
          password: data.password,
          connection: data.connection,
        });
        setShowCredential(false);
        setMessage(
          data.credential_stored === false
            ? `Password changed for ${data.role}, but the encrypted credential vault could not be updated. Copy it now.`
            : `Credential generated for ${data.role} and stored encrypted for future URL reveal.`,
        );
      } else if (payload.action === "create-existing-role") {
        setCredential(null);
        setShowCredential(false);
        setMessage(
          data.credential_available
            ? `Database ${data.database} created for ${data.role}. Its saved credential can be revealed from the database list.`
            : `Database ${data.database} created for ${data.role}. Rotate that user's password once if you want the URL reveal feature.`,
        );
      } else {
        setCredential(null);
        setShowCredential(false);
        setMessage("Operation completed");
      }

      setRevealedConnections({});
      await refresh();
      return data;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Operation failed");
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function toggleConnection(item: DatabaseRow) {
    if (revealedConnections[item.name]) {
      setRevealedConnections((current) => {
        const next = { ...current };
        delete next[item.name];
        return next;
      });
      return;
    }

    setBusy(true);
    try {
      const data = await request({ action: "get-connection", database: item.name });
      if (!data.connection?.url) {
        throw new Error("Remote PostgreSQL host is not configured");
      }
      setRevealedConnections((current) => ({
        ...current,
        [item.name]: {
          role: data.role,
          password: data.password,
          url: data.connection.url,
        },
      }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to reveal connection URL");
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

  async function createForExistingRole(event: FormEvent) {
    event.preventDefault();
    try {
      await action({ action: "create-existing-role", database: existingDatabase, role: existingRole });
      setExistingDatabase("");
    } catch {}
  }

  async function rotate(event: FormEvent) {
    event.preventDefault();
    try {
      await action({ action: "rotate-password", role: rotateRole, database: rotateDatabase });
    } catch {}
  }

  async function remove(event: FormEvent) {
    event.preventDefault();
    const target = deleteRoleToo
      ? `database ${deleteDatabase} and role ${deleteRole}`
      : `database ${deleteDatabase}`;

    if (!window.confirm(`Delete ${target}?`)) return;

    try {
      if (deleteRoleToo) {
        await action({ action: "delete", database: deleteDatabase, role: deleteRole });
      } else {
        await action({ action: "delete-database", database: deleteDatabase });
      }
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
            <p>Database, user, credential and remote connection management.</p>
          </div>
          <span className={styles.status}>{message}</span>
        </div>

        {credential && (
          <section className={styles.secret}>
            <div className={styles.secretHeader}>
              <div>
                <strong>Database credential</strong>
                <p>Hidden by default. The password is encrypted at rest in the Platform Admin credential vault.</p>
              </div>
              <button type="button" onClick={() => setShowCredential((value) => !value)}>
                {showCredential ? "Hide" : "Show URL & password"}
              </button>
            </div>

            {showCredential && (
              <div className={styles.secretBody}>
                <div className={styles.secretRow}>
                  <span>Password</span>
                  <code>{credential.password}</code>
                  <button type="button" onClick={() => navigator.clipboard.writeText(credential.password)}>Copy password</button>
                </div>
                {credential.connection?.url ? (
                  <div className={styles.secretRow}>
                    <span>Remote PostgreSQL URL</span>
                    <code>{credential.connection.url}</code>
                    <button type="button" onClick={() => navigator.clipboard.writeText(credential.connection?.url || "")}>Copy URL</button>
                  </div>
                ) : (
                  <p className={styles.warning}>Remote PostgreSQL host is not configured.</p>
                )}
              </div>
            )}
          </section>
        )}

        <section className={styles.actions}>
          <form className={styles.card} onSubmit={createPair}>
            <h2>Create DB + new user</h2>
            <p>Creates a dedicated login role, generates a password, and makes it the database owner.</p>
            <input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="database_name" required />
            <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="app_user" required />
            <button disabled={busy}>Create & generate password</button>
          </form>

          <form className={styles.card} onSubmit={createForExistingRole}>
            <h2>Create DB using existing user</h2>
            <p>If the user's credential is already in the encrypted vault, the new database URL can be revealed immediately.</p>
            <input value={existingDatabase} onChange={(e) => setExistingDatabase(e.target.value)} placeholder="database_name" required />
            <select value={existingRole} onChange={(e) => setExistingRole(e.target.value)} required>
              <option value="">Select existing user</option>
              {assignableRoles.map((item) => (
                <option key={item.name} value={item.name}>{item.name}</option>
              ))}
            </select>
            <button disabled={busy || assignableRoles.length === 0}>Create database</button>
          </form>

          <form className={styles.card} onSubmit={rotate}>
            <h2>Rotate user password</h2>
            <p>Generates a new password and stores it encrypted so URLs can be revealed later.</p>
            <input value={rotateDatabase} onChange={(e) => setRotateDatabase(e.target.value)} placeholder="database_name" required />
            <input value={rotateRole} onChange={(e) => setRotateRole(e.target.value)} placeholder="app_user" required />
            <button disabled={busy}>Generate new password</button>
          </form>

          <form className={styles.card} onSubmit={remove}>
            <h2>Delete database</h2>
            <p>By default only the database is deleted, so shared existing users remain safe.</p>
            <input value={deleteDatabase} onChange={(e) => setDeleteDatabase(e.target.value)} placeholder="database_name" required />
            <label className={styles.checkbox}>
              <input type="checkbox" checked={deleteRoleToo} onChange={(e) => setDeleteRoleToo(e.target.checked)} />
              Also delete its PostgreSQL user
            </label>
            {deleteRoleToo && (
              <input value={deleteRole} onChange={(e) => setDeleteRole(e.target.value)} placeholder="app_user" required />
            )}
            <button className={styles.danger} disabled={busy}>Delete permanently</button>
          </form>
        </section>

        <section className={styles.grid}>
          <div className={styles.tableCardWide}>
            <h2>Databases</h2>
            <div className={styles.tableWrap}>
              <table>
                <thead>
                  <tr><th>Name</th><th>Owner</th><th>Size</th><th>Connection</th></tr>
                </thead>
                <tbody>
                  {resources.databases.map((item) => {
                    const revealed = revealedConnections[item.name];
                    return (
                      <tr key={item.name}>
                        <td><code>{item.name}</code></td>
                        <td>{item.owner}</td>
                        <td>{formatBytes(Number(item.size_bytes))}</td>
                        <td className={styles.connectionCell}>
                          {item.credential_available ? (
                            <>
                              <button
                                type="button"
                                className={styles.smallButton}
                                disabled={busy}
                                onClick={() => toggleConnection(item)}
                              >
                                {revealed ? "Hide URL" : "Show URL"}
                              </button>
                              {revealed && (
                                <div className={styles.inlineSecret}>
                                  <code>{revealed.url}</code>
                                  <button type="button" className={styles.smallButton} onClick={() => navigator.clipboard.writeText(revealed.url)}>Copy</button>
                                </div>
                              )}
                            </>
                          ) : (
                            <span className={styles.muted}>
                              {RESERVED_ROLES.has(item.owner) ? "System database" : "Password unavailable — rotate once"}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
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
