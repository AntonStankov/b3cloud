import type { RuntimeLogBundle } from "../api/types";
import styles from "./RuntimeLogs.module.css";

interface RuntimeLogsProps {
  bundles: RuntimeLogBundle[];
}

export default function RuntimeLogs({ bundles }: RuntimeLogsProps) {
  if (!bundles.length) {
    return (
      <div className={styles.empty}>
        Runtime container logs will appear after a deployment is selected.
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      {bundles.map((bundle) => (
        <article
          key={`${bundle.namespace}/${bundle.app_name}/${
            bundle.component_name ?? bundle.app_name
          }`}
          className={styles.panel}
        >
          <header className={styles.head}>
            <div>
              <strong>{bundle.component_name ?? bundle.app_name}</strong>
              <small>
                {bundle.namespace}/{bundle.app_name}
              </small>
            </div>
            <span className={styles.status}>
              {bundle.status} · {bundle.ready_replicas}/{bundle.replicas} ready
            </span>
          </header>

          {bundle.error_summary && (
            <div className={styles.error}>{bundle.error_summary}</div>
          )}

          {bundle.pods.length === 0 && (
            <p className={styles.empty}>No pods found for this component yet.</p>
          )}

          {bundle.pods.map((pod) => (
            <details key={pod.name} className={styles.pod} open>
              <summary>
                {pod.name} · {pod.phase}
              </summary>
              {pod.containers.map((container) => (
                <section key={container.name} className={styles.container}>
                  <div className={styles.containerHead}>
                    <strong>{container.name}</strong>
                    <span>
                      {container.ready ? "ready" : "not ready"} · restarts{" "}
                      {container.restarts} · {container.state}
                    </span>
                  </div>
                  {container.error_line && (
                    <div className={styles.error}>{container.error_line}</div>
                  )}
                  <pre className={styles.logs}>
                    {container.current_logs?.trim() || "No current logs."}
                  </pre>
                  {container.previous_logs?.trim() && (
                    <pre className={styles.logs}>
                      Previous crash logs{"\n\n"}
                      {container.previous_logs.trim()}
                    </pre>
                  )}
                </section>
              ))}
            </details>
          ))}
        </article>
      ))}
    </div>
  );
}
