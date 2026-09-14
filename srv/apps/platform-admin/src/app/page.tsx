import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";
import SignOutButton from "./SignOutButton";
import styles from "./page.module.css";

const modules = [
  { name: "PostgreSQL", description: "Database, role, encrypted credential and connection management.", status: "Ready", href: "/postgres" },
  { name: "MySQL", description: "Independent database service management.", status: "Planned" },
  { name: "Redis", description: "ACL users plus private Redis and public TLS rediss:// connection URLs.", status: "Ready", href: "/redis" },
  { name: "Docker Services", description: "Allowlisted production container status and lifecycle controls.", status: "Ready", href: "/docker" },
];

export default async function Home() {
  if (!(await isAuthenticated())) redirect("/login");

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>VPS Server Management</p>
            <h1>Platform Admin</h1>
            <p className={styles.subtitle}>Minimal control panel for independently managed VPS services.</p>
          </div>
          <div className={styles.headerActions}>
            <div className={styles.status}><span className={styles.statusDot} />Authenticated</div>
            <SignOutButton />
          </div>
        </header>

        <section className={styles.panel}>
          <div className={styles.panelHeader}><div><h2>Infrastructure modules</h2><p>Features are added only when the underlying service is ready.</p></div></div>
          <div className={styles.grid}>
            {modules.map((module) => (
              <article className={styles.card} key={module.name}>
                <div className={styles.cardTop}><h3>{module.name}</h3><span className={styles.badge}>{module.status}</span></div>
                <p>{module.description}</p>
                {module.href && <a href={module.href}>Open manager →</a>}
              </article>
            ))}
          </div>
        </section>

        <footer className={styles.footer}><span>Platform Admin v0.6.0</span><code>GET /api/health</code></footer>
      </section>
    </main>
  );
}
