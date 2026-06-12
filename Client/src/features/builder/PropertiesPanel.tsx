import { type ReactNode, useMemo } from "react";
import Icon from "../../components/Icon";
import { KIND_META, type InfraElement } from "../../domain/elements";
import { validateElement } from "../../domain/validation";
import { useBuilderStore } from "../../store/builderStore";
import styles from "./PropertiesPanel.module.css";

export default function PropertiesPanel() {
  const selectedId = useBuilderStore((s) => s.selectedId);
  const element = useBuilderStore((s) =>
    s.elements.find((el) => el.id === s.selectedId)
  );
  const updateElement = useBuilderStore((s) => s.updateElement);
  const updateEnvValue = useBuilderStore((s) => s.updateEnvValue);
  const removeElement = useBuilderStore((s) => s.removeElement);
  const select = useBuilderStore((s) => s.select);

  const validation = useMemo(
    () => (element ? validateElement(element) : null),
    [element]
  );

  if (!selectedId || !element || !validation) {
    return (
      <aside className={styles.panel}>
        <div className={styles.empty}>
          <Icon name="server" size={26} />
          <p>Select an element to configure it.</p>
        </div>
      </aside>
    );
  }

  const isCompute =
    element.kind === "web" || element.kind === "api" || element.kind === "worker";
  const userEnv = element.env.filter((item) => !item.platformManaged);
  const managedEnv = element.env.filter((item) => item.platformManaged);

  return (
    <aside className={styles.panel}>
      <header className={styles.header}>
        <div>
          <span className="badge">{KIND_META[element.kind].label}</span>
          <input
            className={styles.titleInput}
            value={element.label}
            onChange={(e) => updateElement(element.id, { label: e.target.value })}
          />
          {element.path && (
            <span className={`mono ${styles.path}`}>./{element.path}</span>
          )}
        </div>
        <button
          className={styles.iconBtn}
          title="Close"
          onClick={() => select(null)}
        >
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className={styles.scroll}>
        {isCompute && (
          <Section title="Runtime">
            <label className="field">
              <span>Port</span>
              <input
                className="input"
                type="number"
                value={element.port ?? 8080}
                onChange={(e) =>
                  updateElement(element.id, { port: Number(e.target.value) })
                }
              />
              {element.portConfidence && (
                <small className="muted">Detected: {element.portConfidence}</small>
              )}
            </label>
            <label className="field">
              <span>Access</span>
              <select
                className="select"
                value={element.public ? "public" : "private"}
                onChange={(e) =>
                  updateElement(element.id, {
                    public: e.target.value === "public",
                  })
                }
              >
                <option value="public">Public</option>
                <option value="private">Private (internal only)</option>
              </select>
            </label>
          </Section>
        )}

        {isCompute && (
          <Section title="Resources">
            <div className={styles.grid2}>
              <ResourceField
                label="CPU request"
                value={element.resources.cpu_request}
                onChange={(v) => patchResource(element, updateElement, "cpu_request", v)}
              />
              <ResourceField
                label="CPU limit"
                value={element.resources.cpu_limit}
                onChange={(v) => patchResource(element, updateElement, "cpu_limit", v)}
              />
              <ResourceField
                label="Memory request"
                value={element.resources.memory_request}
                onChange={(v) =>
                  patchResource(element, updateElement, "memory_request", v)
                }
              />
              <ResourceField
                label="Memory limit"
                value={element.resources.memory_limit}
                onChange={(v) =>
                  patchResource(element, updateElement, "memory_limit", v)
                }
              />
            </div>
          </Section>
        )}

        {isCompute && (
          <Section title="Environment variables">
            {userEnv.length === 0 && (
              <p className="muted">No environment variables detected.</p>
            )}
            {userEnv.map((item) => {
              const missing = item.required && item.value.trim() === "";
              return (
                <label key={item.name} className="field">
                  <span className={styles.envLabel}>
                    {item.name}
                    {item.required && <em className={styles.req}>required</em>}
                    {missing && <Icon name="warning" size={13} className={styles.envWarn} />}
                  </span>
                  <input
                    className="input"
                    type={item.secret ? "password" : "text"}
                    placeholder={item.required ? "Required" : "Optional"}
                    value={item.value}
                    onChange={(e) =>
                      updateEnvValue(element.id, item.name, e.target.value)
                    }
                    data-invalid={missing || undefined}
                  />
                  {item.evidence[0] && (
                    <small className="muted">{item.evidence[0]}</small>
                  )}
                </label>
              );
            })}
            {managedEnv.length > 0 && (
              <div className={styles.managed}>
                <span className={styles.managedTitle}>
                  Auto-injected by b3cloud
                </span>
                <div className={styles.managedTags}>
                  {managedEnv.map((item) => (
                    <span key={item.name} className="mono">
                      {item.name}
                    </span>
                  ))}
                </div>
                <small className="muted">
                  Connection strings for linked services are generated and
                  override any value you set.
                </small>
              </div>
            )}
          </Section>
        )}

        {element.migrations && (
          <Section title="Database migrations">
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={element.migrations.enabled}
                onChange={(e) =>
                  updateElement(element.id, {
                    migrations: {
                      ...element.migrations!,
                      enabled: e.target.checked,
                    },
                  })
                }
              />
              Run migrations on deploy
            </label>
            {element.migrations.enabled && (
              <label className="field">
                <span>Migration command</span>
                <input
                  className="input mono"
                  value={element.migrations.command}
                  onChange={(e) =>
                    updateElement(element.id, {
                      migrations: {
                        ...element.migrations!,
                        command: e.target.value,
                      },
                    })
                  }
                />
              </label>
            )}
          </Section>
        )}

        {element.bucket && (
          <Section title="Object storage">
            <label className="field">
              <span>Bucket name</span>
              <input
                className="input"
                value={element.bucket.name}
                placeholder="my-app-assets"
                onChange={(e) =>
                  updateElement(element.id, {
                    bucket: { ...element.bucket!, name: e.target.value },
                  })
                }
              />
            </label>
            <label className="field">
              <span>Region</span>
              <select
                className="select"
                value={element.bucket.region}
                onChange={(e) =>
                  updateElement(element.id, {
                    bucket: { ...element.bucket!, region: e.target.value },
                  })
                }
              >
                <option value="fsn1">Falkenstein (fsn1)</option>
                <option value="nbg1">Nuremberg (nbg1)</option>
                <option value="hel1">Helsinki (hel1)</option>
              </select>
            </label>
          </Section>
        )}

        {(element.kind === "cache" || element.kind === "broker" || element.kind === "database") && (
          <Section title="Connection">
            <p className="muted">
              Managed by b3cloud with generated credentials. Linked services
              receive the connection string automatically over a private
              ClusterIP &mdash; no public endpoint is exposed.
            </p>
          </Section>
        )}

        {validation.warnings.length > 0 && (
          <div className={styles.warnings}>
            <span className={styles.warningsTitle}>
              <Icon name="warning" size={15} />
              Needs attention
            </span>
            <ul>
              {validation.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <footer className={styles.footer}>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => removeElement(element.id)}
        >
          Remove element
        </button>
      </footer>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      {children}
    </section>
  );
}

function ResourceField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function patchResource(
  element: InfraElement,
  update: (id: string, patch: Partial<InfraElement>) => void,
  key: keyof InfraElement["resources"],
  value: string
) {
  update(element.id, {
    resources: { ...element.resources, [key]: value },
  });
}
