import type {
  AnalyzeResult,
  AnalyzedComponent,
  ComponentType,
  ResourceLimits,
  ServiceType,
} from "../api/types";

export type ElementKind =
  | "web"
  | "api"
  | "worker"
  | "database"
  | "cache"
  | "broker"
  | "bucket";

export type ElementStatus = "draft" | "deploying" | "deployed" | "error";

export interface EnvVar {
  name: string;
  required: boolean;
  secret: boolean;
  platformManaged: boolean;
  source: string;
  evidence: string[];
  value: string;
}

export interface InfraElement {
  id: string;
  kind: ElementKind;
  label: string;
  /** Backend path for components (e.g. "server", "web"). */
  path?: string;
  public: boolean;
  port?: number;
  portConfidence?: string;
  env: EnvVar[];
  resources: ResourceLimits;
  /** Backing services this component depends on (for components). */
  serviceTypes: ServiceType[];
  /** DB-only mock config. */
  migrations?: { enabled: boolean; command: string };
  /** Bucket-only mock config. */
  bucket?: { name: string; region: string };
  /** Whether this element maps to something the backend can deploy today. */
  deployable: boolean;
  status: ElementStatus;
  /** Original component type for components, used to rebuild deploy payload. */
  componentType?: ComponentType;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface InfraGraph {
  elements: InfraElement[];
  edges: GraphEdge[];
}

interface KindMeta {
  label: string;
  icon: string;
  category: "compute" | "data" | "storage";
  blurb: string;
}

export const KIND_META: Record<ElementKind, KindMeta> = {
  web: {
    label: "Web Frontend",
    icon: "globe",
    category: "compute",
    blurb: "Static or SSR frontend served publicly.",
  },
  api: {
    label: "API Service",
    icon: "server",
    category: "compute",
    blurb: "Backend HTTP service.",
  },
  worker: {
    label: "Worker",
    icon: "cpu",
    category: "compute",
    blurb: "Background processor, internal only.",
  },
  database: {
    label: "Database",
    icon: "database",
    category: "data",
    blurb: "Managed SQL/NoSQL database.",
  },
  cache: {
    label: "Cache",
    icon: "bolt",
    category: "data",
    blurb: "In-memory cache / key-value store.",
  },
  broker: {
    label: "Message Broker",
    icon: "queue",
    category: "data",
    blurb: "Async message queue.",
  },
  bucket: {
    label: "Object Storage",
    icon: "bucket",
    category: "storage",
    blurb: "S3-compatible bucket (coming soon).",
  },
};

const DEFAULT_RESOURCES: ResourceLimits = {
  cpu_request: "100m",
  cpu_limit: "500m",
  memory_request: "128Mi",
  memory_limit: "512Mi",
};

const COMPONENT_KIND: Record<ComponentType, ElementKind> = {
  frontend: "web",
  backend: "api",
  worker: "worker",
};

const SERVICE_KIND: Record<ServiceType, ElementKind> = {
  postgres: "database",
  mysql: "database",
  mongodb: "database",
  redis: "cache",
  rabbitmq: "broker",
};

const SERVICE_LABEL: Record<ServiceType, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mongodb: "MongoDB",
  redis: "Redis",
  rabbitmq: "RabbitMQ",
};

function componentToElement(component: AnalyzedComponent): InfraElement {
  return {
    id: `component:${component.path}`,
    kind: COMPONENT_KIND[component.type],
    label: component.name,
    path: component.path,
    public: component.public,
    port: component.port,
    portConfidence: component.port_confidence,
    env: component.env.map((item) => ({
      name: item.name,
      required: item.required,
      secret: item.secret,
      platformManaged: item.platform_managed,
      source: item.source,
      evidence: item.evidence,
      value: "",
    })),
    resources: { ...DEFAULT_RESOURCES },
    serviceTypes: component.services.map((s) => s.type),
    deployable: true,
    status: "draft",
    componentType: component.type,
  };
}

function serviceToElement(type: ServiceType): InfraElement {
  const kind = SERVICE_KIND[type];
  return {
    id: `service:${type}`,
    kind,
    label: SERVICE_LABEL[type],
    public: false,
    env: [],
    resources: { ...DEFAULT_RESOURCES },
    serviceTypes: [],
    migrations:
      kind === "database"
        ? { enabled: false, command: "npm run migrate" }
        : undefined,
    deployable: true,
    status: "draft",
  };
}

/** Build the initial infra graph from an analyze response. */
export function fromAnalyze(result: AnalyzeResult): InfraGraph {
  const elements: InfraElement[] = [];
  const edges: GraphEdge[] = [];

  const serviceTypes = new Set<ServiceType>();
  for (const service of result.services) serviceTypes.add(service.type);
  for (const component of result.components) {
    for (const service of component.services) serviceTypes.add(service.type);
  }

  const componentElements = result.components.map(componentToElement);
  elements.push(...componentElements);

  const serviceElements = [...serviceTypes].map(serviceToElement);
  elements.push(...serviceElements);

  for (const component of result.components) {
    const sourceId = `component:${component.path}`;
    for (const service of component.services) {
      edges.push({
        id: `${sourceId}->service:${service.type}`,
        source: sourceId,
        target: `service:${service.type}`,
      });
    }
  }

  return { elements, edges };
}

let bucketCounter = 0;

/** Create a fresh palette element (used when dragging new items onto canvas). */
export function createPaletteElement(kind: ElementKind): InfraElement {
  if (kind === "bucket") {
    bucketCounter += 1;
    return {
      id: `bucket:${bucketCounter}-${Date.now()}`,
      kind: "bucket",
      label: `Bucket ${bucketCounter}`,
      public: false,
      env: [],
      resources: { ...DEFAULT_RESOURCES },
      serviceTypes: [],
      bucket: { name: "", region: "fsn1" },
      deployable: false,
      status: "draft",
    };
  }

  const id = `${kind}:${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const base: InfraElement = {
    id,
    kind,
    label: KIND_META[kind].label,
    public: kind === "web" || kind === "api",
    port: kind === "worker" ? 8080 : 8080,
    portConfidence: "default",
    env: [],
    resources: { ...DEFAULT_RESOURCES },
    serviceTypes: [],
    deployable: true,
    status: "draft",
    componentType:
      kind === "web" ? "frontend" : kind === "api" ? "backend" : "worker",
  };
  if (kind === "database") {
    base.migrations = { enabled: false, command: "npm run migrate" };
  }
  return base;
}
