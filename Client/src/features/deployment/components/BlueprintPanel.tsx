import clsx from "clsx";
import type { AutoEnvVar, DetectedService, EnvVarPair, InstanceSize, ManagedDependencyKind, ServiceDependency } from "../types";
import { EnvVarInput } from "./EnvVarInput";

interface BlueprintPanelProps {
  service: DetectedService | null;
  onChange: (serviceId: string, patch: Partial<DetectedService>) => void;
}

const instanceSizes: Array<{ value: InstanceSize; label: string; cpu: string; memory: string; cost: number }> = [
  { value: "nano", label: "Nano", cpu: "0.25 vCPU", memory: "512 MB", cost: 5 },
  { value: "micro", label: "Micro", cpu: "0.5 vCPU", memory: "1 GB", cost: 9 },
  { value: "standard", label: "Standard", cpu: "1 vCPU", memory: "2 GB", cost: 18 },
  { value: "performance", label: "Performance", cpu: "2 vCPU", memory: "4 GB", cost: 38 },
];

const dependencyLabels: Record<ManagedDependencyKind, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mongodb: "MongoDB",
  redis: "Redis",
  rabbitmq: "RabbitMQ",
};

const externalEnvByDependency: Record<ManagedDependencyKind, string[]> = {
  postgres: ["DATABASE_URL"],
  mysql: ["DATABASE_URL"],
  mongodb: ["MONGODB_URI"],
  redis: ["REDIS_URL"],
  rabbitmq: ["RABBITMQ_URL"],
};

export function BlueprintPanel({ service, onChange }: BlueprintPanelProps) {
  if (!service) {
    return (
      <aside className="rounded-[30px] border border-dashed border-white/10 bg-white/[0.03] p-6 text-white/45">
        Select a detected service to configure its build and runtime blueprint.
      </aside>
    );
  }

  const selectedSize = instanceSizes.find((size) => size.value === service.instanceSize) ?? instanceSizes[0];
  const provisionedDependencies = service.dependencies.filter((dependency) => dependency.provision);
  const automaticEnv = dedupeAutoEnv(
    service.automaticEnv.filter((item) => shouldShowAutoEnv(item, provisionedDependencies))
  );

  return (
    <aside className="rounded-[30px] border border-white/5 bg-[#12121A]/90 p-5 shadow-tactile backdrop-blur-md">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.22em] text-cyan-200/60">Blueprint</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.05em] text-white">{service.name}</h2>
          <p className="mt-1 font-mono text-xs text-white/40">{service.path}</p>
        </div>
        <span className="rounded-full border border-white/5 bg-white/[0.04] px-3 py-1 font-mono text-xs text-white/55">{service.kind}</span>
      </div>
      <div className="space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-white/60">Build command</span>
          <input value={service.buildCommand ?? ""} onChange={(event) => onChange(service.id, { buildCommand: event.target.value })} placeholder="npm run build" className="w-full rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 font-mono text-sm text-white outline-none" />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-white/60">Output directory</span>
          <input value={service.outputDirectory ?? ""} onChange={(event) => onChange(service.id, { outputDirectory: event.target.value })} placeholder="dist / .next / build" className="w-full rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 font-mono text-sm text-white outline-none" />
        </label>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-white/60">Instance size</span>
            <span className="font-mono text-sm text-cyan-100">${selectedSize.cost}/mo</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {instanceSizes.map((size) => (
              <button
                key={size.value}
                type="button"
                onClick={() => onChange(service.id, { instanceSize: size.value, monthlyEstimateUsd: size.cost })}
                className={clsx(
                  "rounded-2xl border p-3 text-left transition-all duration-200",
                  service.instanceSize === size.value ? "border-cyan-300/35 bg-cyan-300/10 shadow-glow" : "border-white/5 bg-white/[0.035] hover:bg-white/[0.055]"
                )}
              >
                <strong className="block text-sm text-white">{size.label}</strong>
                <span className="mt-1 block font-mono text-[11px] text-white/45">{size.cpu} / {size.memory}</span>
              </button>
            ))}
          </div>
        </div>
        <DependencyModeControl service={service} onChange={onChange} />
        <AutomaticEnvPanel dependencies={provisionedDependencies} variables={automaticEnv} />
        <EnvVarInput values={service.env} onChange={(env) => onChange(service.id, { env })} />
      </div>
    </aside>
  );
}

