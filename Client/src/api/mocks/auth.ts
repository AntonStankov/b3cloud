// Mock session/account. The current backend only has a static API key, so this
// is a lightweight client-side stand-in for a future accounts system.

export interface Session {
  userId: string;
  email: string;
  trialEndsAt: string;
}

const SESSION_KEY = "b3cloud_mock_session";

export function getSession(): Session | null {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function startTrialSession(email = "founder@acme.dev"): Session {
  const trialEndsAt = new Date(
    Date.now() + 5 * 24 * 60 * 60 * 1000
  ).toISOString();
  const session: Session = {
    userId: "mock-" + Math.random().toString(36).slice(2, 10),
    email,
    trialEndsAt,
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export const TRIAL_DAYS = 5;
