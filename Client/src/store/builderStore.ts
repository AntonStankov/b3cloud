import { create } from "zustand";
import { analyze, deploy, getJob } from "../api/apps";
import type { DeployJob, ResourceLimits } from "../api/types";
import {
  createPaletteElement,
  fromAnalyze,
  KIND_META,
  type ElementKind,
  type GraphEdge,
  type InfraElement,
} from "../domain/elements";
import type { ComponentDeployInput, DeployInput } from "../api/types";

export type BuilderStatus = "idle" | "analyzing" | "ready" | "error";

export interface XY {
  x: number;
  y: number;
}

interface BuilderState {
  projectId: string | null;
  githubUrl: string;
  gitRevision: string;
  status: BuilderStatus;
  analyzeError: string | null;

  elements: InfraElement[];
  edges: GraphEdge[];
  positions: Record<string, XY>;
  selectedId: string | null;

  deployJobId: string | null;
  job: DeployJob | null;
  deployError: string | null;
  nodeArch: "any" | "amd64" | "arm64";
  redeployServices: boolean;
  globalEnvJson: string;
  resourceLimits: ResourceLimits;

  loadProject: (projectId: string, githubUrl: string, revision?: string) => Promise<void>;
  startDeploy: () => Promise<void>;
  setDeployOption: <K extends "nodeArch" | "redeployServices" | "globalEnvJson" | "resourceLimits">(
    key: K,
    value: BuilderState[K]
  ) => void;
  select: (id: string | null) => void;
  updateElement: (id: string, patch: Partial<InfraElement>) => void;
  updateEnvValue: (id: string, name: string, value: string) => void;
  addElement: (kind: ElementKind, position?: XY) => void;
  removeElement: (id: string) => void;
  setPosition: (id: string, position: XY) => void;
  refreshJob: () => Promise<void>;
  reset: () => void;
}

function layout(elements: InfraElement[]): Record<string, XY> {
  const positions: Record<string, XY> = {};
  const columns: Record<"compute" | "data" | "storage", number> = {
    compute: 0,
    data: 0,
    storage: 0,
  };
  const columnX = { compute: 80, data: 460, storage: 840 };
  for (const element of elements) {
    const category = KIND_META[element.kind].category;
    const index = columns[category];
    positions[element.id] = {
      x: columnX[category],
      y: 80 + index * 150,
    };
    columns[category] += 1;
  }
  return positions;
}

function toDeployInput(state: {
  githubUrl: string;
  gitRevision: string;
  elements: InfraElement[];
  nodeArch: "any" | "amd64" | "arm64";
  redeployServices: boolean;
  globalEnvJson: string;
  resourceLimits: ResourceLimits;
}): DeployInput {
  const componentElements = state.elements.filter(
    (element) => element.componentType
  );
  const components: ComponentDeployInput[] = componentElements.map((element) => {
    const env: Record<string, string> = {};
    for (const item of element.env) {
      if (!item.platformManaged && item.value.trim() !== "") {
        env[item.name] = item.value;
      }
    }
    return {
      name: element.label,
      path: element.path ?? ".",
      type: element.componentType!,
      public: element.public,
      port: element.port ?? 8080,
      auto_detect_services: element.componentType !== "frontend",
      provision_services: element.serviceTypes,
      redeploy_services: state.redeployServices,
      env,
    };
  });
  const globalEnv = parseJsonObject(state.globalEnvJson, "Global environment JSON");

  return {
    github_url: state.githubUrl,
    git_revision: state.gitRevision,
    port: 8080,
    node_arch: state.nodeArch === "any" ? null : state.nodeArch,
    auto_detect_services: true,
    provision_services: [],
    redeploy_services: state.redeployServices,
    components,
    env: globalEnv,
    resources: state.resourceLimits,
    autoscaling: {
      enabled: true,
      min_replicas: 1,
      max_replicas: 5,
      target_cpu_utilization: 80,
      target_memory_utilization: 80,
    },
  };
}

