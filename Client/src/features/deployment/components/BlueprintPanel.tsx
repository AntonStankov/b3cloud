import clsx from "clsx";
import type { DetectedService, InstanceSize } from "../types";
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

export function BlueprintPanel({ service, onChange }: BlueprintPanelProps) {
  if (!service) {
    return (
      <aside className="rounded-[30px] border border-dashed border-white/10 bg-white/[0.03] p-6 text-white/45">
        Select a detected service to configure its build and runtime blueprint.
      </aside>
    );
  }

  const selectedSize = instanceSizes.find((size) => size.value === service.instanceSize) ?? instanceSizes[0];

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
        <EnvVarInput values={service.env} onChange={(env) => onChange(service.id, { env })} />
      </div>
    </aside>
  );
}
