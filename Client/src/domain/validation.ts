import type { InfraElement } from "./elements";

export interface ElementValidation {
  warnings: string[];
  valid: boolean;
}

// Required env vars that the platform injects automatically are excluded: the
// backend overrides DATABASE_URL/REDIS_URL/etc. (PLATFORM_MANAGED_ENV_NAMES in
// platform_core.py), so the user does not need to fill them.
export function validateElement(element: InfraElement): ElementValidation {
  const warnings: string[] = [];

  const missingEnv = element.env.filter(
    (item) => item.required && !item.platformManaged && item.value.trim() === ""
  );
  for (const item of missingEnv) {
    warnings.push(`Required variable ${item.name} is not set.`);
  }

  if (
    (element.kind === "web" || element.kind === "api" || element.kind === "worker") &&
    (!element.port || element.port < 1 || element.port > 65535)
  ) {
    warnings.push("A valid port (1-65535) is required.");
  }

  if (element.migrations?.enabled && element.migrations.command.trim() === "") {
    warnings.push("Migrations are enabled but no command is set.");
  }

  if (element.kind === "bucket") {
    if (!element.bucket?.name.trim()) {
      warnings.push("Bucket name is required.");
    }
    warnings.push("Object storage is not provisionable yet (preview).");
  }

  return { warnings, valid: warnings.length === 0 };
}

export function validateGraph(elements: InfraElement[]): {
  byId: Record<string, ElementValidation>;
  totalWarnings: number;
} {
  const byId: Record<string, ElementValidation> = {};
  let totalWarnings = 0;
  for (const element of elements) {
    const result = validateElement(element);
    byId[element.id] = result;
    totalWarnings += result.warnings.length;
  }
  return { byId, totalWarnings };
}
