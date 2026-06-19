import { request } from "./client";
import { USE_MOCKS } from "./config";
import {
  mockAnalyze,
  mockDeploy,
  mockGetJob,
  mockListApps,
} from "./mocks/deploy";
import type {
  AnalyzeResult,
  AppStatus,
  AppSummary,
  DeployInput,
  DeployJob,
  ProjectSummary,
  RuntimeLogBundle,
} from "./types";

export interface AnalyzeInput {
  github_url: string;
  github_token?: string;
  git_revision?: string;
}

export async function analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
  if (USE_MOCKS) {
    return mockAnalyze(input);
  }
  return request<AnalyzeResult>("/apps/analyze", {
    method: "POST",
    body: { git_revision: "main", ...input },
  });
}

export async function deploy(input: DeployInput): Promise<DeployJob> {
  if (USE_MOCKS) {
    return mockDeploy(input);
  }
  return request<DeployJob>("/apps/deploy", { method: "POST", body: input });
}

export async function getJob(jobId: string): Promise<DeployJob> {
  if (USE_MOCKS) {
    return mockGetJob(jobId);
  }
  return request<DeployJob>(`/deploy-jobs/${encodeURIComponent(jobId)}`);
}

export async function listApps(namespace?: string): Promise<AppSummary[]> {
  if (USE_MOCKS) {
    return mockListApps();
  }
  const query = namespace
    ? `?namespace=${encodeURIComponent(namespace)}`
    : "";
  return request<AppSummary[]>(`/apps${query}`);
}

export async function health(): Promise<{ status: string }> {
  return request<{ status: string }>("/health", { auth: false });
}

export async function listJobs(): Promise<DeployJob[]> {
  return request<DeployJob[]>("/deploy-jobs");
}

export async function listProjects(): Promise<ProjectSummary[]> {
  return request<ProjectSummary[]>("/api/v1/projects");
}

export async function getProject(deploymentId: string): Promise<ProjectSummary> {
  return request<ProjectSummary>(`/api/v1/projects/${encodeURIComponent(deploymentId)}`);
}

export async function redeployProject(deploymentId: string, input: DeployInput): Promise<DeployJob> {
  return request<DeployJob>(`/api/v1/projects/${encodeURIComponent(deploymentId)}/redeploy`, {
    method: "POST",
    body: input,
  });
}

export async function registerProjectCicd(deploymentId: string, githubToken?: string): Promise<{ status: string; job?: DeployJob }> {
  return request<{ status: string; job?: DeployJob }>(`/api/v1/projects/${encodeURIComponent(deploymentId)}/cicd/register`, {
    method: "POST",
    body: { github_token: githubToken || null },
  });
}

export async function getAppStatus(
  namespace: string,
  appName: string
): Promise<AppStatus> {
  return request<AppStatus>(
    `/apps/${encodeURIComponent(namespace)}/${encodeURIComponent(appName)}`
  );
}

export async function getRuntimeLogs(
  namespace: string,
  appName: string,
  tailLines = 160
): Promise<RuntimeLogBundle> {
  return request<RuntimeLogBundle>(
    `/apps/${encodeURIComponent(namespace)}/${encodeURIComponent(
      appName
    )}/runtime-logs?tail_lines=${encodeURIComponent(String(tailLines))}`
  );
}

export async function getContainerLogs(input: {
  namespace: string;
  appName: string;
  podName: string;
  containerName: string;
  tailLines?: number;
  previous?: boolean;
}): Promise<{ logs: string }> {
  const query = new URLSearchParams({
    tail_lines: String(input.tailLines ?? 200),
    previous: String(Boolean(input.previous)),
  });
  return request<{ logs: string }>(
    `/apps/${encodeURIComponent(input.namespace)}/${encodeURIComponent(
      input.appName
    )}/pods/${encodeURIComponent(input.podName)}/containers/${encodeURIComponent(
      input.containerName
    )}/logs?${query.toString()}`
  );
}
