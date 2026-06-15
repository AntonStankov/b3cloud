const API_KEY_STORAGE = "b3cloud_user_api_key";
let bearerToken = "";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

export const USE_MOCKS =
  (import.meta.env.VITE_USE_MOCKS ?? "false").toLowerCase() === "true";

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? "";
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ?? "";

export function getApiKey(): string {
  return localStorage.getItem(API_KEY_STORAGE) || import.meta.env.VITE_API_KEY || "";
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

export function getBearerToken(): string {
  return bearerToken;
}

export function setBearerToken(value: string): void {
  bearerToken = value;
}

export function clearBearerToken(): void {
  bearerToken = "";
}
