import Icon from "../../components/Icon";
import { KIND_META, type ElementKind } from "../../domain/elements";
import { useBuilderStore } from "../../store/builderStore";
import { PALETTE_DND_TYPE } from "./GraphCanvas";
import styles from "./ElementPalette.module.css";

const GROUPS: { title: string; kinds: ElementKind[] }[] = [
  { title: "Compute", kinds: ["web", "api", "worker"] },
  { title: "Data", kinds: ["database", "cache", "broker"] },
  { title: "Storage", kinds: ["bucket"] },
];

export default function ElementPalette() {
  const addElement = useBuilderStore((s) => s.addElement);

  return (
    <aside className={styles.palette}>
      <div className={styles.header}>
        <h2>Infrastructure</h2>
        <p className="muted">Drag onto the canvas or click to add.</p>
      </div>

      {GROUPS.map((group) => (
        <div key={group.title} className={styles.group}>
          <span className={styles.groupTitle}>{group.title}</span>
          <div className={styles.items}>
            {group.kinds.map((kind) => {
              const meta = KIND_META[kind];
              return (
                <button
                  key={kind}
                  className={styles.item}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData(PALETTE_DND_TYPE, kind);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => addElement(kind)}
                >
                  <span className={`${styles.icon} ${styles[`cat_${meta.category}`]}`}>
                    <Icon name={meta.icon} size={18} />
                  </span>
                  <span className={styles.itemBody}>
                    <strong>{meta.label}</strong>
                    <small className="muted">{meta.blurb}</small>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </aside>
  );
}
