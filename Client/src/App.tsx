import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { motion } from "framer-motion";
import { analyze, deploy, getJob, getProject, health, listJobs, listProjects, redeployProject, registerProjectCicd } from "./api/apps";
import { clearBearerToken, setBearerToken } from "./api/config";
import type { AnalyzeResult, AnalyzedComponent, DeployInput, DeployJob, ProjectSummary, ServiceType } from "./api/types";
import { ArchitectureGraph } from "./features/deployment/components/ArchitectureGraph";
import { BlueprintPanel } from "./features/deployment/components/BlueprintPanel";
import { LogTerminal } from "./features/deployment/components/LogTerminal";
import { ServiceDetectionGrid } from "./features/deployment/components/ServiceDetectionGrid";
import { DeploymentFlowProvider, useDeploymentFlow } from "./features/deployment/state/DeploymentFlowContext";
import type { AutoEnvVar, DetectedService, DeploymentEvent, DeploymentStatus, ManagedDependencyKind, RepositorySummary, ServiceCommunication, ServiceKind } from "./features/deployment/types";
import { supabase, supabaseConfigured } from "./supabase";

interface GithubRepo {
  id: number;
  full_name: string;
  html_url: string;
  private: boolean;
  default_branch: string;
  updated_at: string;
  language: string | null;
  size: number;
}

const pseudoBuildLines = [
  "b3 init --provider github",
  "resolving repository graph...",
  "detected nextjs / node / postgres",
  "allocating k3s workload envelope",
  "routing through cloudflare tunnel",
  "deployment ready in 42s",
];

export default function App() {
  return (
    <DeploymentFlowProvider>
      <DeploymentExperience />
    </DeploymentFlowProvider>
  );
}

