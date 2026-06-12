import type {
  AnalyzeResult,
  AnalyzedComponent,
  AppSummary,
  DeployInput,
  DeployJob,
  EnvRequirement,
  ServiceRequirement,
} from "../types";

// In-memory simulation of the analyze + async deploy job flow so the full
// builder experience works without a live backend. Logs intentionally match
// the phrases the real platform emits (platform_core.py) so the progress
// timeline behaves identically when wired to the real API.

const CLUSTER_DOMAIN = "apps.b3cloud.dev";

function sanitizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export function repoNameFromUrl(githubUrl: string): string {
  const normalized = githubUrl.replace(/\/+$/, "");
  const match = normalized.match(/\/([^/]+?)(?:\.git)?$/);
  return match ? match[1] : "app";
}

function env(
  name: string,
  required: boolean,
  opts: Partial<EnvRequirement> = {}
): EnvRequirement {
  return {
    name,
    required,
    source: opts.source ?? ".env.example",
    evidence: opts.evidence ?? [`${name} referenced in source`],
    secret: opts.secret ?? /SECRET|TOKEN|KEY|PASSWORD|API/.test(name),
    platform_managed: opts.platform_managed ?? false,
  };
}

function service(
  type: ServiceRequirement["type"],
  confidence = "high"
): ServiceRequirement {
  return {
    type,
    confidence,
    evidence: [`package/config keywords reference ${type}`],
    provision: true,
  };
}

export function mockAnalyze(input: {
  github_url: string;
  git_revision?: string;
}): Promise<AnalyzeResult> {
  const repo = repoNameFromUrl(input.github_url);
  const safe = sanitizeName(repo);

  const services = [service("postgres"), service("redis")];

  const backend: AnalyzedComponent = {
    name: "api",
    path: "server",
    type: "backend",
    public: true,
    port: 8080,
    port_confidence: "high",
    port_evidence: ["Dockerfile: EXPOSE 8080"],
    env: [
      env("JWT_SECRET", true),
      env("STRIPE_API_KEY", true),
      env("LOG_LEVEL", false, { secret: false }),
      env("DATABASE_URL", true, { platform_managed: true }),
      env("REDIS_URL", true, { platform_managed: true }),
    ],
    services,
    evidence: ["backend JavaScript dependencies"],
  };

  const frontend: AnalyzedComponent = {
    name: "web",
    path: "web",
    type: "frontend",
    public: true,
    port: 8080,
    port_confidence: "default",
    port_evidence: ["No explicit port found; static default 8080."],
    env: [
      env("VITE_API_URL", true, { platform_managed: true, secret: false }),
      env("VITE_ANALYTICS_ID", false, { secret: false }),
    ],
    services: [],
    evidence: ["frontend JavaScript dependencies"],
  };

  const worker: AnalyzedComponent = {
    name: "worker",
    path: "worker",
    type: "worker",
    public: false,
    port: 8080,
    port_confidence: "default",
    port_evidence: ["No explicit port found; platform default is 8080."],
    env: [env("QUEUE_CONCURRENCY", false, { secret: false })],
    services: [service("redis")],
    evidence: ["Python project"],
  };

  const result: AnalyzeResult = {
    github_url: input.github_url,
    git_revision: input.git_revision ?? "main",
    app_path: "server",
    services,
    components: [frontend, backend, worker],
    repo_name: repo,
    app_name: safe,
    namespace: safe,
    domain: `${safe}.${CLUSTER_DOMAIN}`,
    registry_repo: `ghcr.io/b3cloud`,
  };

  return delay(900).then(() => result);
}

interface ScriptStep {
  atMs: number;
  message: string;
}

interface SimJob {
  job: DeployJob;
  startedAt: number;
  script: ScriptStep[];
  durationMs: number;
}

const jobs = new Map<string, SimJob>();

