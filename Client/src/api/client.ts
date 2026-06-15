import { API_BASE_URL, getApiKey, getBearerToken } from "./config";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  auth?: boolean;
  apiKey?: string;
  bearerToken?: string;
}

export async function request<T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { method = "GET", body, auth = true, apiKey, bearerToken } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (auth) {
    const token = bearerToken ?? getBearerToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    } else {
      const key = apiKey ?? getApiKey();
      if (!key) {
        throw new ApiError("Sign in before calling the platform API.", 401);
      }
      headers["X-Api-Key"] = key;
    }
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const detail =
      (isRecord(data) && (data.detail || data.raw)) ||
      `${response.status} ${response.statusText}`;
    throw new ApiError(
      typeof detail === "string" ? detail : JSON.stringify(detail),
      response.status
    );
  }

  return data as T;
}

export async function validateApiKey(apiKey: string): Promise<void> {
  await request<unknown[]>("/apps", { apiKey });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