function DeploymentExperience() {
  const { state, dispatch } = useDeploymentFlow();
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [githubToken, setGithubToken] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [revision, setRevision] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [apiStatus, setApiStatus] = useState("checking api");
  const [activeJob, setActiveJob] = useState<DeployJob | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(null);
  const [selectedProjectJob, setSelectedProjectJob] = useState<DeployJob | null>(null);
  const [projectConfigText, setProjectConfigText] = useState("");
  const [selectedDependency, setSelectedDependency] = useState<ManagedDependencyKind | null>(null);

  const selectedService = useMemo(
    () => visibleServiceCommunicationEnv(
      state.services.find((service) => service.id === state.selectedServiceId) ?? null,
      state.services,
      state.communications
    ),
    [state.selectedServiceId, state.services, state.communications]
  );

  const filteredRepositories = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return state.repositories;
    return state.repositories.filter((repo) => repo.fullName.toLowerCase().includes(normalized));
  }, [query, state.repositories]);

  const deploymentEvents = useMemo(() => {
    if (!activeJob) return demoEvents(state.deployment.status);
    return jobToEvents(activeJob);
  }, [activeJob, state.deployment.status]);

  useEffect(() => {
    health()
      .then((result) => setApiStatus(result.status === "ok" ? "api online" : "api degraded"))
      .catch(() => setApiStatus("api unreachable"));
  }, []);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => applySession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => applySession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!githubToken) return;
    void loadRepositories(githubToken);
  }, [githubToken]);

  useEffect(() => {
    if (!activeJob || !["queued", "running", "submitting"].includes(activeJob.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await getJob(activeJob.job_id);
        setActiveJob(next);
        dispatch({ type: "SET_DEPLOYMENT", deployment: { status: mapJobStatus(next.status), currentStep: deploymentStep(mapJobStatus(next.status)), productionUrl: deploymentUrl(next) } });
      } catch (err) {
        setError(readError(err));
      }
    }, 2800);
    return () => window.clearInterval(timer);
  }, [activeJob, dispatch]);

  const selectedProjectId = selectedProject?.deployment_id || "";

  useEffect(() => {
    if (!selectedProjectId || state.step !== "projects") return;
    const timer = window.setInterval(async () => {
      try {
        const detail = await getProject(selectedProjectId);
        setSelectedProject(detail);
        setProjects((current) => mergeProjectSummary(current, detail));
        const latestJobId = detail.last_job?.job_id;
        if (latestJobId) {
          const latestJob = await getJob(latestJobId);
          setSelectedProjectJob(latestJob);
        }
      } catch (err) {
        setError(readError(err));
      }
    }, 3500);
    return () => window.clearInterval(timer);
  }, [selectedProjectId, state.step]);

  function applySession(nextSession: Session | null) {
    setSession(nextSession);
    if (nextSession?.access_token) setBearerToken(nextSession.access_token);
    else clearBearerToken();

    const providerToken = (nextSession as Session & { provider_token?: string } | null)?.provider_token || "";
    setGithubToken(providerToken);
    if (nextSession) {
      dispatch({ type: "SET_STEP", step: state.isNewUser ? "onboarding" : "projects" });
      void loadProjectsView();
    }
  }

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setBusy("auth");
    setError("");
    try {
      const result = authMode === "signup"
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      dispatch({ type: "SET_NEW_USER", isNewUser: authMode === "signup" });
      dispatch({ type: "SET_STEP", step: authMode === "signup" ? "onboarding" : "source" });
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy("");
    }
  }

  async function signInWithGithub() {
    if (!supabase) return;
    setBusy("github");
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { scopes: "repo admin:repo_hook read:user user:email", redirectTo: window.location.origin },
    });
    if (oauthError) {
      setError(oauthError.message);
      setBusy("");
    }
  }

  async function signOut() {
    clearBearerToken();
    setGithubToken("");
    setActiveJob(null);
    dispatch({ type: "SET_STEP", step: "landing" });
    await supabase?.auth.signOut();
  }

  async function loadRepositories(token: string) {
    setBusy("repos");
    try {
      const response = await fetch("https://api.github.com/user/repos?sort=updated&per_page=80", {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      const repos = (await response.json()) as GithubRepo[];
      dispatch({ type: "SET_REPOSITORIES", repositories: repos.map(toRepositorySummary) });
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy("");
    }
  }

  async function loadProjectsView() {
    setBusy("projects");
    setError("");
    try {
      const items = await listProjects();
      setProjects(items);
      if (selectedProject) {
        const nextSelected = items.find((item) => item.deployment_id === selectedProject.deployment_id);
        if (nextSelected) {
          setSelectedProject(nextSelected);
          setSelectedProjectJob(nextSelected.last_job || selectedProjectJob);
        }
      }
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy("");
    }
  }

  async function openProject(project: ProjectSummary) {
    setBusy("project");
    setError("");
    try {
      const detail = await getProject(project.deployment_id);
      setSelectedProject(detail);
      setSelectedProjectJob(detail.last_job || null);
      setProjectConfigText(JSON.stringify(detail.deployment_config || detail.last_job?.deployment_config || {}, null, 2));
      if (githubToken) {
        registerProjectCicd(detail.deployment_id, githubToken)
          .then((result) => {
            if (result.job) setSelectedProjectJob(result.job);
          })
          .catch((err) => setError(`CI/CD setup failed: ${readError(err)}`));
      }
      dispatch({ type: "SET_STEP", step: "projects" });
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy("");
    }
  }

  async function redeploySelectedProject() {
    if (!selectedProject) return;
    setBusy("project-redeploy");
    setError("");
    try {
      const parsed = JSON.parse(projectConfigText) as DeployInput;
      if (githubToken && !parsed.github_token) parsed.github_token = githubToken;
      const job = await redeployProject(selectedProject.deployment_id, parsed);
      setActiveJob(job);
      setSelectedProjectJob(job);
      dispatch({ type: "SET_DEPLOYMENT", deployment: { status: mapJobStatus(job.status), currentStep: deploymentStep(mapJobStatus(job.status)) } });
      await loadProjectsView();
    } catch (err) {
      setError(`Redeploy failed: ${readError(err)}`);
    } finally {
      setBusy("");
    }
  }

  async function inspectRepository(repository: RepositorySummary) {
    dispatch({ type: "SELECT_REPOSITORY", repository });
    setRepoUrl(repository.url);
    setRevision(repository.defaultBranch);
    setBusy("inspect");
    setError("");
    try {
      const result = await analyze({ github_url: repository.url, git_revision: repository.defaultBranch, github_token: githubToken || undefined });
      const architecture = analysisToArchitecture(result);
      setSelectedDependency(null);
      dispatch({ type: "SET_SERVICES", services: architecture.services, communications: architecture.communications });
    } catch (err) {
      setError(`Repository inspection failed: ${readError(err)}`);
      dispatch({ type: "SET_STEP", step: "source" });
    } finally {
      setBusy("");
    }
  }

  async function inspectManualRepository() {
    const repository: RepositorySummary = {
      id: repoUrl,
      fullName: repoUrl.replace(/^https:\/\/github.com\//, ""),
      url: repoUrl,
      defaultBranch: revision || "",
      private: false,
      isMonorepo: false,
    };
    await inspectRepository(repository);
  }

  async function launchDeployment() {
    const repository = state.selectedRepository;
    if (!repository) return;
    const deployableServices = state.services.filter((service) => service.deploy);
    if (!deployableServices.length) {
      setError("Select at least one detected service to deploy.");
      return;
    }
    const missingEnv = deployableServices.flatMap((service) =>
      service.env
        .filter((item) => item.required !== false && !item.value.trim())
        .map((item) => `${service.name}:${item.key}`)
    );
    if (missingEnv.length) {
      setError(`Fill or remove empty required environment variables before deploying: ${missingEnv.slice(0, 12).join(", ")}${missingEnv.length > 12 ? " ..." : ""}`);
      dispatch({ type: "SET_STEP", step: "blueprint" });
      return;
    }
    setBusy("deploy");
    setError("");
    dispatch({ type: "SET_STEP", step: "ignition" });
    dispatch({ type: "SET_DEPLOYMENT", deployment: { status: "queued", currentStep: 0, events: demoEvents("queued") } });
    try {
      const job = await deploy({
        github_url: repository.url,
        github_token: githubToken || undefined,
        ci_cd_enabled: true,
        ci_cd_branch: repository.defaultBranch || "",
        git_revision: repository.defaultBranch || "",
        port: deployableServices[0]?.port ?? 8080,
        node_arch: "amd64",
        auto_detect_services: true,
        provision_services: [],
        redeploy_services: false,
        env: {},
        resources: {
          cpu_request: "100m",
          cpu_limit: "500m",
          memory_request: "128Mi",
          memory_limit: "512Mi",
        },
        autoscaling: {
          enabled: true,
          min_replicas: 1,
          max_replicas: 4,
          target_cpu_utilization: 80,
          target_memory_utilization: 80,
        },
        components: deployableServices.map((service) => ({
          name: service.name,
          path: service.path,
          type: service.kind === "react" || service.kind === "nextjs" || service.kind === "static" ? "frontend" : "backend",
          public: service.publicEndpoint,
          api_path_prefix: service.apiPathPrefix ?? undefined,
          port: service.port ?? 8080,
          auto_detect_services: true,
          provision_services: service.dependencies.filter((dependency) => dependency.provision).map((dependency) => dependency.type),
          redeploy_services: false,
          env: Object.fromEntries(service.env.map((item) => [item.key.trim(), item.value]).filter(([key, value]) => key && String(value).trim() !== "")),
        })),
      });
      setActiveJob(job);
      dispatch({ type: "SET_DEPLOYMENT", deployment: { status: mapJobStatus(job.status), currentStep: deploymentStep(mapJobStatus(job.status)) } });
    } catch (err) {
      setError(readError(err));
      dispatch({ type: "SET_DEPLOYMENT", deployment: { status: "failed", currentStep: 0 } });
    } finally {
      setBusy("");
    }
  }

  async function loadRecentJob() {
    try {
      const jobs = await listJobs();
      const latest = jobs[0];
      if (latest) {
        setActiveJob(latest);
        dispatch({ type: "SET_STEP", step: "ignition" });
      }
    } catch (err) {
      setError(readError(err));
    }
  }

  if (!supabaseConfigured || !supabase) {
    return <UnavailableShell apiStatus={apiStatus} />;
  }

  if (!session || state.step === "landing") {
    return (
      <DarkShell apiStatus={apiStatus} error={error} onDismissError={() => setError("")}>
        <LandingView
          authMode={authMode}
          busy={busy}
          email={email}
          password={password}
          onAuthModeChange={setAuthMode}
          onEmailChange={setEmail}
          onPasswordChange={setPassword}
          onSubmitAuth={submitAuth}
          onGithub={signInWithGithub}
        />
      </DarkShell>
    );
  }

  return (
    <DarkShell apiStatus={apiStatus} error={error} onDismissError={() => setError("")}>
      <div className="grid min-h-[calc(100vh-7rem)] grid-cols-[280px_minmax(0,1fr)] gap-4 max-lg:grid-cols-1">
        <aside className="rounded-[32px] border border-white/5 bg-white/[0.035] p-4 shadow-tactile backdrop-blur-md">
          <div className="mb-6 rounded-[24px] border border-white/5 bg-[#12121A] p-4">
            <div className="mb-3 grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-violet-400 to-cyan-300 font-black text-[#0B0B0F]">
              {session.user.email?.slice(0, 1).toUpperCase() || "U"}
            </div>
            <p className="truncate text-sm font-semibold text-white">{session.user.email}</p>
            <p className="mt-1 font-mono text-xs text-white/40">{githubToken ? "github connected" : "github disconnected"}</p>
          </div>
          <nav className="space-y-2">
            {[
              ["projects", "00", "Projects"],
              ["source", "01", "Source"],
              ["blueprint", "02", "Blueprint"],
              ["ignition", "03", "Ignition"],
              ["dashboard", "04", "Command Center"],
            ].map(([step, index, label]) => (
              <button key={step} type="button" onClick={() => dispatch({ type: "SET_STEP", step: step as typeof state.step })} className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-all duration-200 ${state.step === step ? "border-cyan-300/30 bg-cyan-300/10 text-white shadow-glow" : "border-white/5 bg-white/[0.025] text-white/55 hover:text-white"}`}>
                <span className="font-mono text-xs text-cyan-200/60">{index}</span>{label}
              </button>
            ))}
          </nav>
          <div className="mt-6 grid gap-2">
            <button type="button" onClick={signInWithGithub} className="rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 text-sm text-white/70 transition-all duration-200 hover:text-white">Reconnect GitHub</button>
            <button type="button" onClick={loadRecentJob} className="rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 text-sm text-white/70 transition-all duration-200 hover:text-white">Open latest job</button>
            <button type="button" onClick={signOut} className="rounded-2xl border border-rose-300/10 bg-rose-400/5 px-4 py-3 text-sm text-rose-100/70 transition-all duration-200 hover:text-rose-100">Sign out</button>
          </div>
        </aside>

        <main className="min-w-0">
          {state.step === "onboarding" && <OnboardingView />}
          {state.step === "projects" && (
            <ProjectsView
              busy={busy}
              projects={projects}
              selectedProject={selectedProject}
              selectedProjectJob={selectedProjectJob}
              projectConfigText={projectConfigText}
              onRefresh={loadProjectsView}
              onSelectProject={openProject}
              onConfigChange={setProjectConfigText}
              onRedeploy={redeploySelectedProject}
              onNewProject={() => dispatch({ type: "SET_STEP", step: "source" })}
            />
          )}
          {state.step === "source" && (
            <SourceView
              busy={busy}
              query={query}
              repositories={filteredRepositories}
              repoUrl={repoUrl}
              revision={revision}
              onQueryChange={setQuery}
              onRepoUrlChange={setRepoUrl}
              onRevisionChange={setRevision}
              onSelectRepository={inspectRepository}
              onInspectManual={inspectManualRepository}
            />
          )}
          {state.step === "intelligence" && <InspectionLoading />}
          {state.step === "blueprint" && (
            <BlueprintView
              busy={busy}
              services={state.services}
              communications={state.communications}
              selectedServiceId={state.selectedServiceId}
              selectedDependency={selectedDependency}
              selectedService={selectedService}
              onSelectService={(serviceId) => {
                setSelectedDependency(null);
                dispatch({ type: "SELECT_SERVICE", serviceId });
              }}
              onSelectDependency={(dependency) => {
                setSelectedDependency(dependency);
              }}
              onUpdateService={(serviceId, patch) => dispatch({ type: "UPDATE_SERVICE", serviceId, patch })}
              onDeploy={launchDeployment}
            />
          )}
          {state.step === "ignition" && (
            <IgnitionView
              status={state.deployment.status}
              currentStep={state.deployment.currentStep}
              events={deploymentEvents}
              job={activeJob}
              onOpenDashboard={() => dispatch({ type: "SET_STEP", step: "dashboard" })}
            />
          )}
          {state.step === "dashboard" && <CommandCenterView productionUrl={state.deployment.productionUrl || deploymentUrl(activeJob)} />}
        </main>
      </div>
    </DarkShell>
  );
}

function DarkShell({ children, apiStatus, error, onDismissError }: { children: React.ReactNode; apiStatus: string; error: string; onDismissError: () => void }) {
  return (
    <div className="min-h-screen overflow-hidden bg-[#0B0B0F] text-white">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_20%_-10%,rgba(139,92,246,0.22),transparent_34rem),radial-gradient(circle_at_92%_4%,rgba(34,211,238,0.16),transparent_32rem)]" />
      <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:48px_48px] opacity-40 [mask-image:linear-gradient(to_bottom,black,transparent_90%)]" />
      <div className="relative z-10 mx-auto max-w-[1540px] px-4 py-5">
        <header className="mb-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-violet-400 via-cyan-300 to-emerald-300 font-black text-[#0B0B0F] shadow-glow">b3</div>
            <div>
              <p className="font-semibold tracking-[-0.03em]">B3Cloud</p>
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-white/35">deployment operating system</p>
            </div>
          </div>
          <span className="rounded-full border border-white/5 bg-white/[0.035] px-3 py-1.5 font-mono text-xs uppercase tracking-[0.18em] text-cyan-100/70">{apiStatus}</span>
        </header>
        {error && <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-rose-300/15 bg-rose-400/10 px-4 py-3 text-sm text-rose-100"><span>{error}</span><button type="button" onClick={onDismissError} className="text-rose-100/70">Dismiss</button></div>}
        {children}
      </div>
    </div>
  );
}

function LandingView(props: {
  authMode: "signin" | "signup";
  busy: string;
  email: string;
  password: string;
  onAuthModeChange: (mode: "signin" | "signup") => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmitAuth: (event: FormEvent) => void;
  onGithub: () => void;
}) {
  return (
    <section className="grid min-h-[calc(100vh-8rem)] grid-cols-[minmax(0,1fr)_440px] items-center gap-8 max-lg:grid-cols-1">
      <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55 }}>
        <p className="font-mono text-xs uppercase tracking-[0.28em] text-cyan-200/70">from repository to production</p>
        <h1 className="mt-5 max-w-5xl text-7xl font-semibold leading-[0.9] tracking-[-0.08em] text-white max-md:text-5xl">Deploy infrastructure-grade apps without exposing the infrastructure.</h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-white/55">A tactile deployment console for GitHub projects, buildpack intelligence, Kubernetes routing, and live operational feedback.</p>
        <button type="button" onClick={props.onGithub} className="mt-8 rounded-2xl border border-cyan-300/20 bg-gradient-to-r from-violet-500 to-cyan-400 px-5 py-3 font-semibold text-[#0B0B0F] shadow-glow transition-all duration-200 hover:scale-[1.01]">
          Sign in with GitHub
        </button>
      </motion.div>
      <div className="space-y-4">
        <PseudoTerminal />
        <form onSubmit={props.onSubmitAuth} className="rounded-[30px] border border-white/5 bg-[#12121A]/85 p-5 shadow-tactile backdrop-blur-md">
          <div className="mb-4 grid grid-cols-2 rounded-2xl bg-white/[0.035] p-1">
            <button type="button" onClick={() => props.onAuthModeChange("signin")} className={props.authMode === "signin" ? "bg-white text-[#0B0B0F]" : "text-white/50"}>Sign in</button>
            <button type="button" onClick={() => props.onAuthModeChange("signup")} className={props.authMode === "signup" ? "bg-white text-[#0B0B0F]" : "text-white/50"}>Create</button>
          </div>
          <div className="space-y-3">
            <input value={props.email} onChange={(event) => props.onEmailChange(event.target.value)} type="email" placeholder="email@company.com" className="w-full rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 text-white outline-none placeholder:text-white/25" />
            <input value={props.password} onChange={(event) => props.onPasswordChange(event.target.value)} type="password" placeholder="password" className="w-full rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 text-white outline-none placeholder:text-white/25" />
            <button disabled={props.busy === "auth"} className="w-full rounded-2xl bg-white px-4 py-3 font-semibold text-[#0B0B0F] transition-all duration-200 hover:bg-cyan-100">{props.busy === "auth" ? "Authenticating..." : props.authMode === "signin" ? "Continue" : "Create workspace account"}</button>
          </div>
        </form>
      </div>
    </section>
  );
}

function PseudoTerminal() {
  return (
    <div className="rounded-[30px] border border-white/5 bg-[#08080C] p-4 shadow-tactile">
      <div className="mb-4 flex gap-1.5"><span className="h-3 w-3 rounded-full bg-rose-400" /><span className="h-3 w-3 rounded-full bg-amber-300" /><span className="h-3 w-3 rounded-full bg-emerald-400" /></div>
      <div className="space-y-2 font-mono text-sm text-white/70">
        {pseudoBuildLines.map((line, index) => <motion.p key={line} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: index * 0.22 }}>{index === 0 ? "$ " : "  "}{line}</motion.p>)}
        <span className="inline-block h-4 w-2 animate-cursor bg-cyan-200" />
      </div>
    </div>
  );
}

function OnboardingView() {
  const { state, dispatch } = useDeploymentFlow();
  return (
    <section className="rounded-[36px] border border-white/5 bg-[#12121A]/90 p-8 shadow-tactile backdrop-blur-md">
      <p className="font-mono text-xs uppercase tracking-[0.24em] text-cyan-200/60">Handshake</p>
      <h1 className="mt-4 text-5xl font-semibold tracking-[-0.07em]">Create your workspace.</h1>
      <div className="mt-8 grid gap-4 md:grid-cols-[1fr_0.8fr]">
        <input value={state.workspace.name} onChange={(event) => dispatch({ type: "UPDATE_WORKSPACE", patch: { name: event.target.value } })} placeholder="Workspace name" className="rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 text-white outline-none" />
        <select value={state.workspace.plan} onChange={(event) => dispatch({ type: "UPDATE_WORKSPACE", patch: { plan: event.target.value as typeof state.workspace.plan } })} className="rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 text-white outline-none">
          <option value="starter">Starter</option><option value="pro">Pro</option><option value="scale">Scale</option>
        </select>
      </div>
      <button type="button" onClick={() => dispatch({ type: "SET_STEP", step: "source" })} className="mt-6 rounded-2xl bg-white px-5 py-3 font-semibold text-[#0B0B0F]">Continue to repositories</button>
    </section>
  );
}

function ProjectsView(props: {
  busy: string;
  projects: ProjectSummary[];
  selectedProject: ProjectSummary | null;
  selectedProjectJob: DeployJob | null;
  projectConfigText: string;
  onRefresh: () => void;
  onSelectProject: (project: ProjectSummary) => void;
  onConfigChange: (value: string) => void;
  onRedeploy: () => void;
  onNewProject: () => void;
}) {
  const selected = props.selectedProject;
  const projectJob = props.selectedProjectJob || selected?.last_job || null;
  const projectEvents = projectJob ? jobToEvents(projectJob) : [];
  const isDeploying = projectJob ? ["queued", "running", "submitting"].includes(projectJob.status) : false;
  return (
    <section className="grid grid-cols-[minmax(0,0.9fr)_minmax(420px,1.1fr)] gap-4 max-xl:grid-cols-1">
      <div className="rounded-[36px] border border-white/5 bg-[#12121A]/80 p-5 shadow-tactile backdrop-blur-md">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-cyan-200/60">Projects</p>
            <h1 className="mt-3 text-5xl font-semibold tracking-[-0.07em]">Your deployments.</h1>
            <p className="mt-2 text-sm text-white/45">Saved per account. Open a project to inspect, edit config, and redeploy.</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={props.onRefresh} className="rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 text-sm text-white/70 transition-all duration-200 hover:text-white">
              {props.busy === "projects" ? "Refreshing..." : "Refresh"}
            </button>
            <button type="button" onClick={props.onNewProject} className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-[#0B0B0F]">
              New project
            </button>
          </div>
        </div>

        <div className="grid gap-3">
          {props.busy === "projects" && !props.projects.length && Array.from({ length: 4 }, (_, index) => <div key={index} className="h-24 animate-pulse rounded-3xl bg-white/[0.04]" />)}
          {props.projects.map((project) => {
            const active = selected?.deployment_id === project.deployment_id;
            const status = String(project.status || project.last_job?.status || "unknown");
            return (
              <button
                key={project.deployment_id}
                type="button"
                onClick={() => props.onSelectProject(project)}
                className={`group rounded-3xl border p-4 text-left transition-all duration-200 ${active ? "border-cyan-300/35 bg-cyan-300/10 shadow-glow" : "border-white/5 bg-white/[0.035] hover:border-cyan-300/20 hover:bg-white/[0.055]"}`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <strong className="block truncate text-lg text-white">{project.app_name}</strong>
                    <span className="mt-1 block truncate font-mono text-xs text-white/40">{project.github_url || project.namespace}</span>
                  </div>
                  <span className="rounded-full border border-white/5 bg-[#0B0B0F]/50 px-3 py-1 font-mono text-xs uppercase tracking-[0.14em] text-cyan-100/70">{status}</span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2 font-mono text-xs text-white/40">
                  <span>{project.deployment_config?.ci_cd_branch || project.git_revision || "default branch"}</span>
                  {project.url && <span className="truncate text-cyan-100/60">{project.url}</span>}
                  {project.updated_at && <span>{new Date(project.updated_at).toLocaleString()}</span>}
                </div>
              </button>
            );
          })}
          {!props.projects.length && props.busy !== "projects" && (
            <div className="rounded-3xl border border-dashed border-white/10 p-8 text-center">
              <p className="text-white/60">No saved projects for this account yet.</p>
              <button type="button" onClick={props.onNewProject} className="mt-4 rounded-2xl bg-white px-4 py-3 font-semibold text-[#0B0B0F]">Deploy your first project</button>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-[36px] border border-white/5 bg-[#12121A]/85 p-5 shadow-tactile backdrop-blur-md">
        {!selected ? (
          <div className="grid min-h-[420px] place-items-center rounded-[28px] border border-dashed border-white/10 text-center text-white/45">
            Select a project to edit its saved deployment configuration.
          </div>
        ) : (
          <div>
            <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="font-mono text-xs uppercase tracking-[0.24em] text-cyan-200/60">Project detail</p>
                <h2 className="mt-2 text-4xl font-semibold tracking-[-0.06em] text-white">{selected.app_name}</h2>
                <p className="mt-2 break-all font-mono text-xs text-white/40">{selected.deployment_id}</p>
              </div>
              {selected.url && (
                <a href={selected.url} target="_blank" rel="noreferrer" className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 px-4 py-3 text-sm text-cyan-100">
                  Open URL
                </a>
              )}
            </div>

            <div className="mb-4 grid gap-3 md:grid-cols-3">
              <InfoTile label="Repository" value={selected.github_url || "unknown"} />
              <InfoTile label="Branch" value={selected.deployment_config?.ci_cd_branch || selected.git_revision || "default"} />
              <InfoTile label="Components" value={String(selected.components?.length || selected.deployment_config?.components?.length || 1)} />
            </div>

            {projectJob && (
              <div className="mb-4 rounded-3xl border border-white/5 bg-white/[0.025] p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="font-mono text-xs uppercase tracking-[0.22em] text-cyan-200/60">Latest deployment job</p>
                    <p className="mt-1 font-mono text-xs text-white/40">{projectJob.job_id}</p>
                  </div>
                  <span className={`rounded-full border px-3 py-1 font-mono text-xs uppercase tracking-[0.14em] ${projectJob.status === "failed" ? "border-rose-300/20 bg-rose-300/10 text-rose-100" : projectJob.status === "succeeded" ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-100" : "border-cyan-300/20 bg-cyan-300/10 text-cyan-100"}`}>
                    {projectJob.status}
                  </span>
                </div>
                {projectJob.logs?.some((line) => line.toLowerCase().includes("ci/cd redeploy triggered")) && (
                  <p className="mb-3 rounded-2xl border border-cyan-300/10 bg-cyan-300/[0.06] px-4 py-3 text-sm text-cyan-100/70">
                    This redeploy was triggered automatically by a GitHub push.
                  </p>
                )}
                <LogTerminal events={projectEvents} streaming={isDeploying} />
              </div>
            )}

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-white/60">Saved deployment config</span>
              <textarea
                value={props.projectConfigText}
                onChange={(event) => props.onConfigChange(event.target.value)}
                spellCheck={false}
                className="h-[420px] w-full resize-none rounded-3xl border border-white/5 bg-[#08080C] p-4 font-mono text-xs leading-6 text-white/70 outline-none"
              />
            </label>
            <button
              type="button"
              onClick={props.onRedeploy}
              disabled={props.busy === "project-redeploy" || !props.projectConfigText.trim()}
              className="mt-4 w-full rounded-2xl bg-gradient-to-r from-violet-500 to-cyan-400 px-5 py-3 font-semibold text-[#0B0B0F] shadow-glow disabled:cursor-not-allowed disabled:opacity-40"
            >
              {props.busy === "project-redeploy" ? "Redeploying..." : "Redeploy with this config"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.035] p-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">{label}</p>
      <p className="mt-2 truncate text-sm text-white/70">{value}</p>
    </div>
  );
}

function SourceView(props: {
  busy: string;
  query: string;
  repositories: RepositorySummary[];
  repoUrl: string;
  revision: string;
  onQueryChange: (value: string) => void;
  onRepoUrlChange: (value: string) => void;
  onRevisionChange: (value: string) => void;
  onSelectRepository: (repository: RepositorySummary) => void;
  onInspectManual: () => void;
}) {
  return (
    <section className="rounded-[36px] border border-white/5 bg-[#12121A]/80 p-5 shadow-tactile backdrop-blur-md">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div><p className="font-mono text-xs uppercase tracking-[0.24em] text-cyan-200/60">Source</p><h1 className="mt-3 text-5xl font-semibold tracking-[-0.07em]">Choose a repository.</h1></div>
        <input value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} placeholder="Search repositories" className="w-72 rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 text-white outline-none placeholder:text-white/25" />
      </div>
      <div className="grid max-h-[440px] gap-3 overflow-auto pr-1">
        {props.busy === "repos" && Array.from({ length: 6 }, (_, index) => <div key={index} className="h-20 animate-pulse rounded-3xl bg-white/[0.04]" />)}
        {props.repositories.map((repo) => (
          <button key={repo.id} type="button" onClick={() => props.onSelectRepository(repo)} className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-3xl border border-white/5 bg-white/[0.035] p-4 text-left transition-all duration-200 hover:border-cyan-300/25 hover:bg-white/[0.055]">
            <div><strong className="block text-white">{repo.fullName}</strong><span className="font-mono text-xs text-white/40">{repo.private ? "private" : "public"} / {repo.defaultBranch}</span></div>
            {repo.isMonorepo && <span className="rounded-full border border-violet-300/20 bg-violet-400/10 px-3 py-1 font-mono text-xs text-violet-100">monorepo</span>}
          </button>
        ))}
        {!props.repositories.length && props.busy !== "repos" && <div className="rounded-3xl border border-dashed border-white/10 p-8 text-center text-white/45">Connect GitHub or paste a repository URL below.</div>}
      </div>
      <div className="mt-5 grid grid-cols-[minmax(0,1fr)_180px_auto] gap-3 max-md:grid-cols-1">
        <input value={props.repoUrl} onChange={(event) => props.onRepoUrlChange(event.target.value)} placeholder="https://github.com/acme/repo" className="rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 text-white outline-none" />
        <input value={props.revision} onChange={(event) => props.onRevisionChange(event.target.value)} placeholder="default branch" className="rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 text-white outline-none" />
        <button type="button" onClick={props.onInspectManual} disabled={!props.repoUrl || props.busy === "inspect"} className="rounded-2xl bg-white px-4 py-3 font-semibold text-[#0B0B0F]">{props.busy === "inspect" ? "Inspecting..." : "Inspect"}</button>
      </div>
    </section>
  );
}

function InspectionLoading() {
  return <ServiceDetectionGrid services={[]} selectedServiceId={null} loading onSelectService={() => undefined} onToggleDeploy={() => undefined} />;
}

function BlueprintView(props: {
  busy: string;
  services: DetectedService[];
  selectedServiceId: string | null;
  selectedService: DetectedService | null;
  selectedDependency: ManagedDependencyKind | null;
  communications: ServiceCommunication[];
  onSelectService: (serviceId: string) => void;
  onSelectDependency: (dependency: ManagedDependencyKind) => void;
  onUpdateService: (serviceId: string, patch: Partial<DetectedService>) => void;
  onDeploy: () => void;
}) {
  const selectedCount = props.services.filter((service) => service.deploy).length;
  return (
    <section className="grid grid-cols-[minmax(0,1fr)_420px] items-start gap-4 max-xl:grid-cols-1">
      <div className="rounded-[36px] border border-white/5 bg-white/[0.025] p-5 shadow-tactile backdrop-blur-md">
        <div className="mb-5 flex items-end justify-between gap-4"><div><p className="font-mono text-xs uppercase tracking-[0.24em] text-cyan-200/60">Intelligence</p><h1 className="mt-3 text-5xl font-semibold tracking-[-0.07em]">Detected services.</h1><p className="mt-2 font-mono text-xs uppercase tracking-[0.16em] text-white/35">{selectedCount} of {props.services.length} selected for deployment</p></div><button type="button" onClick={props.onDeploy} disabled={props.busy === "deploy" || selectedCount === 0} className="rounded-2xl bg-gradient-to-r from-violet-500 to-cyan-400 px-5 py-3 font-semibold text-[#0B0B0F] shadow-glow disabled:cursor-not-allowed disabled:opacity-40">{props.busy === "deploy" ? "Igniting..." : `Deploy ${selectedCount || ""}`}</button></div>
        <ArchitectureGraph services={props.services} communications={props.communications} selectedServiceId={props.selectedServiceId} selectedDependency={props.selectedDependency} onSelectService={props.onSelectService} onSelectDependency={props.onSelectDependency} onToggleDeploy={(serviceId, deploy) => props.onUpdateService(serviceId, { deploy })} />
        <ServiceDetectionGrid services={props.services} selectedServiceId={props.selectedServiceId} onSelectService={props.onSelectService} onToggleDeploy={(serviceId, deploy) => props.onUpdateService(serviceId, { deploy })} />
      </div>
      <BlueprintPanel service={props.selectedService} selectedDependency={props.selectedDependency} services={props.services} onChange={props.onUpdateService} />
    </section>
  );
}

function IgnitionView(props: { status: DeploymentStatus; currentStep: number; events: DeploymentEvent[]; job: DeployJob | null; onOpenDashboard: () => void }) {
  const steps = ["Provisioning", "Building", "Routing", "Live"];
  return (
    <section className="grid grid-cols-[380px_minmax(0,1fr)] gap-4 max-xl:grid-cols-1">
      <div className="rounded-[36px] border border-white/5 bg-[#12121A]/85 p-6 shadow-tactile backdrop-blur-md">
        <p className="font-mono text-xs uppercase tracking-[0.24em] text-cyan-200/60">Ignition</p>
        <h1 className="mt-3 text-5xl font-semibold tracking-[-0.07em]">Deployment pipeline.</h1>
        <div className="mt-8 space-y-4">
          {steps.map((step, index) => <div key={step} className="flex items-center gap-4"><span className={`grid h-10 w-10 place-items-center rounded-2xl border font-mono text-sm ${index <= props.currentStep ? "border-cyan-300/30 bg-cyan-300/10 text-cyan-100" : "border-white/5 bg-white/[0.03] text-white/30"}`}>{index + 1}</span><span className={index <= props.currentStep ? "text-white" : "text-white/35"}>{step}</span></div>)}
        </div>
        <button type="button" onClick={props.onOpenDashboard} className="mt-8 w-full rounded-2xl border border-white/5 bg-white/[0.04] px-4 py-3 text-white/70">Open command center</button>
      </div>
      <div className="space-y-4">
        <FailureDiagnostics job={props.job} />
        <LogTerminal events={props.events} streaming={props.status !== "ready" && props.status !== "failed"} />
      </div>
    </section>
  );
}

function FailureDiagnostics({ job }: { job: DeployJob | null }) {
  if (!job || (job.status !== "failed" && !job.failure_summary && !job.runtime_failure)) {
    return null;
  }

  const failure = job.runtime_failure;
  const containers = failure?.pods.flatMap((pod) =>
    pod.containers.map((container) => ({ pod: pod.name, ...container }))
  ) ?? [];
  const primaryContainer = containers.find((container) => container.error_line) || containers[0];
  const logs = primaryContainer?.current_logs || primaryContainer?.previous_logs || "";

  return (
    <section className="rounded-[30px] border border-rose-300/15 bg-rose-400/[0.06] p-5 shadow-tactile backdrop-blur-md">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-rose-200/70">Deployment failure</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.05em] text-white">{job.failure_summary || failure?.summary || job.error || "Deployment failed"}</h2>
        </div>
        <span className="rounded-full border border-rose-200/10 bg-rose-300/10 px-3 py-1 font-mono text-xs uppercase tracking-[0.16em] text-rose-100">failed</span>
      </div>

      {primaryContainer && (
        <div className="mt-4 grid gap-3 rounded-2xl border border-white/5 bg-[#0B0B0F]/70 p-4 font-mono text-sm">
          <div className="grid gap-2 md:grid-cols-3">
            <span className="text-white/45">pod <strong className="text-white/80">{primaryContainer.pod}</strong></span>
            <span className="text-white/45">container <strong className="text-white/80">{primaryContainer.name}</strong></span>
            <span className="text-white/45">restarts <strong className="text-white/80">{primaryContainer.restarts}</strong></span>
          </div>
          {primaryContainer.state && <p className="text-amber-100/80">state: {primaryContainer.state}</p>}
          {primaryContainer.error_line && <p className="text-rose-100">error: {primaryContainer.error_line}</p>}
        </div>
      )}

      {logs && (
        <pre className="mt-4 max-h-56 overflow-auto rounded-2xl border border-white/5 bg-[#08080C] p-4 font-mono text-xs leading-6 text-white/65">{logs}</pre>
      )}

      {!!failure?.events.length && (
        <div className="mt-4 space-y-2">
          {failure.events.slice(-5).map((event, index) => (
            <div key={`${event.timestamp}-${index}`} className="rounded-2xl border border-white/5 bg-white/[0.03] px-4 py-3 text-sm text-white/60">
              <span className="font-mono text-cyan-100/70">{event.reason}</span> {event.object}: {event.message}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function CommandCenterView({ productionUrl }: { productionUrl: string }) {
  const url = productionUrl || "https://pending.b3cloud.local";
  return (
    <section className="grid grid-cols-[minmax(0,1fr)_360px] gap-4 max-xl:grid-cols-1">
      <a href={url.startsWith("http") ? url : `https://${url}`} target="_blank" rel="noreferrer" className="group overflow-hidden rounded-[36px] border border-white/5 bg-[#12121A]/85 p-5 shadow-tactile backdrop-blur-md">
        <p className="font-mono text-xs uppercase tracking-[0.24em] text-cyan-200/60">Production URL</p>
        <h1 className="mt-3 break-all text-5xl font-semibold tracking-[-0.07em] text-white group-hover:text-cyan-100">{url}</h1>
        <div className="mt-8 aspect-video rounded-[28px] border border-white/5 bg-gradient-to-br from-white/[0.08] to-white/[0.02] p-3"><div className="h-full rounded-2xl bg-[#0B0B0F] bg-[radial-gradient(circle_at_50%_0%,rgba(34,211,238,0.14),transparent_22rem)]" /></div>
      </a>
      <div className="space-y-4">
        <MetricChart title="CPU" value="18%" color="#22D3EE" />
        <MetricChart title="Bandwidth" value="1.2GB" color="#8B5CF6" />
        <MetricChart title="Latency" value="42ms" color="#2DD4BF" />
      </div>
    </section>
  );
}

function MetricChart({ title, value, color }: { title: string; value: string; color: string }) {
  const points = "0,70 30,55 60,62 90,34 120,42 150,24 180,30 210,18 240,28";
  return <div className="rounded-[28px] border border-white/5 bg-[#12121A]/85 p-5 shadow-tactile"><div className="flex items-center justify-between"><span className="text-white/55">{title}</span><strong className="font-mono text-white">{value}</strong></div><svg viewBox="0 0 240 90" className="mt-4 h-24 w-full"><polyline points={points} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /><polyline points={`${points} 240,90 0,90`} fill={color} opacity="0.08" /></svg></div>;
}

function UnavailableShell({ apiStatus }: { apiStatus: string }) {
  return <DarkShell apiStatus={apiStatus} error="" onDismissError={() => undefined}><div className="rounded-[36px] border border-white/5 bg-[#12121A]/85 p-8 shadow-tactile"><h1 className="text-5xl font-semibold tracking-[-0.07em]">Supabase is not configured.</h1><p className="mt-4 text-white/55">Add B3_SUPABASE_URL and B3_SUPABASE_ANON_KEY, then rebuild.</p></div></DarkShell>;
}

function toRepositorySummary(repo: GithubRepo): RepositorySummary {
  return { id: String(repo.id), fullName: repo.full_name, url: repo.html_url, defaultBranch: repo.default_branch || "main", private: repo.private, language: repo.language ?? undefined, updatedAt: repo.updated_at, isMonorepo: repo.size > 40000 || /mono|workspace|platform/i.test(repo.full_name) };
}

function analysisToArchitecture(result: AnalyzeResult): { services: DetectedService[]; communications: ServiceCommunication[] } {
  const components = result.components.length ? result.components : [];
  const services = components.map((component) => componentToService(component, result));
  const byPath = new Map(components.map((component, index) => [component.path, services[index]]));
  const envByPath = new Map(components.map((component) => [component.path, new Set(component.env.map((item) => item.name))]));
  const communications: ServiceCommunication[] = [];

  for (const link of result.communications ?? []) {
    const source = byPath.get(link.source_path);
    const target = byPath.get(link.target_path);
    if (!source || !target) continue;
    const detectedSourceEnv = envByPath.get(link.source_path) ?? new Set<string>();
    const displayedEnvNames = link.env_names.filter((name) => detectedSourceEnv.has(name));
    const communication: ServiceCommunication = {
      id: `${source.id}->${target.id}`,
      sourceServiceId: source.id,
      targetServiceId: target.id,
      sourceName: source.name,
      targetName: target.name,
      envNames: displayedEnvNames,
      confidence: link.confidence === "high" ? "high" : link.confidence === "low" ? "low" : "medium",
      evidence: link.evidence,
    };
    communications.push(communication);
    source.communicationEnv = mergeAutoEnv(
      source.communicationEnv,
      displayedEnvNames.map((key) => ({
        key,
        source: `communication with ${target.name}`,
        secret: false,
        evidence: link.evidence,
      }))
    );
  }

  return { services, communications };
}

function componentToService(component: AnalyzedComponent, result: AnalyzeResult): DetectedService {
  const weakGenericName = component.name === "app" && component.path === ".";
  return {
    id: `${component.path}-${component.name}`,
    name: weakGenericName ? result.app_name || result.repo_name || component.name : component.name,
    deploy: true,
    publicEndpoint: component.public,
    publicHost: component.public ? componentPublicHost(component, result) : "",
    apiPathPrefix: component.type === "frontend" ? "/api" : "",
    kind: inferKind(component),
    path: component.path,
    port: component.port,
    confidence: component.confidence === "high" ? "high" : component.confidence === "low" || component.port_confidence === "default" ? "low" : "medium",
    framework: component.framework || inferFramework(component),
    buildCommand: component.build_plan?.build_command || (component.type === "frontend" ? "npm run build" : ""),
    outputDirectory: component.build_plan?.output_dir || (component.type === "frontend" ? "dist" : ""),
    env: component.env.filter((item) => item.required && !item.platform_managed).map((item) => ({ id: item.name, key: item.name, value: "", secret: item.secret, required: item.required, source: item.source, evidence: item.evidence })),
    instanceSize: "micro",
    monthlyEstimateUsd: component.type === "frontend" ? 9 : 18,
    dependencies: component.services.filter(isManagedDependency).map((service) => ({
      type: service.type,
      confidence: service.confidence,
      evidence: service.evidence,
      provision: service.provision,
    })),
    automaticEnv: autoEnvForComponent(component),
    communicationEnv: [],
    warnings: [
      ...(component.warnings || []),
      ...(component.build_plan?.runtime_mode ? [`Build plan: ${component.build_plan.runtime_mode} (${component.build_plan.confidence || "medium"} confidence).`] : []),
    ],
  };
}

function componentPublicHost(component: AnalyzedComponent, result: AnalyzeResult): string {
  const repoDomain = result.domain || "";
  if (!repoDomain) return "";
  if (component.path === "." || !result.components || result.components.length <= 1) {
    return repoDomain;
  }
  const componentName = sanitizeHostnamePart(component.name || component.path.split("/").filter(Boolean).pop() || "app");
  const repoName = sanitizeHostnamePart(result.app_name || result.repo_name || repoDomain.split(".")[0] || "app");
  const rootDomain = repoDomain.split(".").slice(1).join(".");
  return rootDomain ? `${componentName}-${repoName}.${rootDomain}` : `${componentName}-${repoName}`;
}

function sanitizeHostnamePart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "app";
}

function mergeAutoEnv(current: AutoEnvVar[], next: AutoEnvVar[]): AutoEnvVar[] {
  const byKey = new Map(current.map((item) => [item.key, item]));
  for (const item of next) {
    const existing = byKey.get(item.key);
    byKey.set(item.key, existing ? { ...existing, evidence: [...(existing.evidence || []), ...(item.evidence || [])].slice(0, 6) } : item);
  }
  return [...byKey.values()];
}

function visibleServiceCommunicationEnv(service: DetectedService | null, services: DetectedService[], communications: ServiceCommunication[]): DetectedService | null {
  if (!service) return null;
  const selected = new Set(services.filter((item) => item.deploy).map((item) => item.id));
  const visibleEnvNames = new Set(
    communications
      .filter((link) => link.sourceServiceId === service.id && selected.has(link.sourceServiceId) && selected.has(link.targetServiceId))
      .flatMap((link) => link.envNames)
  );
  return {
    ...service,
    communicationEnv: service.communicationEnv.filter((item) => visibleEnvNames.has(item.key)),
  };
}

function isManagedDependency(service: { type: ServiceType | string }): service is { type: ManagedDependencyKind; confidence: string; evidence: string[]; provision: boolean } {
  return ["postgres", "mysql", "mongodb", "redis", "rabbitmq"].includes(service.type);
}

const autoEnvByDependency: Record<ManagedDependencyKind, string[]> = {
  postgres: ["DATABASE_URL", "DB_HOST", "DB_NAME", "DB_PASSWORD", "DB_PORT", "DB_USER", "POSTGRES_URL", "POSTGRES_HOST", "POSTGRES_DB", "POSTGRES_PASSWORD", "POSTGRES_USER"],
  mysql: ["DATABASE_URL", "DB_HOST", "DB_NAME", "DB_PASSWORD", "DB_PORT", "DB_USER", "MYSQL_URL", "MYSQL_HOST", "MYSQL_DATABASE", "MYSQL_PASSWORD", "MYSQL_USER"],
  mongodb: ["DATABASE_URL", "DB_HOST", "DB_NAME", "DB_PASSWORD", "DB_PORT", "DB_USER", "MONGODB_URI", "MONGO_URI", "MONGO_URL", "MONGODB_HOST", "MONGODB_DATABASE", "MONGODB_PASSWORD", "MONGODB_USER", "MONGO_INITDB_DATABASE", "MONGO_INITDB_ROOT_PASSWORD", "MONGO_INITDB_ROOT_USERNAME"],
  redis: ["REDIS_URL", "REDIS_HOST"],
  rabbitmq: ["RABBITMQ_URL", "AMQP_URL"],
};

function autoEnvForComponent(component: AnalyzedComponent): AutoEnvVar[] {
  const env: AutoEnvVar[] = [
    { key: "PORT", source: "platform runtime", secret: false, evidence: ["Injected by b3cloud to match the Kubernetes Service target port."] },
  ];
  const managedDependencies = component.services.filter(isManagedDependency).map((dependency) => dependency.type);
  for (const item of component.env.filter((item) => item.platform_managed)) {
    const owningDependency = managedDependencies.find((dependency) => autoEnvByDependency[dependency].includes(item.name));
    if (owningDependency && !env.some((existing) => existing.key === item.name)) {
      env.push({
        key: item.name,
        source: `${owningDependency} managed service`,
        secret: item.secret,
        evidence: item.evidence,
      });
    }
  }
  return env;
}

function inferKind(component: AnalyzedComponent): ServiceKind {
  const language = (component.language || "").toLowerCase();
  const framework = (component.framework || "").toLowerCase();
  const evidence = [...component.evidence, ...component.port_evidence, component.name, component.path].join(" ").toLowerCase();
  if (framework.includes("next")) return "nextjs";
  if (framework.includes("react") || component.type === "frontend") return "react";
  if (language === "php") return "php";
  if (language === "java") return "java";
  if (language === "python" || evidence.includes("python")) return "python";
  if (language === "go" || evidence.includes("go module") || evidence.includes("go.mod")) return "go";
  if (component.type === "worker") return "worker";
  if (framework.includes("express") || framework.includes("fastify") || framework.includes("nestjs") || evidence.includes("backend javascript")) return "node";
  return "unknown";
}

function inferFramework(component: AnalyzedComponent): string {
  if (component.port_confidence === "default" && component.evidence.includes("deployable project marker")) {
    return "Needs confirmation";
  }
  return component.type;
}

function jobToEvents(job: DeployJob): DeploymentEvent[] {
  return (job.logs || []).map((line, index) => ({ id: `${job.job_id}-${index}`, timestamp: job.updated_at || job.created_at || new Date().toISOString(), level: line.toLowerCase().includes("failed") || line.toLowerCase().includes("error") ? "error" : "info", message: line }));
}

function mergeProjectSummary(projects: ProjectSummary[], next: ProjectSummary): ProjectSummary[] {
  const found = projects.some((project) => project.deployment_id === next.deployment_id);
  const merged = found
    ? projects.map((project) => project.deployment_id === next.deployment_id ? next : project)
    : [next, ...projects];
  return merged.sort((a, b) => String(b.updated_at || b.last_job?.updated_at || "").localeCompare(String(a.updated_at || a.last_job?.updated_at || "")));
}

function demoEvents(status: DeploymentStatus): DeploymentEvent[] {
  const now = new Date().toISOString();
  return ["queued deployment", "provisioning namespace", "building image", "configuring route", status === "ready" ? "\u001b[32mdeployment live\u001b[0m" : "waiting for next event"].map((message, index) => ({ id: `demo-${index}-${status}`, timestamp: now, level: index === 4 && status === "ready" ? "success" : "info", message, ansi: message }));
}

function mapJobStatus(status: DeployJob["status"]): DeploymentStatus {
  if (status === "succeeded") return "ready";
  if (status === "failed") return "failed";
  if (status === "running") return "building";
  return "queued";
}

function deploymentStep(status: DeploymentStatus): number {
  if (status === "queued" || status === "provisioning") return 0;
  if (status === "building") return 1;
  if (status === "routing") return 2;
  if (status === "ready") return 3;
  return 0;
}

function deploymentUrl(job: DeployJob | null): string {
  const resultUrl = typeof job?.result?.url === "string" ? job.result.url : "";
  if (resultUrl) return resultUrl;
  const components = Array.isArray(job?.result?.components) ? job.result.components : [];
  const componentUrl = components
    .map((component) => (component && typeof component === "object" && "url" in component ? component.url : ""))
    .find((url): url is string => typeof url === "string" && Boolean(url));
  if (componentUrl) return componentUrl;
  return job?.domain ? `https://${job.domain}` : "";
}

function readError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
