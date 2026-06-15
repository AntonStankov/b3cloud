import { useState } from "react";
import { useNavigate } from "react-router-dom";
import ApiKeyModal from "../../components/ApiKeyModal";
import Icon from "../../components/Icon";
import { hasApiKey } from "../../api/config";
import LinkRepoModal from "./LinkRepoModal";
import styles from "./LandingPage.module.css";

export default function LandingPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const [apiModalOpen, setApiModalOpen] = useState(false);
  const [apiConnected, setApiConnected] = useState(hasApiKey());
  const navigate = useNavigate();

  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <div className={styles.brand}>
          <span className={styles.mark}>B3</span>
          <span>b3cloud</span>
        </div>
        <nav className={styles.navLinks}>
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate("/dashboard")}>
            Dashboard
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setApiModalOpen(true)}
          >
            {apiConnected ? "API connected" : "Connect API"}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate("/demo")}>
            See demo
          </button>
        </nav>
      </header>

      <main className={styles.hero}>
        <p className="eyebrow">Backend-first deployments</p>
        <h1 className={styles.title}>
          Ship your whole stack
          <br />
          like it&apos;s magic.
        </h1>
        <p className={styles.subtitle}>
          Connect a GitHub repo and b3cloud maps your services, databases, caches and
          queues automatically &mdash; then deploys them to a real cluster. Vercel-clean,
          built for the backend too.
        </p>

        <div className={styles.ctas}>
          <button className="btn btn-accent" onClick={() => setModalOpen(true)}>
            Deploy now
            <Icon name="arrow" size={18} />
          </button>
          <button className="btn btn-ghost" onClick={() => navigate("/demo")}>
            See demo
          </button>
        </div>

        <div className={styles.trustRow}>
          <span className="badge">5-day free trial</span>
          <span className="muted">No credit card to explore the builder</span>
        </div>
      </main>

      <section id="features" className={styles.features}>
        {FEATURES.map((feature) => (
          <article key={feature.title} className={`card ${styles.feature}`}>
            <span className={styles.featureIcon}>
              <Icon name={feature.icon} size={22} />
            </span>
            <h3>{feature.title}</h3>
            <p className="muted">{feature.body}</p>
          </article>
        ))}
      </section>

      <LinkRepoModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onLinked={(projectId, githubUrl) =>
          navigate(`/builder/${projectId}`, { state: { githubUrl } })
        }
        onApiKeySaved={() => setApiConnected(hasApiKey())}
      />
      <ApiKeyModal
        open={apiModalOpen}
        onClose={() => setApiModalOpen(false)}
        onSaved={() => setApiConnected(hasApiKey())}
      />
    </div>
  );
}

const FEATURES = [
  {
    icon: "server",
    title: "Auto-detected infrastructure",
    body: "We read your repo and surface every service, database, cache and worker as an editable element.",
  },
  {
    icon: "database",
    title: "Managed backing services",
    body: "Postgres, MySQL, MongoDB, Redis and RabbitMQ provisioned with credentials injected for you.",
  },
  {
    icon: "bolt",
    title: "Real-time pricing",
    body: "Watch your monthly estimate update as you build. Free for the first five days.",
  },
];
