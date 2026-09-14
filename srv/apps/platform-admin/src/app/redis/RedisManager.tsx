"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import styles from "./redis.module.css";

type RedisUser = {
  name: string;
  enabled: boolean;
  system: boolean;
  credential_available: boolean;
};

type Resources = {
  status: string;
  users: RedisUser[];
  app_host: string;
  app_port: number;
};

type RevealedConnection = {
  password: string;
  url: string;
};

export default function RedisManager() {
  const [resources, setResources] = useState<Resources>({
    status: "loading",
    users: [],
    app_host: "redis",
    app_port: 6379,
  });
  const [username, setUsername] = useState("");
  const [rotateUser, setRotateUser] = useState("");
  const [deleteUser, setDeleteUser] = useState("");
  const [message, setMessage] = useState("Loading Redis...");
  const [busy, setBusy] = useState(false);
  const [credential, setCredential] = useState<RevealedConnection | null>(null);
  const [credentialUser, setCredentialUser] = useState("");
  const [showCredential, setShowCredential] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, RevealedConnection>>({});

  const refresh = useCallback(async () => {
    const response = await fetch("/api/redis", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Failed to load Redis");
    setResources(data);
    setMessage(`Redis ${data.status}`);
  }, []);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  async function request(payload: Record<string, string>) {
    const response = await fetch("/api/redis", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Redis operation failed");
    return data;
  }

  async function run(payload: Record<string, string>) {
    setBusy(true);
    try {
      const data = await request(payload);
      if (data.password && data.connection?.url) {
        setCredential({ password: data.password, url: data.connection.url });
        setCredentialUser(data.username);
        setShowCredential(false);
        setMessage(
          data.credential_stored === false
            ? `Password changed for ${data.username}, but the encrypted vault could not be updated. Copy it now.`
            : `Credential ready for ${data.username}.`,
        );
      } else {
        setCredential(null);
        setCredentialUser("");
        setShowCredential(false);
        setMessage("Operation completed");
      }
      setRevealed({});
      await refresh();
      return data;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Redis operation failed");
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function createUser(event: FormEvent) {
    event.preventDefault();
    try {
      await run({ action: "create-user", username });
      setUsername("");
    } catch {}
  }

  async function rotate(event: FormEvent) {
    event.preventDefault();
    try {
      await run({ action: "rotate-password", username: rotateUser });
    } catch {}
  }

  async function remove(event: FormEvent) {
    event.preventDefault();
    if (!window.confirm(`Delete Redis user ${deleteUser}?`)) return;
    try {
      await run({ action: "delete-user", username: deleteUser });
      setDeleteUser("");
    } catch {}
  }

  async function toggleConnection(user: RedisUser) {
    if (revealed[user.name]) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[user.name];
        return next;
      });
      return;
    }

    setBusy(true);
    try {
      const data = await request({ action: "get-connection", username: user.name });
      setRevealed((current) => ({
        ...current,
        [user.name]: {
          password: data.password,
          url: data.connection.url,
        },
      }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to reveal Redis URL");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.topbar}>
          <div>
            <a href="/" className={styles.back}>← Platform Admin</a>
            <h1>Redis</h1>
            <p>ACL user and application connection management over the private redis_net network.</p>
          </div>
          <span className={styles.status}>{message}</span>
        </div>

        {credential && (
          <section className={styles.secret}>
            <div className={styles.secretHeader}>
              <div>
                <strong>Redis credential — {credentialUser}</strong>
                <p>Hidden by default and stored encrypted for later reveal.</p>
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
                  <button type="button" onClick={() => navigator.clipboard.writeText(credential.password)}>Copy</button>
                </div>
                <div className={styles.secretRow}>
                  <span>Private Redis URL</span>
                  <code>{credential.url}</code>
                  <button type="button" onClick={() => navigator.clipboard.writeText(credential.url)}>Copy URL</button>
                </div>
              </div>
            )}
          </section>
        )}

        <section className={styles.actions}>
          <form className={styles.card} onSubmit={createUser}>
            <h2>Create Redis user</h2>
            <p>Creates an ACL user for application use and generates a strong password.</p>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="app_cache_user" required />
            <button disabled={busy}>Create user</button>
          </form>

          <form className={styles.card} onSubmit={rotate}>
            <h2>Rotate password</h2>
            <p>Replaces the selected user's Redis password and updates the encrypted vault.</p>
            <input value={rotateUser} onChange={(e) => setRotateUser(e.target.value)} placeholder="app_cache_user" required />
            <button disabled={busy}>Rotate password</button>
          </form>

          <form className={styles.card} onSubmit={remove}>
            <h2>Delete Redis user</h2>
            <p>Removes the ACL user and its saved encrypted credential.</p>
            <input value={deleteUser} onChange={(e) => setDeleteUser(e.target.value)} placeholder="app_cache_user" required />
            <button className={styles.danger} disabled={busy}>Delete user</button>
          </form>
        </section>

        <section className={styles.tableCard}>
          <div className={styles.tableHeader}>
            <div>
              <h2>ACL users</h2>
              <p>Application URL uses <code>redis:{resources.app_port}</code> and requires the app container to join <code>redis_net</code>.</p>
            </div>
            <span className={styles.online}>{resources.status}</span>
          </div>

          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th>User</th><th>Status</th><th>Connection</th></tr></thead>
              <tbody>
                {resources.users.map((user) => {
                  const connection = revealed[user.name];
                  return (
                    <tr key={user.name}>
                      <td><code>{user.name}</code>{user.system && <span className={styles.system}>system</span>}</td>
                      <td>{user.enabled ? "Enabled" : "Disabled"}</td>
                      <td className={styles.connectionCell}>
                        {user.system ? (
                          <span className={styles.muted}>Controller credential hidden</span>
                        ) : user.credential_available ? (
                          <>
                            <button type="button" className={styles.smallButton} disabled={busy} onClick={() => toggleConnection(user)}>
                              {connection ? "Hide URL" : "Show URL"}
                            </button>
                            {connection && (
                              <div className={styles.inlineSecret}>
                                <code>{connection.url}</code>
                                <button type="button" className={styles.smallButton} onClick={() => navigator.clipboard.writeText(connection.url)}>Copy</button>
                              </div>
                            )}
                          </>
                        ) : (
                          <span className={styles.muted}>Password unavailable — rotate once</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
