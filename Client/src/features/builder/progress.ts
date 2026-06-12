import type { DeployJob } from "../../api/types";

// Maps deploy job logs to a percentage + milestone timeline. Mirrors the
// progressMilestones logic in user_ui/app.js so it works identically against
// the real backend.

interface Milestone {
  key: string;
  label: string;
  weight: number;
  match: RegExp;
}

export const MILESTONES: Milestone[] = [
  { key: "queued", label: "Queued", weight: 5, match: /job queued|queued/i },
  { key: "started", label: "Started", weight: 10, match: /deploy job started|deploying component/i },
  { key: "analyze", label: "Analyzed repository", weight: 18, match: /analyzing|detected services/i },
  { key: "namespace", label: "Prepared namespace", weight: 26, match: /preparing namespace/i },
  { key: "services", label: "Provisioned services", weight: 40, match: /provisioning internal backing services/i },
  { key: "registry", label: "Authenticated registry", weight: 48, match: /logging in to registry|seeding registry/i },
  { key: "clone", label: "Cloned source", weight: 56, match: /cloning source repo|using app path/i },
  { key: "build", label: "Build running", weight: 70, match: /running buildpacks|pack build/i },
  { key: "image", label: "Image published", weight: 80, match: /image published/i },
  { key: "kubernetes", label: "Applied Kubernetes resources", weight: 90, match: /applying kubernetes/i },
  { key: "route", label: "Configured public route", weight: 95, match: /ensuring cloudflare route/i },
  { key: "done", label: "Deployment complete", weight: 100, match: /finished successfully|deployment finished/i },
];

export interface ProgressState {
  percent: number;
  reached: Set<string>;
  status: DeployJob["status"] | "idle";
}

export function computeProgress(job: DeployJob | null): ProgressState {
  if (!job) {
    return { percent: 0, reached: new Set(), status: "idle" };
  }
  const logs = Array.isArray(job.logs) ? job.logs : [];
  const reached = new Set<string>();
  for (const entry of logs) {
    for (const milestone of MILESTONES) {
      if (milestone.match.test(String(entry))) reached.add(milestone.key);
    }
  }
  if (job.status === "queued") reached.add("queued");
  if (job.status === "running") {
    reached.add("queued");
    reached.add("started");
  }
  if (job.status === "succeeded") {
    MILESTONES.forEach((m) => reached.add(m.key));
  }

  const percent = MILESTONES.reduce(
    (current, milestone) =>
      reached.has(milestone.key) ? Math.max(current, milestone.weight) : current,
    job.status === "submitting" ? 2 : 0
  );

  return { percent, reached, status: job.status };
}
