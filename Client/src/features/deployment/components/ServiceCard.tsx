import { motion } from "framer-motion";
import clsx from "clsx";
import type { DetectedService } from "../types";
import { confidenceWidth, estimateMonthlyCost, serviceTone } from "../lib/servicePresentation";

interface ServiceCardProps {
  service: DetectedService;
  selected?: boolean;
  onSelect: (serviceId: string) => void;
  onToggleDeploy: (serviceId: string, deploy: boolean) => void;
}

export function ServiceCard({ service, selected = false, onSelect, onToggleDeploy }: ServiceCardProps) {
  const tone = serviceTone[service.kind];
  const managedCount = service.dependencies.filter((dependency) => dependency.provision).length;
  const externalCount = service.dependencies.length - managedCount;
  return (
    <motion.button
      layout
      type="button"
      whileHover={{ y: -4, scale: 1.012 }}
      whileTap={{ scale: 0.99 }}
      onClick={() => onSelect(service.id)}
      className={clsx(
        "group relative min-h-[224px] overflow-hidden rounded-[28px] border p-5 text-left transition-all duration-200",
        service.deploy ? "bg-[#12121A]/85" : "bg-[#12121A]/45 opacity-60",
        "shadow-tactile backdrop-blur-md",
        selected ? "border-cyan-300/40 shadow-glow" : service.deploy ? "border-white/5 hover:border-white/12" : "border-white/[0.03]"
      )}
    >
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
      <div className={clsx("absolute -right-10 -top-10 h-36 w-36 rounded-full bg-gradient-to-br opacity-20 blur-2xl", tone.gradient)} />
      <div className="relative z-10 flex h-full flex-col justify-between gap-6">
        <div className="flex items-start justify-between gap-4">
          <div className={clsx("grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br text-sm font-black text-[#0B0B0F] ring-8", tone.gradient, tone.ring)}>
            {tone.icon}
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className="rounded-full border border-white/5 bg-white/[0.03] px-3 py-1 font-mono text-[11px] uppercase tracking-[0.2em] text-white/55">
              {service.confidence}
            </span>
            <span className={clsx("rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.16em]", service.deploy ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100" : "border-white/5 bg-white/[0.03] text-white/35")}>
              {service.deploy ? "Deploy" : "Skip"}
            </span>
          </div>
        </div>
        <div>
          <p className="mb-2 font-mono text-xs text-cyan-200/70">{service.path}</p>
          <h3 className="text-xl font-semibold tracking-[-0.03em] text-white">{service.name}</h3>
          <p className="mt-2 text-sm leading-6 text-white/55">
            {service.framework || tone.label}{service.port ? ` / :${service.port}` : ""}
          </p>
          {!!service.dependencies.length && (
            <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.16em] text-white/35">
              {managedCount} managed / {externalCount} external
            </p>
          )}
          {!!service.warnings.length && (
            <p className="mt-3 rounded-2xl border border-amber-300/10 bg-amber-300/5 px-3 py-2 text-xs leading-5 text-amber-100/70">
              {service.warnings[0]}
            </p>
          )}
        </div>
        <div className="space-y-3">
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div className={clsx("h-full rounded-full bg-gradient-to-r from-violet-400 to-cyan-300", confidenceWidth(service.confidence))} />
          </div>
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-white/45">Est. runtime</span>
            <span className="font-mono text-white/80">{estimateMonthlyCost(service)}/mo</span>
          </div>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggleDeploy(service.id, !service.deploy);
            }}
            className={clsx(
              "w-full rounded-2xl border px-3 py-2 font-mono text-xs uppercase tracking-[0.16em] transition-all duration-200",
              service.deploy
                ? "border-rose-300/10 bg-rose-300/5 text-rose-100/75 hover:bg-rose-300/10"
                : "border-cyan-300/20 bg-cyan-300/10 text-cyan-100 hover:bg-cyan-300/15"
            )}
          >
            {service.deploy ? "Skip this service" : "Deploy this service"}
          </button>
        </div>
      </div>
    </motion.button>
  );
}
