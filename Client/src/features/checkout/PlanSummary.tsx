import { formatUsd } from "../../domain/pricing";
import type { CheckoutLineItem } from "../../api/mocks/payments";
import styles from "./CheckoutPage.module.css";

interface PlanSummaryProps {
  lineItems: CheckoutLineItem[];
  monthlyTotalCents: number;
  trialDays: number;
}

export default function PlanSummary({
  lineItems,
  monthlyTotalCents,
  trialDays,
}: PlanSummaryProps) {
  return (
    <section className={`card ${styles.summary}`}>
      <h2>Order summary</h2>
      <p className="muted">Pay-as-you-go, billed monthly. Cancel anytime.</p>

      <ul className={styles.lines}>
        {lineItems.map((item, index) => (
          <li key={`${item.label}-${index}`}>
            <span>{item.label}</span>
            <span className="mono">
              {formatUsd(item.amountCents * item.quantity)}
            </span>
          </li>
        ))}
      </ul>

      <div className={styles.totalRow}>
        <span>Monthly total</span>
        <span className="mono">{formatUsd(monthlyTotalCents)}</span>
      </div>

      <div className={styles.trialRow}>
        <div>
          <strong>Due today</strong>
          <small className="muted">{trialDays}-day free trial</small>
        </div>
        <div className={styles.dueAmount}>
          <span className={styles.struck}>{formatUsd(monthlyTotalCents)}</span>
          <strong>{formatUsd(0)}</strong>
        </div>
      </div>
    </section>
  );
}