function buildScript(input: DeployInput): ScriptStep[] {
  const components = input.components.length
    ? input.components
    : [{ name: input.github_url, type: "backend" } as { name: string }];
  const steps: ScriptStep[] = [
    { atMs: 0, message: "Job queued." },
    { atMs: 600, message: "Deploy job started." },
  ];
  let cursor = 1200;
  for (const component of components) {
    steps.push({
      atMs: cursor,
      message: `Deploying component ${component.name}.`,
    });
    steps.push({
      atMs: cursor + 600,
      message: "Analyzing repository for backing service requirements.",
    });
    steps.push({
      atMs: cursor + 1200,
      message: "Detected services: postgres, redis.",
    });
    steps.push({
      atMs: cursor + 1800,
      message: `Preparing namespace for ${component.name}.`,
    });
    steps.push({
      atMs: cursor + 2400,
      message: "Provisioning internal backing services: postgres, redis.",
    });
    steps.push({
      atMs: cursor + 3000,
      message: "Logging in to registry ghcr.io.",
    });
    steps.push({
      atMs: cursor + 3600,
      message: "Cloning source repo and using app path.",
    });
    steps.push({
      atMs: cursor + 4200,
      message: "Running Buildpacks publish to ghcr.io/b3cloud.",
    });
    steps.push({ atMs: cursor + 5400, message: "Image published." });
    steps.push({
      atMs: cursor + 6000,
      message: "Applying Kubernetes Deployment/Service/Ingress.",
    });
    steps.push({
      atMs: cursor + 6400,
      message: "Ensuring Cloudflare route.",
    });
    cursor += 6800;
  }
  steps.push({ atMs: cursor, message: "Deploy job finished successfully." });
  return steps;
}

export function mockDeploy(input: DeployInput): Promise<DeployJob> {
  const jobId =
    "mock-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const script = buildScript(input);
  const durationMs = script[script.length - 1].atMs + 400;

  const job: DeployJob = {
    job_id: jobId,
    status: "queued",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    github_url: input.github_url,
    logs: ["Job queued."],
    result: null,
    error: null,
  };

  jobs.set(jobId, { job, startedAt: Date.now(), script, durationMs });
  return delay(300).then(() => ({ ...job, logs: [...job.logs] }));
}

export function mockGetJob(jobId: string): Promise<DeployJob> {
  const sim = jobs.get(jobId);
  if (!sim) {
    return Promise.reject(new Error(`Deploy job not found: ${jobId}`));
  }
  const elapsed = Date.now() - sim.startedAt;
  const logs = sim.script
    .filter((step) => step.atMs <= elapsed)
    .map((step) => step.message);

  let status: DeployJob["status"] = "running";
  let result: DeployJob["result"] = null;
  if (elapsed >= sim.durationMs) {
    status = "succeeded";
    result = {
      namespace: sim.job.namespace ?? "demo",
      status: "deployed",
      url: `https://${repoNameFromUrl(sim.job.github_url ?? "app")}.${CLUSTER_DOMAIN}`,
    };
  } else if (elapsed < 600) {
    status = "queued";
  }

  const updated: DeployJob = {
    ...sim.job,
    status,
    result,
    logs: logs.length ? logs : ["Job queued."],
    updated_at: new Date().toISOString(),
  };
  sim.job = updated;
  return delay(120).then(() => ({ ...updated, logs: [...updated.logs] }));
}

export function mockListApps(): Promise<AppSummary[]> {
  const apps: AppSummary[] = [];
  for (const { job } of jobs.values()) {
    if (job.status === "succeeded") {
      apps.push({
        namespace: job.namespace ?? "demo",
        app_name: job.app_name ?? repoNameFromUrl(job.github_url ?? "app"),
        replicas: "1",
        ready_replicas: "1",
        image: "ghcr.io/b3cloud/app:latest",
      });
    }
  }
  return delay(150).then(() => apps);
}

function delay<T = void>(ms: number, value?: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value as T), ms));
}
