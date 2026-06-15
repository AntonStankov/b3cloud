// Types mirrored from the b3cloud user API (user_api.py / platform_core.py).

export type ServiceType =
  | "postgres"
  | "mysql"
  | "mongodb"
  | "redis"
  | "rabbitmq";

export type ComponentType = "frontend" | "backend" | "worker";

export interface EnvRequirement {
  name: string;
  required: boolean;
  source: string;
  evidence: string[];
  secret: boolean;
  platform_managed: boolean;
}

export interface ServiceRequirement {
  type: ServiceType;
  confidence: string;
  evidence: string[];
  provision: boolean;
}

export interface AnalyzedComponent {
  name: string;
  path: string;
  type: ComponentType;
  public: boolean;
  port: number;
  port_confidence: string;
  port_evidence: string[];
  env: EnvRequirement[];
  services: ServiceRequirement[];
  evidence: string[];
}

export interface AnalyzeResult {
  github_url: string;
  git_revision: string;
  app_path: string;
  services: ServiceRequirement[];
  components: AnalyzedComponent[];
  // defaults_from_github_url merges these in on the server:
  repo_name?: string;
  app_name?: string;
  namespace?: string;
  domain?: string;
  registry_repo?: string;
}

export interface ResourceLimits {
  cpu_request: string;
  cpu_limit: string;
  memory_request: string;
  memory_limit: string;
}

export interface AutoscalingInput {
  enabled: boolean;
  min_replicas: number;
  max_replicas: number;
  target_cpu_utilization: number;
  target_memory_utilization: number;
}

export interface ComponentDeployInput {
  name: string;
  path: string;
  type: ComponentType;
  public: boolean;
  port: number;
  auto_detect_services: boolean;
  provision_services: string[];
  redeploy_services?: boolean;
  autoscaling?: AutoscalingInput | null;
  env: Record<string, string>;
}

export interface DeployInput {
  github_url: string;
  github_token?: string;
  git_revision: string;
  port: number;
  node_arch: string | null;
  auto_detect_services: boolean;
  provision_services: string[];
  redeploy_services?: boolean;
  components: ComponentDeployInput[];
  env: Record<string, string>;
  resources: ResourceLimits;
  autoscaling?: AutoscalingInput;
}

export type DeployJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "submitting";

export interface RuntimeFailureContainer {
  name: string;
  ready: boolean;
  restarts: number;
  state: string;
  current_logs: string;
  previous_logs: string;
  error_line: string;
}

export interface RuntimeFailurePod {
  name: string;
  phase: string;
  containers: RuntimeFailureContainer[];
}

export interface RuntimeFailureEvent {
  type: string;
  reason: string;
  message: string;
  object: string;
  timestamp: string;
}

export interface RuntimeFailure {
  namespace: string;
  deployment_name: string;
  summary: string;
  pods: RuntimeFailurePod[];
  events: RuntimeFailureEvent[];
}

export interface DeployJob {
  job_id: string;
  status: DeployJobStatus;
  created_at?: string;
  updated_at?: string;
  github_url?: string;
  namespace?: string;
  app_name?: string;
  domain?: string;
  logs: string[];
  result: Record<string, unknown> | null;
  error: string | null;
  failure_summary?: string;
  runtime_failure?: RuntimeFailure;
}

export interface AppSummary {
  namespace: string;
  app_name: string;
  replicas: string;
  ready_replicas: string;
  image: string;
}

export interface AppStatus extends AppSummary {
  deployment_name?: string;
  status: string;
  autoscaling?: Record<string, unknown>;
}

export interface RuntimeContainerLog {
  name: string;
  ready: boolean;
  restarts: number;
  state: string;
  current_logs: string;
  previous_logs?: string;
  error_line?: string;
}

export interface RuntimePodLog {
  name: string;
  phase: string;
  containers: RuntimeContainerLog[];
}

export interface RuntimeLogBundle {
  namespace: string;
  app_name: string;
  component_name?: string;
  status: string;
  ready_replicas: number;
  replicas: number;
  pods: RuntimePodLog[];
  error_summary?: string;
}
