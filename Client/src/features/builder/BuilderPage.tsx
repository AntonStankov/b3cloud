import { useEffect } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { ReactFlowProvider } from "@xyflow/react";
import Icon from "../../components/Icon";
import { useBuilderStore } from "../../store/builderStore";
import ElementPalette from "./ElementPalette";
import GraphCanvas from "./GraphCanvas";
import PropertiesPanel from "./PropertiesPanel";
import DeployProgress from "./DeployProgress";
import PublishBar from "./PublishBar";
import styles from "./BuilderPage.module.css";

interface BuilderLocationState {
  githubUrl?: string;
}

export default function BuilderPage() {
  const { projectId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const githubUrl = (location.state as BuilderLocationState | null)?.githubUrl;

  const status = useBuilderStore((s) => s.status);
  const analyzeError = useBuilderStore((s) => s.analyzeError);
  const job = useBuilderStore((s) => s.job);
  const deployJobId = useBuilderStore((s) => s.deployJobId);
  const storeGithubUrl = useBuilderStore((s) => s.githubUrl);
  const loadProject = useBuilderStore((s) => s.loadProject);
  const refreshJob = useBuilderStore((s) => s.refreshJob);

  useEffect(() => {
    if (projectId && githubUrl) {
      loadProject(projectId, githubUrl);
    }
  }, [projectId, githubUrl, loadProject]);

  // Poll the deploy job while it is active.
  useEffect(() => {
    if (!deployJobId) return;
    if (job && (job.status === "succeeded" || job.status === "failed")) return;
    const interval = setInterval(refreshJob, 2500);
    return () => clearInterval(interval);
  }, [deployJobId, job, refreshJob]);

  if (!githubUrl && !storeGithubUrl) {
    return (
      <div className={styles.fallback}>
        <h2>No repository linked</h2>
        <p className="muted">Start from the home page to link a GitHub repo.</p>
        <Link to="/" className="btn btn-accent">
          Go home
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <button className={styles.back} onClick={() => navigate("/")}>
          <span className={styles.mark}>B3</span>
        </button>
        <div className={styles.project}>
          <strong>{projectId}</strong>
          <span className={`mono ${styles.repo}`}>{storeGithubUrl || githubUrl}</span>
        </div>
        <StatusPill />
      </header>

      <div className={styles.body}>
        <ElementPalette />

        <main className={styles.canvasWrap}>
          {status === "analyzing" && (
            <div className={styles.analyzing}>
              <div className={styles.analyzingCard}>
                <Icon name="spinner" size={22} />
                <strong>Analyzing your repository</strong>
                <span className="muted">
                  Detecting services, databases and components…
                </span>
              </div>
            </div>
          )}
          {status === "error" && (
            <div className={styles.analyzing}>
              <div className={styles.analyzingCard}>
                <Icon name="warning" size={22} className={styles.errIcon} />
                <strong>Could not analyze repository</strong>
                <span className="muted">{analyzeError}</span>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    projectId &&
                    loadProject(projectId, storeGithubUrl || githubUrl || "")
                  }
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          <ReactFlowProvider>
            <GraphCanvas />
          </ReactFlowProvider>

          <DeployProgress />
          {status === "ready" && <PublishBar />}
        </main>

        <PropertiesPanel />
      </div>
    </div>
  );
}

function StatusPill() {
  const job = useBuilderStore((s) => s.job);
  const status = useBuilderStore((s) => s.status);

  let label = "Draft";
  let tone = styles.pillDraft;
  if (status === "analyzing") {
    label = "Analyzing";
    tone = styles.pillBusy;
  } else if (job?.status === "succeeded") {
    label = "Deployed";
    tone = styles.pillOk;
  } else if (job?.status === "failed") {
    label = "Failed";
    tone = styles.pillErr;
  } else if (job?.status === "running" || job?.status === "queued") {
    label = "Deploying";
    tone = styles.pillBusy;
  }

  return <span className={`${styles.pill} ${tone}`}>{label}</span>;
}
