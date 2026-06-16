import { createContext, Dispatch, ReactNode, useContext, useMemo, useReducer } from "react";
import type {
  DetectedService,
  DeploymentEvent,
  DeploymentProgress,
  FlowStep,
  RepositorySummary,
  ServiceCommunication,
  WorkspaceDraft,
} from "../types";

interface DeploymentFlowState {
  step: FlowStep;
  isNewUser: boolean;
  workspace: WorkspaceDraft;
  repositories: RepositorySummary[];
  selectedRepository: RepositorySummary | null;
  services: DetectedService[];
  communications: ServiceCommunication[];
  selectedServiceId: string | null;
  deployment: DeploymentProgress;
}

type DeploymentFlowAction =
  | { type: "SET_STEP"; step: FlowStep }
  | { type: "SET_NEW_USER"; isNewUser: boolean }
  | { type: "UPDATE_WORKSPACE"; patch: Partial<WorkspaceDraft> }
  | { type: "SET_REPOSITORIES"; repositories: RepositorySummary[] }
  | { type: "SELECT_REPOSITORY"; repository: RepositorySummary }
  | { type: "SET_SERVICES"; services: DetectedService[]; communications?: ServiceCommunication[] }
  | { type: "SELECT_SERVICE"; serviceId: string }
  | { type: "UPDATE_SERVICE"; serviceId: string; patch: Partial<DetectedService> }
  | { type: "APPEND_DEPLOYMENT_EVENT"; event: DeploymentEvent }
  | { type: "SET_DEPLOYMENT"; deployment: Partial<DeploymentProgress> };

const initialState: DeploymentFlowState = {
  step: "landing",
  isNewUser: false,
  workspace: { name: "", plan: "starter" },
  repositories: [],
  selectedRepository: null,
  services: [],
  communications: [],
  selectedServiceId: null,
  deployment: { status: "queued", currentStep: 0, events: [] },
};

function reducer(state: DeploymentFlowState, action: DeploymentFlowAction): DeploymentFlowState {
  switch (action.type) {
    case "SET_STEP":
      return { ...state, step: action.step };
    case "SET_NEW_USER":
      return { ...state, isNewUser: action.isNewUser };
    case "UPDATE_WORKSPACE":
      return { ...state, workspace: { ...state.workspace, ...action.patch } };
    case "SET_REPOSITORIES":
      return { ...state, repositories: action.repositories };
    case "SELECT_REPOSITORY":
      return { ...state, selectedRepository: action.repository, step: "intelligence" };
    case "SET_SERVICES":
      return {
        ...state,
        services: action.services,
        communications: action.communications ?? [],
        selectedServiceId: action.services[0]?.id ?? null,
        step: "blueprint",
      };
    case "SELECT_SERVICE":
      return { ...state, selectedServiceId: action.serviceId };
    case "UPDATE_SERVICE":
      return {
        ...state,
        services: state.services.map((service) =>
          service.id === action.serviceId ? { ...service, ...action.patch } : service
        ),
      };
    case "APPEND_DEPLOYMENT_EVENT":
      return {
        ...state,
        deployment: {
          ...state.deployment,
          events: [...state.deployment.events, action.event].slice(-1000),
        },
      };
    case "SET_DEPLOYMENT":
      return { ...state, deployment: { ...state.deployment, ...action.deployment } };
    default:
      return state;
  }
}

const DeploymentFlowContext = createContext<
  { state: DeploymentFlowState; dispatch: Dispatch<DeploymentFlowAction> } | undefined
>(undefined);

export function DeploymentFlowProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <DeploymentFlowContext.Provider value={value}>{children}</DeploymentFlowContext.Provider>;
}

export function useDeploymentFlow() {
  const context = useContext(DeploymentFlowContext);
  if (!context) {
    throw new Error("useDeploymentFlow must be used inside DeploymentFlowProvider");
  }
  return context;
}
