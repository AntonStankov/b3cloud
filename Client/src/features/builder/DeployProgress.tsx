import { useMemo } from "react";
import { useBuilderStore } from "../../store/builderStore";
import { computeProgress, MILESTONES } from "./progress";
import styles from "./DeployProgress.module.css";

export default function DeployProgress() {
  const job = useBuilderStore((s) => s.job);
  const progress = useMemo(() => computeProgress(job), [job]);

  const active =
    progress.status === "queued" ||
    progress.status === "running" ||
    progress.status === "submitting";

  if (!job || (!active && progress.status !== "failed")) {
    return null;
  }

  if (progress.status === "failed") {
    return (
      <div className={`${styles.banner} ${styles.failed}`}>
        <strong>Deployment failed</strong>
        <span className="muted">{job.error ?? "Check the logs and retry."}</span>
      </div>
    );
  }

  const current =
    [...MILESTONES].reverse().find((m) => progress.reached.has(m.key))?.label ??
    "Spinning up";

  return (
    <div className={styles.banner}>
      <div className={styles.cloud}>
        <span className={styles.spark} />
      </div>
      <div className={styles.copy}>
        <strong>Magic happening inside the clouds</strong>
        <span className="muted">
          {current} &middot; {progress.percent}%
        </span>
      </div>
      <div className={styles.bar}>
        <span
          className={styles.fill}
          style={{ width: `${Math.max(progress.percent, 4)}%` }}
        />
      </div>
    </div>
  );
}
