import { useBuilderStore } from "../../store/builderStore";
import styles from "./DeploySettings.module.css";

export default function DeploySettings() {
  const nodeArch = useBuilderStore((s) => s.nodeArch);
  const redeployServices = useBuilderStore((s) => s.redeployServices);
  const globalEnvJson = useBuilderStore((s) => s.globalEnvJson);
  const resourceLimits = useBuilderStore((s) => s.resourceLimits);
  const setDeployOption = useBuilderStore((s) => s.setDeployOption);

  return (
    <aside className={`card ${styles.panel}`}>
      <div className={styles.head}>
        <h3>Deploy settings</h3>
        <span className="badge">Live API</span>
      </div>

      <div className={styles.grid}>
        <label className="field">
          <span>Node architecture</span>
          <select
            className="select"
            value={nodeArch}
            onChange={(event) =>
              setDeployOption(
                "nodeArch",
                event.target.value as "any" | "amd64" | "arm64"
              )
            }
          >
            <option value="any">Any</option>
            <option value="amd64">amd64</option>
            <option value="arm64">arm64</option>
          </select>
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={redeployServices}
            onChange={(event) =>
              setDeployOption("redeployServices", event.target.checked)
            }
          />
          Redeploy backing services too. Leave unchecked to preserve database,
          cache and broker state.
        </label>
      </div>

      <div className={styles.grid}>
        <ResourceField label="CPU request" field="cpu_request" />
        <ResourceField label="CPU limit" field="cpu_limit" />
        <ResourceField label="Memory request" field="memory_request" />
        <ResourceField label="Memory limit" field="memory_limit" />
      </div>

      <label className="field">
        <span>Global environment JSON</span>
        <textarea
          className={`textarea mono ${styles.textarea}`}
          value={globalEnvJson}
          placeholder='{"KEY":"value"}'
          onChange={(event) => setDeployOption("globalEnvJson", event.target.value)}
        />
      </label>
    </aside>
  );

  function ResourceField({
    label,
    field,
  }: {
    label: string;
    field: keyof typeof resourceLimits;
  }) {
    return (
      <label className="field">
        <span>{label}</span>
        <input
          className="input mono"
          value={resourceLimits[field]}
          onChange={(event) =>
            setDeployOption("resourceLimits", {
              ...resourceLimits,
              [field]: event.target.value,
            })
          }
        />
      </label>
    );
  }
}
