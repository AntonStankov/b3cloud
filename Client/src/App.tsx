import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  analyze,
  deploy,
  getAppStatus,
  getJob,
  getRuntimeLogs,
  health,
  listApps,
  listJobs,
} from "./api/apps";
import { request } from "./api/client";
import { clearBearerToken, setBearerToken } from "./api/config";
import type {
  AnalyzeResult,
  AnalyzedComponent,
  AppSummary,
  AutoscalingInput,
  ComponentDeployInput,
  DeployJob,
  ResourceLimits,
  RuntimeLogBundle,
} from "./api/types";
import { supabase, supabaseConfigured } from "./supabase";

interface GithubRepo {
  id: number;
  full_name: string;
  html_url: string;
  private: boolean;
  default_branch: string;
  updated_at: string;
  language: string | null;
}

interface ComponentConfig {
  component: AnalyzedComponent;
  public: boolean;
  port: number;
  services: string[];
  env: Record<string, string>;
}

const defaultResources: ResourceLimits = {
  cpu_request: "100m",
  cpu_limit: "500m",
  memory_request: "128Mi",
  memory_limit: "512Mi",
};

const defaultAutoscaling: AutoscalingInput = {
  enabled: true,
  min_replicas: 1,
  max_replicas: 4,
  target_cpu_utilization: 80,
  target_memory_utilization: 80,
};

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [status, setStatus] = useState("Checking platform health...");
  const [githubToken, setGithubToken] = useState("");
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [repoUrl, setRepoUrl] = useState("");
  const [revision, setRevision] = useState("main");
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [components, setComponents] = useState<ComponentConfig[]>([]);
  const [resources, setResources] = useState<ResourceLimits>(defaultResources);
  const [autoscaling, setAutoscaling] = useState<AutoscalingInput>(defaultAutoscaling);
  const [nodeArch, setNodeArch] = useState("amd64");
  const [jobs, setJobs] = useState<DeployJob[]>([]);
  const [activeJobId, setActiveJobId] = useState("");
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [runtimeLogs, setRuntimeLogs] = useState<RuntimeLogBundle | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [view, setView] = useState<"deploy" | "activity" | "operations">("deploy");

  const activeJob = useMemo(
    () => jobs.find((job) => job.job_id === activeJobId) || jobs[0] || null,
    [jobs, activeJobId]
  );

  useEffect(() => {
    health()
      .then((result) => setStatus(result.status === "ok" ? "Platform API is online" : "Platform API returned an unknown state"))
      .catch((err) => setStatus(`Platform health check failed: ${readError(err)}`));
  }, []);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => applySession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => applySession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    void refreshDashboard();
  }, [session]);

  useEffect(() => {
    if (!githubToken) return;
    void loadRepos(githubToken);
  }, [githubToken]);

  useEffect(() => {
    if (!activeJob || !["queued", "running", "submitting"].includes(activeJob.status)) return;
    const timer = window.setInterval(async () => {
      try {
        const next = await getJob(activeJob.job_id);
        setJobs((current) => mergeJob(current, next));
        if (!["queued", "running", "submitting"].includes(next.status)) {
          await refreshDashboard();
        }
      } catch (err) {
        setError(readError(err));
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeJob?.job_id, activeJob?.status]);

  function applySession(nextSession: Session | null) {
    setSession(nextSession);
    const accessToken = nextSession?.access_token || "";
    if (accessToken) setBearerToken(accessToken);
    else clearBearerToken();

    const providerToken = (nextSession as Session & { provider_token?: string } | null)?.provider_token || "";
    setGithubToken(providerToken);
  }

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    if (!supabase) return;
    setAuthError("");
    setBusy("auth");
    try {
      const result =
        authMode === "signup"
          ? await supabase.auth.signUp({ email, password })
          : await supabase.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (authMode === "signup" && !result.data.session) {
        setAuthError("Account created. Confirm your email, then sign in.");
      }
    } catch (err) {
      setAuthError(readError(err));
    } finally {
      setBusy("");
    }
  }

  async function connectGithub() {
    if (!supabase) return;
    setBusy("github");
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: {
        scopes: "repo read:user user:email",
        redirectTo: window.location.origin,
      },
    });
    if (oauthError) {
      setError(oauthError.message);
      setBusy("");
    }
  }

  async function signOut() {
    setGithubToken("");
    clearBearerToken();
    await supabase?.auth.signOut();
  }

  async function loadRepos(token: string) {
    try {
      const response = await fetch("https://api.github.com/user/repos?sort=updated&per_page=60", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
      setRepos(await response.json());
    } catch (err) {
      setError(`GitHub repository loading failed: ${readError(err)}`);
    }
  }

  async function refreshDashboard() {
    if (!session) return;
    try {
      const [nextApps, nextJobs] = await Promise.all([listApps(), listJobs()]);
      setApps(nextApps);
      setJobs(nextJobs);
      if (!activeJobId && nextJobs[0]) setActiveJobId(nextJobs[0].job_id);
    } catch (err) {
      setError(readError(err));
    }
  }

  async function runAnalyze() {
    setError("");
    setBusy("analyze");
    try {
      const result = await analyze({ github_url: repoUrl, git_revision: revision, github_token: githubToken || undefined });
      setAnalysis(result);
      setComponents(result.components.map((component) => ({
        component,
        public: component.public,
        port: component.port,
        services: component.services.filter((service) => service.provision).map((service) => service.type),
        env: Object.fromEntries(
          component.env
            .filter((item) => item.required && !item.platform_managed)
            .map((item) => [item.name, ""])
        ),
      })));
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy("");
    }
  }

  async function submitDeploy() {
    if (!analysis) return;
    setError("");
    setBusy("deploy");
    try {
      const payload = {
        github_url: repoUrl,
        github_token: githubToken || undefined,
        git_revision: revision,
        port: components[0]?.port || 8080,
        node_arch: nodeArch,
        auto_detect_services: true,
        provision_services: [],
        redeploy_services: false,
        env: {},
        resources,
        autoscaling,
        components: components.map<ComponentDeployInput>((item) => ({
          name: item.component.name,
          path: item.component.path,
          type: item.component.type,
          public: item.public,
          port: item.port,
          auto_detect_services: true,
          provision_services: item.services,
          redeploy_services: false,
          env: item.env,
          autoscaling,
        })),
      };
      const job = await deploy(payload);
      setJobs((current) => mergeJob(current, job));
      setActiveJobId(job.job_id);
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy("");
    }
  }

  async function inspectApp(app: AppSummary) {
    setError("");
    setBusy(`logs-${app.namespace}-${app.app_name}`);
    try {
      await getAppStatus(app.namespace, app.app_name);
      setRuntimeLogs(await getRuntimeLogs(app.namespace, app.app_name, 180));
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy("");
    }
  }

  async function deploymentAction(app: AppSummary, action: "start" | "stop" | "delete") {
    setError("");
    setBusy(`${action}-${app.namespace}-${app.app_name}`);
    try {
      const deploymentId = `${app.namespace}:${app.app_name}`;
      if (action === "delete") {
        await request(`/api/v1/deployments/${encodeURIComponent(deploymentId)}`, {
          method: "DELETE",
          body: { delete_data: false },
        });
      } else {
        await request(`/api/v1/deployments/${encodeURIComponent(deploymentId)}/${action}`, { method: "POST" });
      }
      await refreshDashboard();
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy("");
    }
  }

  if (!supabaseConfigured || !supabase) {
    return <Shell status={status}><SetupMissing /></Shell>;
  }

  if (!session) {
    return (
      <Shell status={status}>
        <section className="auth-panel">
          <div className="auth-copy">
            <p className="eyebrow">B3Cloud Client Console</p>
            <h1>Deploy from GitHub into Kubernetes without touching cluster internals.</h1>
            <p>
              Create an account, link GitHub, analyze your repository, provision services, and ship behind automated Cloudflare routing.
            </p>
          </div>
          <form className="auth-card" onSubmit={submitAuth}>
            <div className="segmented">
              <button type="button" className={authMode === "signin" ? "active" : ""} onClick={() => setAuthMode("signin")}>Sign in</button>
              <button type="button" className={authMode === "signup" ? "active" : ""} onClick={() => setAuthMode("signup")}>Create account</button>
            </div>
            <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" required /></label>
            <label>Password<input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete={authMode === "signin" ? "current-password" : "new-password"} minLength={8} required /></label>
            {authError && <p className="notice">{authError}</p>}
            <button className="primary" disabled={busy === "auth"}>{busy === "auth" ? "Working..." : authMode === "signin" ? "Sign in" : "Create secure account"}</button>
            <button className="oauth" type="button" onClick={connectGithub} disabled={busy === "github"}>Continue with GitHub</button>
          </form>
        </section>
      </Shell>
    );
  }

  return (
    <Shell status={status}>
      <div className="console-shell">
        <aside className="console-nav">
          <div className="nav-user">
            <span className="avatar">{session.user.email?.slice(0, 1).toUpperCase() || "U"}</span>
            <div>
              <strong>{session.user.email}</strong>
              <span>{githubToken ? "GitHub linked" : "GitHub not linked"}</span>
            </div>
          </div>
          <button className={view === "deploy" ? "nav-item active" : "nav-item"} onClick={() => setView("deploy")}>
            <span>01</span> Deploy
          </button>
          <button className={view === "activity" ? "nav-item active" : "nav-item"} onClick={() => setView("activity")}>
            <span>02</span> Activity
          </button>
          <button className={view === "operations" ? "nav-item active" : "nav-item"} onClick={() => setView("operations")}>
            <span>03</span> Operations
          </button>
          <div className="nav-footer">
            <span>{status}</span>
            <button onClick={signOut}>Sign out</button>
          </div>
        </aside>

        <section className="console-main">
          {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")}>Dismiss</button></div>}

          {view === "deploy" && (
            <div className="deploy-cockpit">
              <section className="launch-hero">
                <div>
                  <p className="eyebrow">B3Cloud Launch Control</p>
                  <h1>Ship a repo to Kubernetes in one guided flow.</h1>
                  <p>Connect GitHub, pick a repository, let the platform detect components and services, then deploy behind automated Cloudflare routing.</p>
                  <div className="hero-actions">
                    <button className="primary" onClick={connectGithub}>{githubToken ? "Reconnect GitHub" : "Connect GitHub"}</button>
                    <button onClick={() => setView("activity")}>View deploy activity</button>
                  </div>
                </div>
                <div className="signal-card">
                  <span className="signal-dot" />
                  <strong>{githubToken ? "Repository access ready" : "GitHub access required"}</strong>
                  <p>{githubToken ? "Private and public repositories can be analyzed for this session." : "Connect GitHub before deploying private repositories."}</p>
                </div>
              </section>

              <section className="deploy-board">
                <div className="deploy-card source-card">
                  <div className="section-head">
                    <div><p className="eyebrow">Step 1</p><h2>Select source</h2></div>
                    <button onClick={runAnalyze} disabled={!repoUrl || busy === "analyze"}>{busy === "analyze" ? "Analyzing..." : "Analyze"}</button>
                  </div>
                  <div className="repo-rail">
                    {repos.slice(0, 6).map((repo) => (
                      <button key={repo.id} className={repo.html_url === repoUrl ? "repo-pill active" : "repo-pill"} onClick={() => { setRepoUrl(repo.html_url); setRevision(repo.default_branch || "main"); }}>
                        <strong>{repo.full_name}</strong>
                        <span>{repo.private ? "Private" : "Public"} / {repo.language || "Mixed"}</span>
                      </button>
                    ))}
                    {!repos.length && <div className="empty-state">Connect GitHub to see recent repositories, or paste a URL below.</div>}
                  </div>
                  <div className="form-row split">
                    <label>Repository URL<input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/acme/app" /></label>
                    <label>Branch or SHA<input value={revision} onChange={(e) => setRevision(e.target.value)} placeholder="main" /></label>
                    <label>Node class<select value={nodeArch} onChange={(e) => setNodeArch(e.target.value)}><option value="amd64">Intel/AMD CPX</option><option value="arm64">ARM CAX</option></select></label>
                  </div>
                </div>

                <aside className="deploy-aside">
                  <div className="metric-card">
                    <span>Last job</span>
                    <strong>{jobs[0]?.status || "none"}</strong>
                    <button onClick={() => setView("activity")}>Open activity</button>
                  </div>
                  <div className="metric-card">
                    <span>Runtime controls</span>
                    <strong>hidden by default</strong>
                    <button onClick={() => setView("operations")}>Manage apps</button>
                  </div>
                </aside>
              </section>

              {analysis && (
                <section className="deploy-card plan-card">
                  <div className="section-head">
                    <div><p className="eyebrow">Step 2</p><h2>{analysis.repo_name || "Review build plan"}</h2></div>
                    <span className="pill">{analysis.domain}</span>
                  </div>
                  <div className="component-grid refined">
                    {components.map((item, index) => (
                      <article className="component-card" key={`${item.component.path}-${index}`}>
                        <div className="component-title"><strong>{item.component.name}</strong><span>{item.component.type}</span></div>
                        <p>{item.component.path} / port {item.port}</p>
                        <label className="switch"><input type="checkbox" checked={item.public} onChange={(e) => updateComponent(index, { public: e.target.checked })} /> Public route</label>
                        <label>Port<input type="number" value={item.port} onChange={(e) => updateComponent(index, { port: Number(e.target.value) || 8080 })} /></label>
                        <div className="chips">
                          {item.component.services.map((service) => (
                            <label key={service.type} className="chip"><input type="checkbox" checked={item.services.includes(service.type)} onChange={() => toggleService(index, service.type)} />{service.type}</label>
                          ))}
                          {!item.component.services.length && <span className="muted">No backing services detected</span>}
                        </div>
                        {Object.keys(item.env).map((key) => (
                          <label key={key}>{key}<input value={item.env[key]} onChange={(e) => updateEnv(index, key, e.target.value)} placeholder="Required value" /></label>
                        ))}
                      </article>
                    ))}
                  </div>
                  <div className="settings-grid compact">
                    <label>CPU request<input value={resources.cpu_request} onChange={(e) => setResources({ ...resources, cpu_request: e.target.value })} /></label>
                    <label>CPU limit<input value={resources.cpu_limit} onChange={(e) => setResources({ ...resources, cpu_limit: e.target.value })} /></label>
                    <label>Memory request<input value={resources.memory_request} onChange={(e) => setResources({ ...resources, memory_request: e.target.value })} /></label>
                    <label>Memory limit<input value={resources.memory_limit} onChange={(e) => setResources({ ...resources, memory_limit: e.target.value })} /></label>
                    <label>Min replicas<input type="number" value={autoscaling.min_replicas} onChange={(e) => setAutoscaling({ ...autoscaling, min_replicas: Number(e.target.value) || 1 })} /></label>
                    <label>Max replicas<input type="number" value={autoscaling.max_replicas} onChange={(e) => setAutoscaling({ ...autoscaling, max_replicas: Number(e.target.value) || 1 })} /></label>
                  </div>
                  <button className="primary deploy-button" onClick={submitDeploy} disabled={busy === "deploy"}>{busy === "deploy" ? "Submitting deployment..." : "Deploy application"}</button>
                </section>
              )}
            </div>
          )}

          {view === "activity" && (
            <section className="workspace-panel">
              <div className="section-head"><div><p className="eyebrow">Activity</p><h2>Deployment timeline</h2></div><button onClick={refreshDashboard}>Refresh</button></div>
              <div className="job-list">
                {jobs.slice(0, 10).map((job) => <button key={job.job_id} className={activeJob?.job_id === job.job_id ? "job-row active" : "job-row"} onClick={() => setActiveJobId(job.job_id)}><strong>{job.app_name || "deployment"}</strong><span>{job.status}</span><small>{job.updated_at || job.created_at}</small></button>)}
              </div>
              {activeJob ? <LogBox lines={activeJob.logs || []} error={activeJob.error || ""} /> : <div className="empty-state">No deployment jobs yet.</div>}
            </section>
          )}

          {view === "operations" && (
            <section className="workspace-panel">
              <div className="section-head"><div><p className="eyebrow">Operations</p><h2>Manage deployed apps</h2></div><button onClick={refreshDashboard}>Refresh</button></div>
              <div className="app-list operations-list">
                {apps.map((app) => (
                  <article className="app-row" key={`${app.namespace}/${app.app_name}`}>
                    <div><strong>{app.app_name}</strong><span>{app.namespace} / ready {app.ready_replicas}/{app.replicas}</span></div>
                    <div className="row-actions">
                      <button onClick={() => inspectApp(app)}>Logs</button>
                      <button onClick={() => deploymentAction(app, "start")}>Start</button>
                      <button onClick={() => deploymentAction(app, "stop")}>Stop</button>
                      <button className="danger" onClick={() => deploymentAction(app, "delete")}>Delete</button>
                    </div>
                  </article>
                ))}
                {!apps.length && <div className="empty-state">No deployed apps found.</div>}
              </div>
              {runtimeLogs && (
                <section className="runtime-panel">
                  <div className="section-head"><div><p className="eyebrow">Runtime logs</p><h2>{runtimeLogs.app_name}</h2></div><span className="pill">{runtimeLogs.status}</span></div>
                  <LogBox lines={runtimeLogs.pods.flatMap((pod) => pod.containers.flatMap((container) => [`${pod.name}/${container.name}`, container.current_logs || "No logs"] ))} error={runtimeLogs.error_summary || ""} />
                </section>
              )}
            </section>
          )}
        </section>
      </div>
    </Shell>
  );

  function updateComponent(index: number, patch: Partial<ComponentConfig>) {
    setComponents((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  }

  function toggleService(index: number, service: string) {
    setComponents((current) => current.map((item, itemIndex) => {
      if (itemIndex !== index) return item;
      const services = item.services.includes(service)
        ? item.services.filter((value) => value !== service)
        : [...item.services, service];
      return { ...item, services };
    }));
  }

  function updateEnv(index: number, key: string, value: string) {
    setComponents((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, env: { ...item.env, [key]: value } } : item));
  }
}

function Shell({ children, status }: { children: React.ReactNode; status: string }) {
  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <nav className="brandbar">
        <div className="brand-mark">b3</div>
        <div><strong>B3Cloud</strong><span>{status}</span></div>
      </nav>
      {children}
    </div>
  );
}

function SetupMissing() {
  return (
    <section className="auth-panel">
      <div className="auth-copy">
        <p className="eyebrow">Configuration needed</p>
        <h1>Supabase is not configured for this client build.</h1>
        <p>Add `B3_SUPABASE_URL` and `B3_SUPABASE_ANON_KEY` GitHub secrets, then rerun the deployment workflow.</p>
      </div>
    </section>
  );
}

function LogBox({ lines, error }: { lines: string[]; error?: string }) {
  return (
    <pre className="log-box">
      {error ? `ERROR: ${error}\n\n` : ""}
      {lines.join("\n")}
    </pre>
  );
}

function mergeJob(current: DeployJob[], next: DeployJob): DeployJob[] {
  const without = current.filter((job) => job.job_id !== next.job_id);
  return [next, ...without].sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
}

function readError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
