import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import Icon from "../../components/Icon";
import { formatUsd } from "../../domain/pricing";
import {
  createCheckoutSession,
  type CheckoutLineItem,
  type CheckoutSession,
} from "../../api/mocks/payments";
import PlanSummary from "./PlanSummary";
import StripeCheckoutMock from "./StripeCheckoutMock";
import styles from "./CheckoutPage.module.css";

interface CheckoutLocationState {
  lineItems?: CheckoutLineItem[];
  monthlyTotalCents?: number;
  githubUrl?: string;
}

const TRIAL_DAYS = 5;

export default function CheckoutPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state as CheckoutLocationState | null) ?? {};
  const lineItems = state.lineItems ?? [];
  const monthlyTotalCents = state.monthlyTotalCents ?? 0;

  const [session, setSession] = useState<CheckoutSession | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    createCheckoutSession({
      lineItems,
      monthlyTotalCents,
      trialDays: TRIAL_DAYS,
    }).then(setSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (lineItems.length === 0 && !done) {
    return (
      <div className={styles.fallback}>
        <h2>Nothing to subscribe to yet</h2>
        <p className="muted">Build your stack first, then publish.</p>
        <Link to="/" className="btn btn-accent">
          Go home
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button className={styles.back} onClick={() => navigate(-1)}>
          <Icon name="arrow" size={18} className={styles.backIcon} />
          Back to builder
        </button>
        <div className={styles.brand}>
          <span className={styles.mark}>B3</span> b3cloud
        </div>
      </header>

      <main className={styles.grid}>
        <PlanSummary
          lineItems={lineItems}
          monthlyTotalCents={monthlyTotalCents}
          trialDays={TRIAL_DAYS}
        />

        {done ? (
          <SuccessCard trialDays={TRIAL_DAYS} />
        ) : (
          <StripeCheckoutMock
            session={session}
            onSuccess={() => setDone(true)}
          />
        )}
      </main>
    </div>
  );
}

function SuccessCard({ trialDays }: { trialDays: number }) {
  return (
    <section className={`card ${styles.success}`}>
      <span className={styles.successIcon}>
        <Icon name="check" size={28} />
      </span>
      <h2>You&apos;re live!</h2>
      <p className="muted">
        Your subscription is active. The first {trialDays} days are on us &mdash;
        you won&apos;t be charged {formatUsd(0)} today.
      </p>
      <Link to="/" className="btn btn-accent">
        Back to dashboard
      </Link>
    </section>
  );
}
