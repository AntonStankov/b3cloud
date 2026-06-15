import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import ApiKeyModal from "../../components/ApiKeyModal";
import RuntimeLogs from "../../components/RuntimeLogs";
import {
  getAppStatus,
  getJob,
  getRuntimeLogs,
  health,
  listApps,
  listJobs,
} from "../../api/apps";
import { hasApiKey } from "../../api/config";
import type {
  AppStatus,
  AppSummary,
  DeployJob,
  RuntimeLogBundle,
} from "../../api/types";
import { appIdentityFromGithubUrl } from "../../utils/names";
import styles from "./DashboardPage.module.css";

export default function DashboardPage() {
  const navigate = useNavigate();
  const [apiModalOpen, setApiModalOpen] = useState(false);
  const [apiConnected, setApiConnected] = useState(hasApiKey());
  const [apiHealth, setApiHealth] = useState("unknown");
  const [namespace, setNamespace] = useState("");
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [jobs, setJobs] = useState<DeployJob[]>([]);
  const [selected, setSelected] = useState<AppStatus | null>(null);
  const [logs, setLogs] = useState<RuntimeLogBundle[]>([]);
  const [githubUrl, setGithubUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const readyApps = useMemo(
    () =>
      apps.filter(
        (app) => Number(app.ready_replicas || 0) >= Number(app.replicas || 0)
      ).length,
    [apps]
  );

  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      const [healthResult, appResult, jobResult] = await Promise.all([
        health(),
        listApps(namespace.trim() || undefined),
        listJobs(),
      ]);
      setApiHealth(healthResult.status);
      setApps(appResult);
      setJobs(jobResult.slice(0, 12));
      setApiConnected(hasApiKey());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (hasApiKey()) {
      refresh();
    } else {
      health()
        .then((result) => setApiHealth(result.status))
        .catch(() => setApiHealth("down"));
    }
  }, []);

  const inspectApp = async (namespaceValue: string, appName: string) => {
    setLoading(true);
    setError("");
    try {
      const [status, runtime] = await Promise.all([
        getAppStatus(namespaceValue, appName),
        getRuntimeLogs(namespaceValue, appName),
      ]);
      setSelected(status);
      setLogs([runtime]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const inspectFromGithub = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const identity = appIdentityFromGithubUrl(githubUrl);
      await inspectApp(identity.namespace, identity.appName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const inspectJob = async (jobId: string) => {
    setLoading(true);
    setError("");
    try {
      const job = await getJob(jobId);
      setJobs((current) => [job, ...current.filter((item) => item.job_id !== jobId)]);
      if (job.namespace && job.app_name) {
        await inspectApp(job.namespace, job.app_name);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <Link to="/" className={styles.brand}>
          <span className={styles.mark}>B3</span>
          b3cloud
        </Link>
        <div className={styles.navActions}>
          <button className="btn btn-ghost btn-sm" onClick={() => setApiModalOpen(true)}>
            {apiConnected ? "API connected" : "Connect API"}
          </button>
          <button className="btn btn-accent btn-sm" onClick={() => navigate("/")}>
            New deployment
          </button>
        </div>
      </header>

      <section className={styles.hero}>
        <article className={`card ${styles.heroCard}`}>
          <p className="eyebrow">Client control plane</p>
          <h1>Operate every deployment from one place.</h1>
          <p className="muted">
            Refresh inventory, inspect pods and runtime logs, watch deploy jobs,
            and jump back into the visual builder when you need to ship changes.
          </p>
        </article>
        <div className={styles.stats}>
          <article className={`card ${styles.stat}`}>
            <span>API health</span>
            <strong>{apiHealth}</strong>
          </article>
          <article className={`card ${styles.stat}`}>
            <span>Apps</span>
            <strong>{apps.length}</strong>
          </article>
          <article className={`card ${styles.stat}`}>
            <span>Ready</span>
            <strong>{readyApps}</strong>
          </article>
        </div>
      </section>

      <section className={`card ${styles.toolbar}`}>
        <div className={styles.toolbarFields}>
          <label className="field">
            <span>Namespace filter</span>
            <input
              className="input"
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              placeholder="All namespaces"
            />
          </label>
          <button className="btn btn-accent" onClick={refresh} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh live data"}
          </button>
        </div>
      </section>

      {error && <div className={styles.error}>{error}</div>}

      <main className={styles.grid}>
        <section className={`card ${styles.card}`}>
          <div className={styles.sectionHead}>
            <h2>Applications</h2>
            <span className="muted">{namespace || "All namespaces"}</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Namespace</th>
                  <th>App</th>
                  <th>Ready</th>
                  <th>Image</th>
                </tr>
              </thead>
              <tbody>
                {apps.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      No applications found.
                    </td>
                  </tr>
                )}
                {apps.map((app) => (
                  <tr key={`${app.namespace}/${app.app_name}`}>
                    <td>{app.namespace}</td>
                    <td>
                      <button
                        className={styles.rowBtn}
                        onClick={() => inspectApp(app.namespace, app.app_name)}
                      >
                        {app.app_name}
                      </button>
                    </td>
                    <td>
                      {app.ready_replicas}/{app.replicas}
                    </td>
                    <td>
                      <span className={`mono ${styles.image}`}>
                        {app.image || "-"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className={`card ${styles.card}`}>
          <div className={styles.sectionHead}>
            <h2>Status lookup</h2>
          </div>
          <form className={styles.statusForm} onSubmit={inspectFromGithub}>
            <label className="field">
              <span>GitHub URL</span>
              <input
                className="input"
                value={githubUrl}
                onChange={(event) => setGithubUrl(event.target.value)}
                placeholder="https://github.com/org/repo"
              />
            </label>
            <button className="btn btn-ghost" type="submit">
              Fetch status and logs
            </button>
          </form>

          {selected && (
            <div className={styles.detail}>
              <strong>
                {selected.namespace}/{selected.app_name}
              </strong>
              <span>
                {selected.status} · {selected.ready_replicas}/{selected.replicas} ready
              </span>
              <code>{selected.image}</code>
            </div>
          )}

          <RuntimeLogs bundles={logs} />
        </aside>

        <section className={`card ${styles.card}`}>
          <div className={styles.sectionHead}>
            <h2>Recent deploy jobs</h2>
            <button className="btn btn-ghost btn-sm" onClick={refresh}>
              Refresh
            </button>
          </div>
          <div className={styles.jobs}>
            {jobs.length === 0 && <p className="muted">No deploy jobs yet.</p>}
            {jobs.map((job) => (
              <button
                key={job.job_id}
                className={styles.job}
                onClick={() => inspectJob(job.job_id)}
              >
                <strong>
                  {job.app_name ?? "deployment"} · {job.status}
                </strong>
                <span>
                  {job.namespace ?? "-"} · {job.updated_at ?? job.created_at ?? ""}
                </span>
              </button>
            ))}
          </div>
        </section>
      </main>

      <ApiKeyModal
        open={apiModalOpen}
        onClose={() => setApiModalOpen(false)}
        onSaved={() => {
          setApiConnected(hasApiKey());
          refresh();
        }}
      />
    </div>
  );
}
