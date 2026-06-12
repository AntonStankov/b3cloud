import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import Icon from "../../components/Icon";
import { useBuilderStore } from "../../store/builderStore";
import { computePricing, formatUsd } from "../../domain/pricing";
import { validateGraph } from "../../domain/validation";
import styles from "./PublishBar.module.css";

export default function PublishBar() {
  const elements = useBuilderStore((s) => s.elements);
  const githubUrl = useBuilderStore((s) => s.githubUrl);
  const navigate = useNavigate();

  const pricing = useMemo(() => computePricing(elements), [elements]);
  const validation = useMemo(() => validateGraph(elements), [elements]);

  const publish = () => {
    if (validation.totalWarnings > 0) {
      const ok = window.confirm(
        `${validation.totalWarnings} item(s) still need attention. Publish anyway?`
      );
      if (!ok) return;
    }
    navigate("/subscribe", {
      state: {
        lineItems: pricing.lineItems,
        monthlyTotalCents: pricing.monthlyTotalCents,
        githubUrl,
      },
    });
  };

  return (
    <div className={`card ${styles.bar}`}>
      <div className={styles.pricing}>
        <span className={styles.priceLabel}>Estimated monthly</span>
        <div className={styles.priceRow}>
          <span className={styles.struck}>
            {formatUsd(pricing.monthlyTotalCents)}
          </span>
          <strong className={styles.free}>$0.00</strong>
        </div>
        <span className={styles.trial}>Free for your first 5 days</span>
      </div>

      <div className={styles.actions}>
        {validation.totalWarnings > 0 && (
          <span className={styles.warn}>
            <Icon name="warning" size={14} />
            {validation.totalWarnings} need attention
          </span>
        )}
        <button
          className="btn btn-accent"
          onClick={publish}
          disabled={elements.length === 0}
        >
          Publish
          <Icon name="arrow" size={18} />
        </button>
      </div>
    </div>
  );
}
