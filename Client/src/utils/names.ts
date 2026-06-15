export function repoNameFromGithubUrl(githubUrl: string): string {
  const normalized = githubUrl.trim().replace(/\/+$/, "");
  const match = normalized.match(/\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`Unsupported GitHub URL format: ${githubUrl}`);
  }
  return match[1];
}

export function sanitizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function appIdentityFromGithubUrl(githubUrl: string): {
  namespace: string;
  appName: string;
} {
  const name = sanitizeName(repoNameFromGithubUrl(githubUrl));
  return { namespace: name, appName: name };
}
