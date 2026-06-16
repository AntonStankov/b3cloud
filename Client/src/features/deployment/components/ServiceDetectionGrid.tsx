import { AnimatePresence, motion } from "framer-motion";
import type { DetectedService } from "../types";
import { ServiceCard } from "./ServiceCard";

interface ServiceDetectionGridProps {
  services: DetectedService[];
  selectedServiceId: string | null;
  loading?: boolean;
  onSelectService: (serviceId: string) => void;
  onToggleDeploy: (serviceId: string, deploy: boolean) => void;
}

export function ServiceDetectionGrid({ services, selectedServiceId, loading = false, onSelectService, onToggleDeploy }: ServiceDetectionGridProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="h-56 rounded-[28px] border border-white/5 bg-white/[0.03] p-5 shadow-tactile">
            <div className="h-full animate-pulse rounded-2xl bg-gradient-to-r from-white/[0.04] via-white/[0.08] to-white/[0.04] bg-[length:200%_100%]" />
          </div>
        ))}
      </div>
    );
  }

  if (!services.length) {
    return (
      <div className="rounded-[28px] border border-dashed border-white/10 bg-white/[0.03] p-10 text-center shadow-tactile">
        <p className="font-mono text-xs uppercase tracking-[0.24em] text-cyan-200/60">No services detected</p>
        <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-white">Inspect a repository to generate a deployment blueprint.</h3>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-white/50">The inspection API will populate this grid with deployable components, framework metadata, service dependencies, and estimated runtime cost.</p>
      </div>
    );
  }

  return (
    <motion.div layout className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <AnimatePresence mode="popLayout">
        {services.map((service) => (
          <ServiceCard
            key={service.id}
            service={service}
            selected={selectedServiceId === service.id}
            onSelect={onSelectService}
            onToggleDeploy={onToggleDeploy}
          />
        ))}
      </AnimatePresence>
    </motion.div>
  );
}
