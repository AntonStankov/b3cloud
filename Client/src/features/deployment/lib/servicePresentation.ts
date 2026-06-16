import type { DetectedService, ServiceKind } from "../types";

export const serviceTone: Record<ServiceKind, { label: string; icon: string; gradient: string; ring: string }> = {
  nextjs: { label: "Next.js", icon: "N", gradient: "from-zinc-100 to-zinc-500", ring: "ring-zinc-300/20" },
  react: { label: "React", icon: "R", gradient: "from-cyan-300 to-blue-500", ring: "ring-cyan-300/20" },
  node: { label: "Node.js", icon: "JS", gradient: "from-emerald-300 to-lime-500", ring: "ring-emerald-300/20" },
  python: { label: "Python", icon: "Py", gradient: "from-yellow-300 to-blue-500", ring: "ring-yellow-300/20" },
  go: { label: "Go", icon: "Go", gradient: "from-sky-300 to-cyan-500", ring: "ring-sky-300/20" },
  php: { label: "PHP", icon: "Php", gradient: "from-indigo-300 to-violet-500", ring: "ring-indigo-300/20" },
  java: { label: "Java", icon: "Jv", gradient: "from-orange-300 to-red-500", ring: "ring-orange-300/20" },
  postgres: { label: "Postgres", icon: "Pg", gradient: "from-blue-300 to-indigo-500", ring: "ring-blue-300/20" },
  redis: { label: "Redis", icon: "Re", gradient: "from-red-300 to-rose-500", ring: "ring-red-300/20" },
  worker: { label: "Worker", icon: "W", gradient: "from-violet-300 to-fuchsia-500", ring: "ring-violet-300/20" },
  static: { label: "Static", icon: "S", gradient: "from-slate-200 to-slate-500", ring: "ring-slate-300/20" },
  unknown: { label: "Service", icon: "?", gradient: "from-white to-slate-500", ring: "ring-white/10" },
};

export function estimateMonthlyCost(service: DetectedService): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(service.monthlyEstimateUsd);
}

export function confidenceWidth(confidence: DetectedService["confidence"]): string {
  if (confidence === "high") return "w-[92%]";
  if (confidence === "medium") return "w-[64%]";
  return "w-[38%]";
}
