import { Link } from "react-router-dom";
import Icon from "../../components/Icon";
import styles from "./DemoPage.module.css";

const STEPS = [
  {
    icon: "github",
    title: "1. Link your repo",
    body: "Connect a GitHub repository. b3cloud clones it and inspects dependency files, compose files and source.",
  },
  {
    icon: "server",
    title: "2. See your infra appear",
    body: "Frontends, APIs, workers, databases, caches and queues show up as connected elements on the builder canvas.",
  },
  {
    icon: "warning",
    title: "3. Fill the gaps",
    body: "Elements that need configuration flag a warning. Click one to set env vars, ports, resources and migrations.",
  },
  {
    icon: "bolt",
    title: "4. Publish",
    body: "Watch the live price estimate, then publish. Your first five days are free.",
  },
];

export default function DemoPage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          <span className={styles.mark}>B3</span> b3cloud
        </Link>
        <Link to="/" className="btn btn-accent btn-sm">
          Deploy now
        </Link>
      </header>

      <main className={styles.main}>
        <p className="eyebrow">Product tour</p>
        <h1 className={styles.title}>From repo to running stack in four steps</h1>
        <p className={styles.subtitle}>
          A quick walkthrough of how b3cloud turns a GitHub repository into a
          fully deployed, editable infrastructure graph.
        </p>

        <div className={styles.steps}>
          {STEPS.map((step) => (
            <article key={step.title} className={`card ${styles.step}`}>
              <span className={styles.stepIcon}>
                <Icon name={step.icon} size={22} />
              </span>
              <h3>{step.title}</h3>
              <p className="muted">{step.body}</p>
            </article>
          ))}
        </div>

        <div className={styles.placeholder}>
          <Icon name="server" size={28} />
          <p className="muted">
            Interactive demo video coming soon. For now, try the real builder.
          </p>
          <Link to="/" className="btn btn-accent">
            Start building
            <Icon name="arrow" size={18} />
          </Link>
        </div>
      </main>
    </div>
  );
}
