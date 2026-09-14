import styles from "./page.module.css";

const modules = [
  {
    name: "PostgreSQL",
    description: "Database, role, password and permission management.",
    status: "Next",
  },
  {
    name: "MySQL",
    description: "Independent database service management.",
    status: "Planned",
  },
  {
    name: "Redis",
    description: "Cache, ACL and connection management.",
    status: "Planned",
  },
  {
    name: "Docker Services",
    description: "Service status and lifecycle overview.",
    status: "Planned",
  },
];

export default function Home() {
  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>VPS Server Management</p>
            <h1>Platform Admin</h1>
            <p className={styles.subtitle}>
              Minimal control panel for independently managed VPS services.
            </p>
          </div>

          <div className={styles.status}>
            <span className={styles.statusDot} />
            Application running
          </div>
        </header>

        <section className={styles.panel}>
          <div className={styles.panelHeader}>
            <div>
              <h2>Infrastructure modules</h2>
              <p>Features will be added only when the underlying service is ready.</p>
            </div>
          </div>

          <div className={styles.grid}>
            {modules.map((module) => (
              <article className={styles.card} key={module.name}>
                <div className={styles.cardTop}>
                  <h3>{module.name}</h3>
                  <span className={styles.badge}>{module.status}</span>
                </div>
                <p>{module.description}</p>
              </article>
            ))}
          </div>
        </section>

        <footer className={styles.footer}>
          <span>Platform Admin v0.1.0</span>
          <code>GET /api/health</code>
        </footer>
      </section>
    </main>
  );
}
