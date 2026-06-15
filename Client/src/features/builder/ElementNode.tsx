import { Handle, Position, type NodeProps } from "@xyflow/react";
import Icon from "../../components/Icon";
import { KIND_META, type InfraElement } from "../../domain/elements";
import styles from "./ElementNode.module.css";

export interface ElementNodeData {
  element: InfraElement;
  invalid: boolean;
  selected: boolean;
  [key: string]: unknown;
}

const STATUS_LABEL: Record<InfraElement["status"], string> = {
  draft: "Draft",
  deploying: "Deploying",
  deployed: "Live",
  error: "Failed",
};

export default function ElementNode({ data }: NodeProps) {
  const { element, invalid, selected } = data as ElementNodeData;
  const meta = KIND_META[element.kind];

  return (
    <div
      className={[
        styles.node,
        selected ? styles.selected : "",
        invalid ? styles.invalid : "",
      ].join(" ")}
    >
      <Handle type="target" position={Position.Left} className={styles.handle} />
      <span className={`${styles.icon} ${styles[`cat_${meta.category}`]}`}>
        <Icon name={meta.icon} size={20} />
      </span>
      <div className={styles.body}>
        <strong className={styles.label}>{element.label}</strong>
        <small className={styles.kind}>{meta.label}</small>
      </div>
      <span
        className={`${styles.status} ${styles[`status_${element.status}`]}`}
        title={STATUS_LABEL[element.status]}
      >
        {element.status === "deploying" ? (
          <Icon name="spinner" size={14} />
        ) : element.status === "deployed" ? (
          <Icon name="check" size={14} />
        ) : null}
      </span>
      {invalid && (
        <span className={styles.warn} title="Configuration needed">
          <Icon name="warning" size={13} />
        </span>
      )}
      <Handle type="source" position={Position.Right} className={styles.handle} />
    </div>
  );
}
