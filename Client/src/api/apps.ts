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
  AppSummary,
  DeployInput,
  DeployJob,
} from "./types";

export interface AnalyzeInput {
  github_url: string;
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
