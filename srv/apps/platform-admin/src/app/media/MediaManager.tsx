"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./media.module.css";

type MediaOverview = {
  users: number;
  files: number;
  stored_bytes: number;
  max_upload_bytes: number;
  public_files_enabled: boolean;
  public_base_url: string | null;
  filesystem: {
    total_bytes: number;
    used_bytes: number;
    available_bytes: number;
    reserved_bytes: number;
    upload_available_bytes: number;
  };
};

type MediaUser = {
  id: string;
  name: string;
  api_key_prefix: string;
  quota_bytes: number | null;
  used_bytes: number;
  available_bytes: number | null;
  usage_percent: number;
  file_count: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type MediaFile = {
  id: string;
  user_id: string;
  original_name: string;
  mime_type: string;
  extension: string;
  size_bytes: number;
  kind: string;
  visibility: "private" | "public";
  checksum_sha256: string;
  public_url: string | null;
  content_url: string;
  created_at: string;
};

type UserDraft = { quotaGiB: string };

function formatBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined) return "Unlimited";
  const value = Number(bytes || 0);
  if (value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(2)} ${units[index]}`;
}

function bytesToGiB(bytes: number | null) {
  if (bytes === null) return "";
  return String(Number((bytes / 1024 ** 3).toFixed(3)));
}

function quotaBytes(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const gib = Number(trimmed);
  if (!Number.isFinite(gib) || gib < 0) throw new Error("Quota must be a positive GiB value or blank for unlimited");
  return Math.floor(gib * 1024 ** 3);
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function MediaManager() {
  const [overview, setOverview] = useState<MediaOverview | null>(null);
  const [users, setUsers] = useState<MediaUser[]>([]);
  const [message, setMessage] = useState("Loading media service...");
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, UserDraft>>({});
  const [newUserName, setNewUserName] = useState("");
  const [newUserQuota, setNewUserQuota] = useState("");
  const [revealedKey, setRevealedKey] = useState<{ user: string; key: string } | null>(null);
  const [selectedUser, setSelectedUser] = useState<MediaUser | null>(null);
  const [files, setFiles] = useState<MediaFile[]>([]);
  const [filesTotal, setFilesTotal] = useState(0);
  const [loadingFiles, setLoadingFiles] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/media", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Unable to load media service");
    setOverview(data.overview || null);
    const nextUsers: MediaUser[] = data.users || [];
    setUsers(nextUsers);
    setDrafts((current) => {
      const next = { ...current };
      for (const user of nextUsers) {
        if (!next[user.id]) next[user.id] = { quotaGiB: bytesToGiB(user.quota_bytes) };
      }
      return next;
    });
    setSelectedUser((current) => {
      if (!current) return null;
      return nextUsers.find((user) => user.id === current.id) || null;
    });
    setMessage("Media service connected");
  }, []);

  useEffect(() => {
    refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  const serverUsagePercent = useMemo(() => {
    if (!overview?.filesystem?.total_bytes) return 0;
    return Math.min(100, (overview.filesystem.used_bytes / overview.filesystem.total_bytes) * 100);
  }, [overview]);

  async function post(payload: Record<string, unknown>) {
    const response = await fetch("/api/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Media action failed");
    return data;
  }

  async function createUser() {
    if (!newUserName.trim()) {
      setMessage("User name is required");
      return;
    }
    setBusy("create");
    try {
      const data = await post({ action: "create-user", name: newUserName.trim(), quota_bytes: quotaBytes(newUserQuota) });
      setRevealedKey({ user: data.user.name, key: data.api_key });
      setNewUserName("");
      setNewUserQuota("");
      setMessage(`${data.user.name}: media user created`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create media user");
    } finally {
      setBusy(null);
    }
  }

  async function updateQuota(user: MediaUser) {
    const draft = drafts[user.id] || { quotaGiB: "" };
    setBusy(user.id);
    try {
      await post({ action: "update-user", user_id: user.id, quota_bytes: quotaBytes(draft.quotaGiB) });
      setMessage(`${user.name}: storage quota updated`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update quota");
    } finally {
      setBusy(null);
    }
  }

  async function toggleUser(user: MediaUser) {
    setBusy(user.id);
    try {
      await post({ action: "update-user", user_id: user.id, is_active: !user.is_active });
      setMessage(`${user.name}: ${user.is_active ? "disabled" : "enabled"}`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update user");
    } finally {
      setBusy(null);
    }
  }

  async function rotateKey(user: MediaUser) {
    if (!window.confirm(`Rotate the API key for ${user.name}? The old key will stop working immediately.`)) return;
    setBusy(user.id);
    try {
      const data = await post({ action: "rotate-key", user_id: user.id });
      setRevealedKey({ user: user.name, key: data.api_key });
      setMessage(`${user.name}: API key rotated`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to rotate API key");
    } finally {
      setBusy(null);
    }
  }

  async function deleteUser(user: MediaUser) {
    const answer = window.prompt(
      `Permanently delete ${user.name}, all ${user.file_count} files, and ${formatBytes(user.used_bytes)} of stored data?\n\nType the user name to confirm:`,
    );
    if (answer !== user.name) return;
    setBusy(user.id);
    try {
      await post({ action: "delete-user", user_id: user.id });
      if (selectedUser?.id === user.id) {
        setSelectedUser(null);
        setFiles([]);
        setFilesTotal(0);
      }
      setMessage(`${user.name}: permanently deleted`);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete user");
    } finally {
      setBusy(null);
    }
  }

  async function loadFiles(user: MediaUser) {
    setSelectedUser(user);
    setLoadingFiles(true);
    try {
      const response = await fetch(`/api/media?user_id=${encodeURIComponent(user.id)}&limit=200`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load files");
      setFiles(data.files || []);
      setFilesTotal(Number(data.total || 0));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load files");
    } finally {
      setLoadingFiles(false);
    }
  }

  async function deleteFile(file: MediaFile) {
    if (!window.confirm(`Permanently delete ${file.original_name} from the database and storage?`)) return;
    setBusy(file.id);
    try {
      await post({ action: "delete-file", file_id: file.id });
      setMessage(`${file.original_name}: permanently deleted`);
      if (selectedUser) await loadFiles(selectedUser);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to delete file");
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
            <h1>Media Storage</h1>
            <p>Multi-user file storage with per-user quotas, API keys, public/private files and hard deletion.</p>
          </div>
          <div className={styles.actions}>
            <span className={styles.status}>{message}</span>
            <button type="button" disabled={Boolean(busy)} onClick={() => refresh().catch((error) => setMessage(error.message))}>Refresh</button>
          </div>
        </header>

        <section className={styles.summaryGrid}>
          <article><span>Media users</span><strong>{overview?.users ?? "—"}</strong><small>Independent API keys and quotas</small></article>
          <article><span>Stored files</span><strong>{overview?.files ?? "—"}</strong><small>{overview ? formatBytes(overview.stored_bytes) : "—"} tracked by media service</small></article>
          <article>
            <span>Host filesystem</span><strong>{overview ? formatBytes(overview.filesystem.total_bytes) : "—"}</strong>
            <div className={styles.bar}><span style={{ width: `${serverUsagePercent}%` }} /></div>
            <small>{overview ? `${formatBytes(overview.filesystem.available_bytes)} currently available` : "—"}</small>
          </article>
          <article><span>Safe upload capacity</span><strong>{overview ? formatBytes(overview.filesystem.upload_available_bytes) : "—"}</strong><small>{overview ? `${formatBytes(overview.filesystem.reserved_bytes)} host reserve protected` : "—"}</small></article>
        </section>

        <section className={styles.createPanel}>
          <div><h2>Create media user</h2><p>The API key is shown once. Leave quota blank for unlimited user storage.</p></div>
          <div className={styles.createFields}>
            <label><span>User name</span><input value={newUserName} onChange={(event) => setNewUserName(event.target.value)} placeholder="shop-01" /></label>
            <label><span>Quota (GiB)</span><input type="number" min="0" step="0.25" value={newUserQuota} onChange={(event) => setNewUserQuota(event.target.value)} placeholder="Unlimited" /></label>
            <button type="button" disabled={busy === "create"} onClick={createUser}>Create user</button>
          </div>
        </section>

        {revealedKey && (
          <section className={styles.secretPanel}>
            <div><strong>{revealedKey.user} API key</strong><p>Copy this now. The plaintext key is not stored and cannot be revealed later.</p></div>
            <code>{revealedKey.key}</code>
            <div className={styles.secretActions}>
              <button type="button" onClick={() => navigator.clipboard.writeText(revealedKey.key)}>Copy key</button>
              <button type="button" className={styles.secondary} onClick={() => setRevealedKey(null)}>Hide</button>
            </div>
          </section>
        )}

        <section className={styles.usersPanel}>
          <div className={styles.sectionHeader}><div><h2>Users</h2><p>Quota changes cannot be lower than the user's current stored bytes.</p></div></div>
          <div className={styles.userList}>
            {users.map((user) => {
              const draft = drafts[user.id] || { quotaGiB: bytesToGiB(user.quota_bytes) };
              const bar = user.quota_bytes ? Math.min(100, user.usage_percent) : 0;
              return (
                <article className={styles.userCard} key={user.id}>
                  <div className={styles.userHeader}>
                    <div>
                      <div className={styles.titleLine}><h3>{user.name}</h3><span className={user.is_active ? styles.active : styles.disabled}>{user.is_active ? "active" : "disabled"}</span></div>
                      <code>{user.api_key_prefix}…</code>
                    </div>
                    <div className={styles.userActions}>
                      <button type="button" disabled={busy === user.id} onClick={() => loadFiles(user)}>Files ({user.file_count})</button>
                      <button type="button" disabled={busy === user.id} onClick={() => rotateKey(user)}>Rotate key</button>
                      <button type="button" disabled={busy === user.id} onClick={() => toggleUser(user)}>{user.is_active ? "Disable" : "Enable"}</button>
                      <button type="button" className={styles.danger} disabled={busy === user.id} onClick={() => deleteUser(user)}>Delete user</button>
                    </div>
                  </div>

                  <div className={styles.usageGrid}>
                    <div><span>Used</span><strong>{formatBytes(user.used_bytes)}</strong></div>
                    <div><span>Quota</span><strong>{formatBytes(user.quota_bytes)}</strong></div>
                    <div><span>Available</span><strong>{formatBytes(user.available_bytes)}</strong></div>
                    <div><span>Files</span><strong>{user.file_count}</strong></div>
                  </div>
                  {user.quota_bytes !== null && <div className={styles.bar}><span style={{ width: `${bar}%` }} /></div>}

                  <div className={styles.quotaRow}>
                    <label>
                      <span>Quota (GiB)</span>
                      <input type="number" min="0" step="0.25" value={draft.quotaGiB} placeholder="Unlimited" disabled={busy === user.id}
                        onChange={(event) => setDrafts((current) => ({ ...current, [user.id]: { quotaGiB: event.target.value } }))} />
                    </label>
                    <button type="button" disabled={busy === user.id} onClick={() => updateQuota(user)}>Apply quota</button>
                    <small>Created {formatDate(user.created_at)}</small>
                  </div>
                </article>
              );
            })}
            {users.length === 0 && <div className={styles.empty}>No media users yet.</div>}
          </div>
        </section>

        {selectedUser && (
          <section className={styles.filesPanel}>
            <div className={styles.sectionHeader}>
              <div><h2>{selectedUser.name} files</h2><p>{filesTotal} total files. Deleting here permanently removes the DB row and physical storage file.</p></div>
              <button type="button" className={styles.secondary} onClick={() => loadFiles(selectedUser)} disabled={loadingFiles}>{loadingFiles ? "Loading..." : "Refresh files"}</button>
            </div>

            <div className={styles.fileTable}>
              <div className={styles.fileHead}><span>Name</span><span>Type</span><span>Size</span><span>Visibility</span><span>Created</span><span /></div>
              {files.map((file) => (
                <div className={styles.fileRow} key={file.id}>
                  <div><strong>{file.original_name}</strong><code>{file.id}</code></div>
                  <span>{file.kind}<small>{file.mime_type}</small></span>
                  <span>{formatBytes(file.size_bytes)}</span>
                  <span>{file.visibility}{file.public_url && <a href={file.public_url} target="_blank" rel="noreferrer">Open public URL</a>}</span>
                  <span>{formatDate(file.created_at)}</span>
                  <button type="button" className={styles.danger} disabled={busy === file.id} onClick={() => deleteFile(file)}>Delete</button>
                </div>
              ))}
              {!loadingFiles && files.length === 0 && <div className={styles.empty}>This user has no files.</div>}
            </div>
          </section>
        )}

        <p className={styles.note}>Uploads are accepted through the media API using each user's bearer key. The service checks the per-user quota and host free-space reserve before committing the file.</p>
      </section>
    </main>
  );
}
