export type FlowStep =
  | "landing"
  | "onboarding"
  | "source"
  | "intelligence"
  | "blueprint"
  | "ignition"
  | "dashboard";

export type DeploymentStatus = "queued" | "provisioning" | "building" | "routing" | "ready" | "failed";

export type ServiceKind =
  | "nextjs"
  | "react"
  | "node"
  | "python"
  | "go"
  | "php"
  | "java"
  | "postgres"
  | "redis"
  | "worker"
  | "static"
  | "unknown";

export type ManagedDependencyKind = "postgres" | "mysql" | "mongodb" | "redis" | "rabbitmq";

export type InstanceSize = "nano" | "micro" | "standard" | "performance";

export interface WorkspaceDraft {
  name: string;
  plan: "starter" | "pro" | "scale";
}

export interface RepositorySummary {
  id: string;
  fullName: string;
  url: string;
  defaultBranch: string;
  private: boolean;
  language?: string;
  updatedAt?: string;
  isMonorepo?: boolean;
}

export interface EnvVarPair {
  id: string;
  key: string;
  value: string;
  secret: boolean;
  source?: string;
  evidence?: string[];
}

export interface AutoEnvVar {
  key: string;
  source: string;
  secret: boolean;
  evidence?: string[];
}

export interface ServiceDependency {
  type: ManagedDependencyKind;
  confidence: string;
  evidence: string[];
  provision: boolean;
}

export interface ServiceCommunication {
  id: string;
  sourceServiceId: string;
  targetServiceId: string;
  sourceName: string;
  targetName: string;
  envNames: string[];
  confidence: "high" | "medium" | "low";
  evidence: string[];
}

export interface DetectedService {
  id: string;
  name: string;
  deploy: boolean;
  kind: ServiceKind;
  path: string;
  port?: number;
  confidence: "high" | "medium" | "low";
  framework?: string;
  buildCommand?: string;
  outputDirectory?: string;
  env: EnvVarPair[];
  instanceSize: InstanceSize;
  monthlyEstimateUsd: number;
  dependencies: ServiceDependency[];
  automaticEnv: AutoEnvVar[];
  communicationEnv: AutoEnvVar[];
  warnings: string[];
}

export interface DeploymentEvent {
  id: string;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error" | "success";
  message: string;
  serviceId?: string;
  ansi?: string;
}

export interface DeploymentProgress {
  deploymentId?: string;
  status: DeploymentStatus;
  currentStep: number;
  productionUrl?: string;
  events: DeploymentEvent[];
}