function DependencyModeControl({ service, onChange }: BlueprintPanelProps & { service: DetectedService }) {
  if (!service.dependencies.length) {
    return (
      <div className="rounded-[24px] border border-white/5 bg-white/[0.025] p-4">
        <p className="font-mono text-xs uppercase tracking-[0.22em] text-cyan-200/60">Backing services</p>
        <p className="mt-2 text-sm leading-6 text-white/45">No database, queue, cache, or broker dependency was detected for this service.</p>
      </div>
    );
  }

  function setProvisioning(dependency: ServiceDependency, provision: boolean) {
    const dependencies = service.dependencies.map((item) =>
      item.type === dependency.type ? { ...item, provision } : item
    );
    const env = provision
      ? removeExternalEnv(service.env, dependency.type)
      : addExternalEnv(service.env, dependency.type);
    onChange(service.id, {
      dependencies,
      env,
    });
  }

  return (
    <div className="rounded-[24px] border border-white/5 bg-white/[0.025] p-4">
      <div className="mb-3">
        <p className="font-mono text-xs uppercase tracking-[0.22em] text-cyan-200/60">Backing services</p>
        <h3 className="mt-1 text-lg font-semibold tracking-[-0.03em] text-white">Connection mode</h3>
        <p className="mt-1 text-sm leading-6 text-white/45">Choose whether b3cloud provisions the service and injects connection variables, or you provide external credentials yourself.</p>
      </div>
      <div className="space-y-2">
        {service.dependencies.map((dependency) => (
          <div key={dependency.type} className="rounded-2xl border border-white/5 bg-[#0B0B0F]/45 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <strong className="block text-sm text-white">{dependencyLabels[dependency.type]}</strong>
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-white/35">{dependency.confidence} confidence</span>
              </div>
              <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-white/5 bg-white/[0.035] p-1">
                <button
                  type="button"
                  onClick={() => setProvisioning(dependency, true)}
                  className={clsx("rounded-lg px-3 py-2 text-xs font-medium transition-all duration-200", dependency.provision ? "bg-cyan-300/15 text-cyan-100" : "text-white/45 hover:text-white")}
                >
                  Managed
                </button>
                <button
                  type="button"
                  onClick={() => setProvisioning(dependency, false)}
                  className={clsx("rounded-lg px-3 py-2 text-xs font-medium transition-all duration-200", !dependency.provision ? "bg-amber-300/15 text-amber-100" : "text-white/45 hover:text-white")}
                >
                  External
                </button>
              </div>
            </div>
            {dependency.evidence[0] && <p className="mt-2 text-xs leading-5 text-white/35">{dependency.evidence[0]}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function AutomaticEnvPanel({ dependencies, variables }: { dependencies: ServiceDependency[]; variables: AutoEnvVar[] }) {
  if (!dependencies.length && !variables.length) {
    return null;
  }

  return (
    <div className="rounded-[24px] border border-cyan-300/10 bg-cyan-300/[0.035] p-4">
      <div className="mb-3">
        <p className="font-mono text-xs uppercase tracking-[0.22em] text-cyan-200/70">Auto-injected env</p>
        <h3 className="mt-1 text-lg font-semibold tracking-[-0.03em] text-white">Set by b3cloud at runtime</h3>
        <p className="mt-1 text-sm leading-6 text-white/45">These names are mounted from Kubernetes Secrets after managed services are provisioned. Values are hidden and are not sent from the browser.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {variables.map((item) => (
          <span key={`${item.source}-${item.key}`} className="rounded-xl border border-white/5 bg-[#0B0B0F]/55 px-3 py-2 font-mono text-xs text-cyan-100/80">
            {item.key}
          </span>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {dependencies.map((dependency) => (
          <span key={dependency.type} className="rounded-full border border-cyan-200/10 bg-cyan-200/10 px-3 py-1 text-xs text-cyan-100/70">
            {dependencyLabels[dependency.type]} managed
          </span>
        ))}
      </div>
    </div>
  );
}

function addExternalEnv(env: EnvVarPair[], dependency: ManagedDependencyKind): EnvVarPair[] {
  const existing = new Set(env.map((item) => item.key));
  const additions = externalEnvByDependency[dependency]
    .filter((key) => !existing.has(key))
    .map((key) => ({
      id: `${dependency}-${key}`,
      key,
      value: "",
      secret: true,
      source: "external backing service",
      evidence: [`Provide ${key} because ${dependencyLabels[dependency]} is configured as external.`],
    }));
  return [...env, ...additions];
}

function removeExternalEnv(env: EnvVarPair[], dependency: ManagedDependencyKind): EnvVarPair[] {
  const keys = new Set(externalEnvByDependency[dependency]);
  return env.filter((item) => !keys.has(item.key) || item.source !== "external backing service");
}

function dedupeAutoEnv(values: AutoEnvVar[]): AutoEnvVar[] {
  const seen = new Set<string>();
  return values.filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  });
}

function autoEnvBelongsToDependency(item: AutoEnvVar, dependency: ManagedDependencyKind): boolean {
  return item.source.toLowerCase().includes(dependency);
}

function shouldShowAutoEnv(item: AutoEnvVar, provisionedDependencies: ServiceDependency[]): boolean {
  const dependencyTypes: ManagedDependencyKind[] = ["postgres", "mysql", "mongodb", "redis", "rabbitmq"];
  const backingDependency = dependencyTypes.find((dependency) => autoEnvBelongsToDependency(item, dependency));
  if (!backingDependency) return true;
  return provisionedDependencies.some((dependency) => dependency.type === backingDependency);
}
