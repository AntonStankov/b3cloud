import { useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import clsx from "clsx";
import type { DetectedService, ManagedDependencyKind, ServiceCommunication } from "../types";
import { serviceTone } from "../lib/servicePresentation";

interface ArchitectureGraphProps {
  services: DetectedService[];
  communications: ServiceCommunication[];
  selectedServiceId: string | null;
  selectedDependency: ManagedDependencyKind | null;
  onSelectService: (serviceId: string) => void;
  onSelectDependency: (dependency: ManagedDependencyKind) => void;
  onToggleDeploy: (serviceId: string, deploy: boolean) => void;
}

interface ServiceNodeData extends Record<string, unknown> {
  service: DetectedService;
  selected: boolean;
  onToggleDeploy: (serviceId: string, deploy: boolean) => void;
}

interface DependencyNodeData extends Record<string, unknown> {
  type: ManagedDependencyKind;
  label: string;
  selected: boolean;
  mode: "managed" | "external" | "mixed";
}

const dependencyLabels: Record<ManagedDependencyKind, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mongodb: "MongoDB",
  redis: "Redis",
  rabbitmq: "RabbitMQ",
};

const dependencyTone: Record<ManagedDependencyKind, string> = {
  postgres: "from-blue-300 to-indigo-500",
  mysql: "from-orange-300 to-amber-500",
  mongodb: "from-emerald-300 to-green-500",
  redis: "from-red-300 to-rose-500",
  rabbitmq: "from-amber-300 to-yellow-500",
};

const nodeTypes = {
  service: ServiceNode,
  dependency: DependencyNode,
};

export function ArchitectureGraph(props: ArchitectureGraphProps) {
  return (
    <ReactFlowProvider>
      <ArchitectureGraphInner {...props} />
    </ReactFlowProvider>
  );
}

function ArchitectureGraphInner({ services, communications, selectedServiceId, selectedDependency, onSelectService, onSelectDependency, onToggleDeploy }: ArchitectureGraphProps) {
  const baseNodes = useMemo(() => buildNodes(services, selectedServiceId, selectedDependency, onToggleDeploy), [services, selectedServiceId, selectedDependency, onToggleDeploy]);
  const [nodes, setNodes] = useState<Node[]>(baseNodes);

  useEffect(() => {
    setNodes((current) =>
      baseNodes.map((next) => ({
        ...next,
        position: current.find((node) => node.id === next.id)?.position ?? next.position,
      }))
    );
  }, [baseNodes]);

  const edges = useMemo(() => buildEdges(services, communications), [services, communications]);
  const visibleCommunications = communications.filter((link) =>
    services.some((service) => service.id === link.sourceServiceId && service.deploy) &&
    services.some((service) => service.id === link.targetServiceId && service.deploy)
  );

  function onNodesChange(changes: NodeChange[]) {
    setNodes((current) => applyNodeChanges(changes, current));
  }

  return (
    <section className="mb-5 overflow-hidden rounded-[32px] border border-white/5 bg-[#0B0B0F]/75 shadow-tactile">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/5 bg-white/[0.025] px-5 py-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-cyan-200/60">Architecture graph</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.05em] text-white">Detected runtime topology.</h2>
          <p className="mt-1 text-sm leading-6 text-white/45">Drag nodes to organize the monorepo. Cyan links are service-to-service communication; dim links are managed dependencies.</p>
        </div>
        <div className="rounded-2xl border border-white/5 bg-white/[0.035] px-4 py-3 font-mono text-xs text-white/55">
          {visibleCommunications.length} communication link{visibleCommunications.length === 1 ? "" : "s"}
        </div>
      </div>
      <div className="h-[460px]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => {
            if (node.type === "service") onSelectService(node.id);
            if (node.type === "dependency" && typeof node.data.type === "string") {
              onSelectDependency(node.data.type as ManagedDependencyKind);
            }
          }}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          minZoom={0.35}
          maxZoom={1.4}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={22} size={1} color="rgba(255,255,255,0.08)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
    </section>
  );
}

function buildNodes(services: DetectedService[], selectedServiceId: string | null, selectedDependency: ManagedDependencyKind | null, onToggleDeploy: ArchitectureGraphProps["onToggleDeploy"]): Node[] {
  const serviceNodes = services.map((service, index) => ({
    id: service.id,
    type: "service",
    position: {
      x: service.kind === "react" || service.kind === "nextjs" || service.kind === "static" ? 40 : 380 + (index % 2) * 280,
      y: 80 + index * 118,
    },
    data: { service, selected: selectedServiceId === service.id, onToggleDeploy } satisfies ServiceNodeData,
  }));

  const dependencyModes = new Map<ManagedDependencyKind, { managed: number; external: number }>();
  for (const service of services) {
    if (!service.deploy) continue;
    for (const dependency of service.dependencies) {
      const current = dependencyModes.get(dependency.type) ?? { managed: 0, external: 0 };
      if (dependency.provision) current.managed += 1;
      else current.external += 1;
      dependencyModes.set(dependency.type, current);
    }
  }

  const dependencyNodes = [...dependencyModes.entries()].map(([type, counts], index) => ({
    id: `dependency:${type}`,
    type: "dependency",
    position: { x: 760, y: 90 + index * 126 },
    data: {
      type,
      label: dependencyLabels[type],
      selected: selectedDependency === type,
      mode: counts.managed > 0 && counts.external > 0 ? "mixed" : counts.managed > 0 ? "managed" : "external",
    } satisfies DependencyNodeData,
  }));

  return [...serviceNodes, ...dependencyNodes];
}

