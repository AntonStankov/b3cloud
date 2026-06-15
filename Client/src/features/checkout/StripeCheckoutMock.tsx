import { type FormEvent, useState } from "react";
import Icon from "../../components/Icon";
import {
  confirmSubscription,
  type CheckoutSession,
} from "../../api/mocks/payments";
import styles from "./CheckoutPage.module.css";

interface StripeCheckoutMockProps {
  session: CheckoutSession | null;
  onSuccess: () => void;
}

function formatCardNumber(value: string): string {
  return value
    .replace(/\D/g, "")
    .slice(0, 16)
    .replace(/(.{4})/g, "$1 ")
    .trim();
}

function formatExpiry(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  if (digits.length < 3) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

export default function StripeCheckoutMock({
  session,
  onSuccess,
}: StripeCheckoutMockProps) {
  const [cardName, setCardName] = useState("");
  const [cardNumber, setCardNumber] = useState("");
  const [expiry, setExpiry] = useState("");
  const [cvc, setCvc] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!session) return;
    setSubmitting(true);
    setError(null);
    try {
      await confirmSubscription({
        sessionId: session.id,
        cardName,
        cardNumber,
        expiry,
        cvc,
      });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className={`card ${styles.checkout}`}>
      <div className={styles.checkoutHead}>
        <h2>Payment details</h2>
        <span className={styles.secure}>
          <Icon name="bolt" size={14} />
          Secured by Stripe
        </span>
      </div>

      <form className={styles.form} onSubmit={submit}>
        <label className="field">
          <span>Name on card</span>
          <input
            className="input"
            value={cardName}
            onChange={(e) => setCardName(e.target.value)}
            placeholder="Ada Lovelace"
            required
          />
        </label>

        <label className="field">
          <span>Card number</span>
          <div className={styles.cardField}>
            <Icon name="bolt" size={16} className={styles.cardIcon} />
            <input
              className="input"
              value={cardNumber}
              onChange={(e) => setCardNumber(formatCardNumber(e.target.value))}
              placeholder="4242 4242 4242 4242"
              inputMode="numeric"
              required
            />
          </div>
        </label>

        <div className={styles.cardRow}>
          <label className="field">
            <span>Expiry</span>
            <input
              className="input"
              value={expiry}
              onChange={(e) => setExpiry(formatExpiry(e.target.value))}
              placeholder="MM/YY"
              inputMode="numeric"
              required
            />
          </label>
          <label className="field">
            <span>CVC</span>
            <input
              className="input"
              value={cvc}
              onChange={(e) =>
                setCvc(e.target.value.replace(/\D/g, "").slice(0, 4))
              }
              placeholder="123"
              inputMode="numeric"
              required
            />
          </label>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <button
          type="submit"
          className="btn btn-accent"
          disabled={submitting || !session}
        >
          {submitting ? (
            <>
              <Icon name="spinner" size={16} />
              Starting trial…
            </>
          ) : (
            "Start 5-day free trial"
          )}
        </button>
        <small className="muted">
          You won&apos;t be charged today. We&apos;ll email a reminder before the
          trial ends.
        </small>
      </form>
    </section>
  );
}
