// Stripe-shaped mock. The real implementation would call a backend endpoint
// that creates a Checkout Session / SetupIntent and return a client secret.

export interface CheckoutLineItem {
  label: string;
  amountCents: number;
  quantity: number;
}

export interface CheckoutSession {
  id: string;
  clientSecret: string;
  lineItems: CheckoutLineItem[];
  monthlyTotalCents: number;
  trialDays: number;
  amountDueTodayCents: number;
}

export interface CreateCheckoutInput {
  lineItems: CheckoutLineItem[];
  monthlyTotalCents: number;
  trialDays: number;
}

export function createCheckoutSession(
  input: CreateCheckoutInput
): Promise<CheckoutSession> {
  const session: CheckoutSession = {
    id: "cs_mock_" + Math.random().toString(36).slice(2, 12),
    clientSecret: "seti_mock_secret_" + Math.random().toString(36).slice(2, 14),
    lineItems: input.lineItems,
    monthlyTotalCents: input.monthlyTotalCents,
    trialDays: input.trialDays,
    amountDueTodayCents: 0,
  };
  return new Promise((resolve) => setTimeout(() => resolve(session), 500));
}

export interface ConfirmPaymentInput {
  sessionId: string;
  cardName: string;
  cardNumber: string;
  expiry: string;
  cvc: string;
}

export interface PaymentResult {
  status: "active_trial";
  subscriptionId: string;
  trialEndsAt: string;
}

export function confirmSubscription(
  input: ConfirmPaymentInput
): Promise<PaymentResult> {
  const digits = input.cardNumber.replace(/\s+/g, "");
  if (digits.length < 12) {
    return Promise.reject(new Error("Enter a valid card number."));
  }
  return new Promise((resolve) =>
    setTimeout(
      () =>
        resolve({
          status: "active_trial",
          subscriptionId: "sub_mock_" + Math.random().toString(36).slice(2, 12),
          trialEndsAt: new Date(
            Date.now() + 5 * 24 * 60 * 60 * 1000
          ).toISOString(),
        }),
      700
    )
  );
}