function buildEdges(services: DetectedService[], communications: ServiceCommunication[]): Edge[] {
  const selected = new Set(services.filter((service) => service.deploy).map((service) => service.id));
  const edges: Edge[] = communications
    .filter((link) => selected.has(link.sourceServiceId) && selected.has(link.targetServiceId))
    .map((link) => ({
      id: link.id,
      source: link.sourceServiceId,
      target: link.targetServiceId,
      type: "smoothstep",
      animated: true,
      label: link.envNames.length ? link.envNames.slice(0, 2).join(", ") : `${link.sourceName} -> ${link.targetName}`,
      markerEnd: { type: "arrowclosed", color: "rgba(34,211,238,0.9)" },
      style: { stroke: "rgba(34,211,238,0.95)", strokeWidth: 2.5 },
      labelStyle: { fill: "rgba(207,250,254,0.9)", fontSize: 11 },
      labelBgStyle: { fill: "rgba(11,11,15,0.86)" },
    }));

  for (const service of services) {
    if (!service.deploy) continue;
    for (const dependency of service.dependencies) {
      edges.push({
        id: `${service.id}->dependency:${dependency.type}`,
        source: service.id,
        target: `dependency:${dependency.type}`,
        type: "smoothstep",
        animated: false,
        label: dependency.provision ? dependency.type : `${dependency.type} external`,
        markerEnd: { type: "arrowclosed", color: dependency.provision ? "rgba(255,255,255,0.24)" : "rgba(252,211,77,0.55)" },
        style: { stroke: dependency.provision ? "rgba(255,255,255,0.18)" : "rgba(252,211,77,0.55)", strokeWidth: dependency.provision ? 1.6 : 1.9, strokeDasharray: dependency.provision ? undefined : "6 5" },
        labelStyle: { fill: dependency.provision ? "rgba(255,255,255,0.45)" : "rgba(254,243,199,0.8)", fontSize: 11 },
        labelBgStyle: { fill: "rgba(11,11,15,0.74)" },
      });
    }
  }

  return edges;
}

function ServiceNode({ data }: NodeProps) {
  const { service, selected, onToggleDeploy } = data as ServiceNodeData;
  const tone = serviceTone[service.kind];
  return (
    <div className={clsx("relative w-[236px] rounded-[22px] border p-4 shadow-tactile backdrop-blur-md", service.deploy ? "border-white/10 bg-[#12121A]/95" : "border-white/[0.04] bg-[#12121A]/55 opacity-60", selected && "border-cyan-300/45 shadow-glow")}>
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border !border-cyan-100/40 !bg-[#0B0B0F]" />
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border !border-cyan-100/40 !bg-cyan-300" />
      <div className="flex items-start justify-between gap-3">
        <div className={clsx("grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br text-sm font-black text-[#0B0B0F] ring-8", tone.gradient, tone.ring)}>
          {tone.icon}
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleDeploy(service.id, !service.deploy);
          }}
          className={clsx("rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-[0.16em]", service.deploy ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100" : "border-white/5 bg-white/[0.03] text-white/35")}
        >
          {service.deploy ? "Deploy" : "Skip"}
        </button>
      </div>
      <strong className="mt-4 block truncate text-base text-white">{service.name}</strong>
      <p className="mt-1 truncate font-mono text-[11px] text-cyan-100/55">{service.path}</p>
      <p className="mt-2 text-xs text-white/45">{service.framework || tone.label}{service.port ? ` / :${service.port}` : ""}</p>
    </div>
  );
}

function DependencyNode({ data }: NodeProps) {
  const { type, label, selected, mode } = data as DependencyNodeData;
  return (
    <div className={clsx("relative w-[190px] rounded-[22px] border bg-white/[0.035] p-4 shadow-tactile backdrop-blur-md", selected ? "border-cyan-300/45 shadow-glow" : "border-white/5")}>
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border !border-white/30 !bg-white/70" />
      <div className={clsx("grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br font-black text-[#0B0B0F]", dependencyTone[type])}>
        {label.slice(0, 2)}
      </div>
      <strong className="mt-3 block text-sm text-white">{label}</strong>
      <p className={clsx("mt-1 font-mono text-[11px] uppercase tracking-[0.16em]", mode === "managed" ? "text-cyan-100/55" : mode === "external" ? "text-amber-100/70" : "text-violet-100/70")}>
        {mode}
      </p>
    </div>
  );
}
