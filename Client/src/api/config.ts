// Central runtime config and the API-key store (kept in localStorage, mirroring
// the existing user_ui behavior).

const API_KEY_STORAGE = "b3cloud_user_api_key";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export const USE_MOCKS =
  (import.meta.env.VITE_USE_MOCKS ?? "true").toLowerCase() !== "false";

export function getApiKey(): string {
  return (
    localStorage.getItem(API_KEY_STORAGE) ||
    import.meta.env.VITE_API_KEY ||
    ""
  );
}

export function setApiKey(value: string): void {
  localStorage.setItem(API_KEY_STORAGE, value.trim());
}

export function clearApiKey(): void {
  localStorage.removeItem(API_KEY_STORAGE);
}

export function hasApiKey(): boolean {
  return Boolean(getApiKey());
}