export const useBuilderStore = create<BuilderState>((set, get) => ({
  projectId: null,
  githubUrl: "",
  gitRevision: "main",
  status: "idle",
  analyzeError: null,

  elements: [],
  edges: [],
  positions: {},
  selectedId: null,

  deployJobId: null,
  job: null,
  deployError: null,
  nodeArch: "any",
  redeployServices: false,
  globalEnvJson: "",
  resourceLimits: {
    cpu_request: "100m",
    cpu_limit: "500m",
    memory_request: "128Mi",
    memory_limit: "512Mi",
  },

  async loadProject(projectId, githubUrl, revision = "main") {
    // Avoid re-running if the same project is already loaded.
    if (
      get().projectId === projectId &&
      get().status !== "idle" &&
      get().status !== "error"
    ) {
      return;
    }
    set({
      projectId,
      githubUrl,
      gitRevision: revision,
      status: "analyzing",
      analyzeError: null,
      elements: [],
      edges: [],
      positions: {},
      selectedId: null,
      job: null,
      deployJobId: null,
      deployError: null,
    });

    try {
      const analysis = await analyze({ github_url: githubUrl, git_revision: revision });
      const graph = fromAnalyze(analysis);
      const positions = layout(graph.elements);
      set({
        elements: graph.elements,
        edges: graph.edges,
        positions,
        status: "ready",
      });

    } catch (error) {
      set({ status: "error", analyzeError: errorMessage(error) });
    }
  },

  async startDeploy() {
    const state = get();
    if (!state.githubUrl || state.elements.length === 0) return;
    set({ deployError: null });
    try {
      const job = await deploy(
        toDeployInput({
          githubUrl: state.githubUrl,
          gitRevision: state.gitRevision,
          elements: state.elements,
          nodeArch: state.nodeArch,
          redeployServices: state.redeployServices,
          globalEnvJson: state.globalEnvJson,
          resourceLimits: state.resourceLimits,
        })
      );
      set({
        deployJobId: job.job_id,
        job,
        elements: get().elements.map((el) =>
          el.deployable ? { ...el, status: "deploying" } : el
        ),
      });
    } catch (error) {
      set({ deployError: errorMessage(error) });
    }
  },

  setDeployOption(key, value) {
    set({ [key]: value } as Pick<BuilderState, typeof key>);
  },

  select(id) {
    set({ selectedId: id });
  },

  updateElement(id, patch) {
    set({
      elements: get().elements.map((element) =>
        element.id === id ? { ...element, ...patch } : element
      ),
    });
  },

  updateEnvValue(id, name, value) {
    set({
      elements: get().elements.map((element) =>
        element.id === id
          ? {
              ...element,
              env: element.env.map((item) =>
                item.name === name ? { ...item, value } : item
              ),
            }
          : element
      ),
    });
  },

  addElement(kind, position) {
    const element = createPaletteElement(kind);
    const pos = position ?? { x: 460, y: 80 + get().elements.length * 40 };
    set({
      elements: [...get().elements, element],
      positions: { ...get().positions, [element.id]: pos },
      selectedId: element.id,
    });
  },

  removeElement(id) {
    const positions = { ...get().positions };
    delete positions[id];
    set({
      elements: get().elements.filter((element) => element.id !== id),
      edges: get().edges.filter(
        (edge) => edge.source !== id && edge.target !== id
      ),
      positions,
      selectedId: get().selectedId === id ? null : get().selectedId,
    });
  },

  setPosition(id, position) {
    set({ positions: { ...get().positions, [id]: position } });
  },

  async refreshJob() {
    const jobId = get().deployJobId;
    if (!jobId) return;
    try {
      const job = await getJob(jobId);
      const done = job.status === "succeeded";
      const failed = job.status === "failed";
      set({
        job,
        elements: get().elements.map((el) => {
          if (!el.deployable) return el;
          if (done) return { ...el, status: "deployed" };
          if (failed) return { ...el, status: "error" };
          return el;
        }),
      });
    } catch (error) {
      set({ deployError: errorMessage(error) });
    }
  },

  reset() {
    set({
      projectId: null,
      githubUrl: "",
      status: "idle",
      elements: [],
      edges: [],
      positions: {},
      selectedId: null,
      deployJobId: null,
      job: null,
      analyzeError: null,
      deployError: null,
      nodeArch: "any",
      redeployServices: false,
      globalEnvJson: "",
      resourceLimits: {
        cpu_request: "100m",
        cpu_limit: "500m",
        memory_request: "128Mi",
        memory_limit: "512Mi",
      },
    });
  },
}));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJsonObject(raw: string, label: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const parsed = JSON.parse(trimmed);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${label} must be a JSON object.`);
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, String(value)])
  );
}
