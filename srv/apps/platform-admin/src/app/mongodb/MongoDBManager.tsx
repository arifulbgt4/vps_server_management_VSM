"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import styles from "../postgres/postgres.module.css";

type DatabaseRow = { name: string; size_bytes: string; empty: boolean; users: string[] };
type UserRow = { name: string; database: string; roles: string[]; credential_available: boolean };
type Resources = { status: string; replica_set: string; databases: DatabaseRow[]; users: UserRow[] };
type Connection = { host: string; port: number; database: string; user: string; replica_set: string; url: string };
type Credential = { database: string; user: string; password: string; connection?: Connection | null; public_connection?: Connection | null };
type RevealedConnection = { user: string; password: string; url: string; public_url?: string | null };

export default function MongoDBManager() {
  const [resources, setResources] = useState<Resources>({ status: "unknown", replica_set: "rs0", databases: [], users: [] });
  const [database, setDatabase] = useState("");
  const [user, setUser] = useState("");
  const [rotateDatabase, setRotateDatabase] = useState("");
  const [rotateUser, setRotateUser] = useState("");
  const [deleteDatabase, setDeleteDatabase] = useState("");
  const [deleteUser, setDeleteUser] = useState("");
  const [deleteUserToo, setDeleteUserToo] = useState(true);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [showCredential, setShowCredential] = useState(false);
  const [revealedConnections, setRevealedConnections] = useState<Record<string, RevealedConnection>>({});
  const [message, setMessage] = useState("Loading MongoDB...");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/mongodb", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load MongoDB");
    setResources(data);
    setMessage(`MongoDB connected • ${data.replica_set || "rs0"}`);
  }, []);

  useEffect(() => { refresh().catch((error) => setMessage(error.message)); }, [refresh]);

  async function request(payload: Record<string, string>) {
    const response = await fetch("/api/mongodb", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "MongoDB operation failed");
    return data;
  }

  async function action(payload: Record<string, string>) {
    setBusy(true);
    try {
      const data = await request(payload);
      if (data.password) {
        setCredential({ database: data.database, user: data.user, password: data.password, connection: data.connection, public_connection: data.public_connection });
        setShowCredential(false);
        setMessage(data.credential_stored === false ? `Password changed for ${data.user}@${data.database}, but the encrypted vault update failed. Copy it now.` : `Credential generated for ${data.user}@${data.database} and stored encrypted.`);
      } else {
        setCredential(null);
        setShowCredential(false);
        setMessage("Operation completed");
      }
      setRevealedConnections({});
      await refresh();
      return data;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MongoDB operation failed");
      throw error;
    } finally { setBusy(false); }
  }

  async function createPair(event: FormEvent) { event.preventDefault(); try { await action({ action: "create", database, user }); setDatabase(""); setUser(""); } catch {} }
  async function rotate(event: FormEvent) { event.preventDefault(); try { await action({ action: "rotate-password", database: rotateDatabase, user: rotateUser }); } catch {} }

  async function remove(event: FormEvent) {
    event.preventDefault();
    const target = deleteUserToo ? `database ${deleteDatabase} and user ${deleteUser}` : `database ${deleteDatabase}`;
    if (!window.confirm(`Permanently delete ${target}?`)) return;
    try {
      if (deleteUserToo) await action({ action: "delete", database: deleteDatabase, user: deleteUser });
      else await action({ action: "delete-database", database: deleteDatabase });
      setDeleteDatabase(""); setDeleteUser("");
    } catch {}
  }

  async function toggleConnection(databaseName: string, userName: string) {
    const key = `${databaseName}:${userName}`;
    if (revealedConnections[key]) {
      setRevealedConnections((current) => { const next = { ...current }; delete next[key]; return next; });
      return;
    }
    setBusy(true);
    try {
      const data = await request({ action: "get-connection", database: databaseName, user: userName });
      setRevealedConnections((current) => ({ ...current, [key]: { user: userName, password: data.password, url: data.connection.url, public_url: data.public_connection?.url || null } }));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to reveal MongoDB URL"); }
    finally { setBusy(false); }
  }

  return (
    <main className={styles.page}><div className={styles.shell}>
      <div className={styles.topbar}><div><a href="/" className={styles.back}>← Platform Admin</a><h1>MongoDB</h1><p>Private replica-set management with a public TLS endpoint for application credentials.</p></div><span className={styles.status}>{message}</span></div>

      {credential && <section className={styles.secret}>
        <div className={styles.secretHeader}><div><strong>MongoDB credential</strong><p>Hidden by default. The generated password is encrypted in Platform Admin.</p></div><button type="button" onClick={() => setShowCredential((value) => !value)}>{showCredential ? "Hide" : "Show URL & password"}</button></div>
        {showCredential && <div className={styles.secretBody}>
          <div className={styles.secretRow}><span>Password</span><code>{credential.password}</code><button type="button" onClick={() => navigator.clipboard.writeText(credential.password)}>Copy password</button></div>
          {credential.connection?.url && <div className={styles.secretRow}><span>Private MongoDB URL</span><code>{credential.connection.url}</code><button type="button" onClick={() => navigator.clipboard.writeText(credential.connection?.url || "")}>Copy private</button></div>}
          {credential.public_connection?.url && <div className={styles.secretRow}><span>Public TLS MongoDB URL</span><code>{credential.public_connection.url}</code><button type="button" onClick={() => navigator.clipboard.writeText(credential.public_connection?.url || "")}>Copy public</button></div>}
        </div>}
      </section>}

      <section className={styles.actions}>
        <form className={styles.card} onSubmit={createPair}><h2>Create DB + user</h2><p>Creates a managed database and a user with readWrite only on that database.</p><input value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="database_name" required /><input value={user} onChange={(e) => setUser(e.target.value)} placeholder="app_user" required /><button disabled={busy}>Create & generate password</button></form>
        <form className={styles.card} onSubmit={rotate}><h2>Rotate user password</h2><p>Updates the MongoDB user and replaces its encrypted credential-vault copy.</p><input value={rotateDatabase} onChange={(e) => setRotateDatabase(e.target.value)} placeholder="database_name" required /><input value={rotateUser} onChange={(e) => setRotateUser(e.target.value)} placeholder="app_user" required /><button disabled={busy}>Generate new password</button></form>
        <form className={styles.card} onSubmit={remove}><h2>Delete database</h2><p>For managed databases, deleting the scoped user at the same time is recommended.</p><input value={deleteDatabase} onChange={(e) => setDeleteDatabase(e.target.value)} placeholder="database_name" required /><label className={styles.checkbox}><input type="checkbox" checked={deleteUserToo} onChange={(e) => setDeleteUserToo(e.target.checked)} />Also delete its MongoDB user</label>{deleteUserToo && <input value={deleteUser} onChange={(e) => setDeleteUser(e.target.value)} placeholder="app_user" required />}<button className={styles.danger} disabled={busy}>Delete permanently</button></form>
      </section>

      <section className={styles.grid}>
        <div className={styles.tableCardWide}><h2>Databases</h2><div className={styles.tableWrap}><table><thead><tr><th>Name</th><th>Size</th><th>Users / connections</th></tr></thead><tbody>{resources.databases.map((item) => <tr key={item.name}><td><code>{item.name}</code></td><td>{formatBytes(Number(item.size_bytes))}</td><td className={styles.connectionCell}>{item.users.length === 0 ? <span className={styles.muted}>No managed user</span> : item.users.map((assignedUser) => { const key = `${item.name}:${assignedUser}`; const revealed = revealedConnections[key]; const userInfo = resources.users.find((entry) => entry.database === item.name && entry.name === assignedUser); return <div key={key} className={styles.inlineSecret}><code>{assignedUser}</code>{userInfo?.credential_available ? <button type="button" className={styles.smallButton} disabled={busy} onClick={() => toggleConnection(item.name, assignedUser)}>{revealed ? "Hide URLs" : "Show URLs"}</button> : <span className={styles.muted}>Rotate once to store password</span>}{revealed && <><code>{revealed.url}</code><button type="button" className={styles.smallButton} onClick={() => navigator.clipboard.writeText(revealed.url)}>Copy private</button>{revealed.public_url && <><code>{revealed.public_url}</code><button type="button" className={styles.smallButton} onClick={() => navigator.clipboard.writeText(revealed.public_url || "")}>Copy public</button></>}</>}</div>; })}</td></tr>)}</tbody></table></div></div>
        <div className={styles.tableCard}><h2>Users</h2><div className={styles.tableWrap}><table><thead><tr><th>User</th><th>Auth DB</th><th>Roles</th><th>Credential</th></tr></thead><tbody>{resources.users.map((item) => <tr key={`${item.database}:${item.name}`}><td><code>{item.name}</code></td><td>{item.database}</td><td>{item.roles.join(", ")}</td><td>{item.credential_available ? "Encrypted vault" : "Not stored"}</td></tr>)}</tbody></table></div></div>
      </section>
    </div></main>
  );
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
