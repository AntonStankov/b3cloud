const apiKeyInput = document.getElementById("api-key");
const apiKeyState = document.getElementById("api-key-state");
const consoleOutput = document.getElementById("console-output");
const statusOutput = document.getElementById("status-output");
const analysisOutput = document.getElementById("analysis-output");
const componentOptions = document.getElementById("component-options");
const deployState = document.getElementById("deploy-state");
const deployPercent = document.getElementById("deploy-percent");
const deployProgressFill = document.getElementById("deploy-progress-fill");
const deployTimeline = document.getElementById("deploy-timeline");
let activeJobId = null;
let lastJobFingerprint = null;
let latestAnalysis = null;

const els = {
  healthStatus: document.getElementById("health-status"),
  healthDetail: document.getElementById("health-detail"),
  appsCount: document.getElementById("apps-count"),
  namespaceSummary: document.getElementById("namespace-summary"),
  appsNamespace: document.getElementById("apps-namespace"),
  appsTable: document.getElementById("apps-table"),
};

function getApiKey() {
  return localStorage.getItem("b3cloud_user_api_key") || "";
}

function setApiKey(value) {
  localStorage.setItem("b3cloud_user_api_key", value);
}

function log(title, payload) {
  const stamp = new Date().toLocaleTimeString();
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  consoleOutput.textContent = `[${stamp}] ${title}\n${body}\n\n${consoleOutput.textContent}`;
}

function setApiKeyBanner() {
  apiKeyState.textContent = getApiKey() ? "Key saved in this browser." : "Key is kept in this browser only.";
}

async function api(path, options = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error("Set the user API key first.");
  }

  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(data.detail || data.raw || `${response.status} ${response.statusText}`);
  }

  return data;
}

function rowsMarkup(rows, columns) {
  if (!rows.length) {
    return `<tr><td colspan="${columns}" class="muted">No applications found.</td></tr>`;
  }
  return rows.join("");
}

async function refreshHealth() {
  const response = await fetch("/health");
  const data = await response.json();
  els.healthStatus.textContent = data.status;
  els.healthDetail.textContent = "User API reachable";
}

async function refreshApps() {
  const namespace = els.appsNamespace.value.trim();
  const query = namespace ? `?namespace=${encodeURIComponent(namespace)}` : "";
  const data = await api(`/apps${query}`);
  els.appsCount.textContent = String(data.length);
  els.namespaceSummary.textContent = namespace || "All";
  els.appsTable.innerHTML = rowsMarkup(
    data.map(
      (app) => `<tr>
        <td>${app.namespace}</td>
        <td>${app.app_name}</td>
        <td>${app.ready_replicas}</td>
        <td>${app.replicas}</td>
        <td>${app.image || "-"}</td>
      </tr>`
    ),
    5
  );
  log("Apps", data);
}

async function refreshAll() {
  await refreshHealth();
  await refreshApps();
}

async function pollJob(jobId) {
  activeJobId = jobId;
  lastJobFingerprint = null;
  while (activeJobId === jobId) {
    const job = await api(`/deploy-jobs/${encodeURIComponent(jobId)}`);
    statusOutput.textContent = JSON.stringify(job, null, 2);
    renderDeployProgress(job);
    const fingerprint = JSON.stringify({
      status: job.status,
      updated_at: job.updated_at,
      last_log: Array.isArray(job.logs) && job.logs.length ? job.logs[job.logs.length - 1] : null,
    });
    if (fingerprint !== lastJobFingerprint) {
      lastJobFingerprint = fingerprint;
      log("Deploy Job", {
        job_id: job.job_id,
        status: job.status,
        updated_at: job.updated_at,
        last_log: Array.isArray(job.logs) && job.logs.length ? job.logs[job.logs.length - 1] : null,
      });
    }
    if (job.status === "succeeded" || job.status === "failed") {
      activeJobId = null;
      lastJobFingerprint = null;
      await refreshApps();
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

async function deployApp(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const githubUrl = String(form.get("github_url") || "").trim();
  const repoName = repoNameFromGithubUrl(githubUrl);
  const namespace = sanitizeName(repoName);
  const appName = sanitizeName(repoName);
  const envRaw = String(form.get("env") || "").trim();
  const provisionServices = form.getAll("provision_services").map((value) => String(value));
  const selectedComponents = selectedDeployComponents();
  const payload = {
    github_url: githubUrl,
    git_revision: form.get("git_revision") || "main",
    port: Number(form.get("port") || 8080),
    node_arch: form.get("node_arch") || null,
    auto_detect_services: form.get("auto_detect_services") === "on",
    provision_services: provisionServices,
    components: selectedComponents,
    env: envRaw ? JSON.parse(envRaw) : {},
    resources: {
      cpu_request: form.get("cpu_request"),
      cpu_limit: form.get("cpu_limit"),
      memory_request: form.get("memory_request"),
      memory_limit: form.get("memory_limit"),
    },
  };
  statusOutput.textContent = JSON.stringify(
    {
      status: "submitting",
      namespace,
      app_name: appName,
      detail: "Submitting async deploy job.",
    },
    null,
    2
  );
  renderDeployProgress({
    status: "submitting",
    logs: ["Submitting deployment request."],
    updated_at: new Date().toISOString(),
  });
  log("Deploy started", payload);
  const job = await api("/apps/deploy", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  statusOutput.textContent = JSON.stringify(job, null, 2);
  renderDeployProgress(job);
  log("Deploy queued", job);
  await pollJob(job.job_id);
}

const progressMilestones = [
  { key: "queued", label: "Queued", weight: 5, match: /job queued|queued/i },
  { key: "started", label: "Started", weight: 10, match: /deploy job started|deploying component/i },
  { key: "analyze", label: "Analyzed repository", weight: 18, match: /analyzing|detected services|cloning source repo .*service detection/i },
  { key: "namespace", label: "Prepared namespace", weight: 26, match: /preparing namespace/i },
  { key: "services", label: "Provisioned internal services", weight: 38, match: /provisioning internal backing services/i },
  { key: "registry", label: "Authenticated registry", weight: 45, match: /logging in to registry|seeding registry/i },
  { key: "clone", label: "Cloned source", weight: 52, match: /cloning source repo|retrying clone|using app path/i },
  { key: "build", label: "Build running", weight: 68, match: /running buildpacks|pack build|running Buildpacks publish/i },
  { key: "image", label: "Image published", weight: 78, match: /image published/i },
  { key: "kubernetes", label: "Applied Kubernetes resources", weight: 88, match: /applying kubernetes/i },
  { key: "route", label: "Configured public route", weight: 94, match: /ensuring cloudflare route/i },
  { key: "done", label: "Deployment complete", weight: 100, match: /deploy job finished successfully|deployment finished/i },
];

function renderDeployProgress(job) {
  const logs = Array.isArray(job.logs) ? job.logs : [];
  const status = String(job.status || "unknown");
  const reached = new Set();
  for (const entry of logs) {
    for (const milestone of progressMilestones) {
      if (milestone.match.test(String(entry))) {
        reached.add(milestone.key);
      }
    }
  }
  if (status === "queued") {
    reached.add("queued");
  }
  if (status === "running") {
    reached.add("started");
  }
  if (status === "succeeded") {
    progressMilestones.forEach((milestone) => reached.add(milestone.key));
  }

  let percent = progressMilestones.reduce(
    (current, milestone) => (reached.has(milestone.key) ? Math.max(current, milestone.weight) : current),
    status === "submitting" ? 2 : 0
  );
  deployState.textContent = statusLabel(status);
  deployPercent.textContent = `${percent}%`;
  deployProgressFill.style.width = `${percent}%`;
  deployProgressFill.dataset.status = status;
  deployTimeline.innerHTML = progressMilestones
    .filter((milestone) => reached.has(milestone.key) || status !== "idle")
    .map((milestone) => {
      const state = reached.has(milestone.key) ? "done" : "pending";
      return `<li class="${state}">${escapeHtml(milestone.label)}</li>`;
    })
    .join("");
  if (status === "failed") {
    deployTimeline.innerHTML += `<li class="failed">${escapeHtml(job.error || lastLog(logs) || "Deployment failed.")}</li>`;
  }
  if (!deployTimeline.innerHTML) {
    deployTimeline.innerHTML = `<li class="pending">No deployment started.</li>`;
  }
}

function statusLabel(status) {
  const labels = {
    submitting: "Submitting",
    queued: "Queued",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
  };
  return labels[status] || "Idle";
}

function lastLog(logs) {
  return logs.length ? String(logs[logs.length - 1]) : "";
}

async function analyzeRepo() {
  const formEl = document.getElementById("deploy-form");
  const form = new FormData(formEl);
  const githubUrl = String(form.get("github_url") || "").trim();
  if (!githubUrl) {
    throw new Error("Enter the GitHub URL before running detection.");
  }
  const payload = {
    github_url: githubUrl,
    git_revision: form.get("git_revision") || "main",
  };
  analysisOutput.textContent = "Analyzing repository...";
  const analysis = await api("/apps/analyze", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  latestAnalysis = analysis;
  analysisOutput.textContent = JSON.stringify(analysis, null, 2);
  markDetectedServices(analysis.services || []);
  renderComponents(analysis.components || []);
  log("Repository Analysis", analysis);
}

function markDetectedServices(services) {
  const detected = new Set(services.map((service) => service.type));
  document.querySelectorAll('input[name="provision_services"]').forEach((input) => {
    if (detected.has(input.value)) {
      input.checked = true;
    }
  });
}

function renderComponents(components) {
  if (!components.length) {
    componentOptions.innerHTML = `<p class="muted">No deployable components found. The root app path will be used.</p>`;
    return;
  }
  componentOptions.innerHTML = components
    .map((component, index) => {
      const services = (component.services || []).map((service) => service.type).join(", ") || "none";
      const checked = component.type !== "worker" ? "checked" : "";
      const publicSelected = component.public ? "selected" : "";
      const privateSelected = component.public ? "" : "selected";
      const portEvidence = Array.isArray(component.port_evidence) && component.port_evidence.length
        ? component.port_evidence[0]
        : "No port evidence.";
      const envRequirements = Array.isArray(component.env) ? component.env : [];
      const userEnv = envRequirements.filter((item) => !item.platform_managed);
      const envSummary = userEnv.length
        ? userEnv.map((item) => `${item.name}${item.required ? "*" : ""}`).join(", ")
        : "none";
      const envTemplate = Object.fromEntries(userEnv.map((item) => [item.name, ""]));
      return `<article class="component-card">
        <label class="component-main">
          <input type="checkbox" class="component-select" data-index="${index}" ${checked}>
          <span>
            <strong>${escapeHtml(component.name)}</strong>
            <small>${escapeHtml(component.type)} · ${escapeHtml(component.path)} · services: ${escapeHtml(services)}</small>
          </span>
        </label>
        <div class="component-controls">
          <label>
            Port
            <input type="number" class="component-port" data-index="${index}" min="1" max="65535" value="${Number(component.port || 8080)}">
            <small>${escapeHtml(component.port_confidence || "default")}: ${escapeHtml(portEvidence)}</small>
          </label>
          <label>
            Access
            <select class="component-public" data-index="${index}">
              <option value="true" ${publicSelected}>Public</option>
              <option value="false" ${privateSelected}>Private</option>
            </select>
          </label>
        </div>
        <details class="component-env">
          <summary>Environment variables: ${escapeHtml(envSummary)}</summary>
          <small>Fill values as JSON. Platform-managed variables like DATABASE_URL and REDIS_URL are generated and override user input.</small>
          <textarea class="component-env-json" data-index="${index}" rows="6">${escapeHtml(JSON.stringify(envTemplate, null, 2))}</textarea>
        </details>
      </article>`;
    })
    .join("");
}

function selectedDeployComponents() {
  if (!latestAnalysis || !Array.isArray(latestAnalysis.components)) {
    return [];
  }
  const globalServices = new Set(
    new FormData(document.getElementById("deploy-form")).getAll("provision_services").map((value) => String(value))
  );
  const selected = [];
  document.querySelectorAll(".component-select:checked").forEach((input) => {
    const component = latestAnalysis.components[Number(input.dataset.index)];
    if (!component) {
      return;
    }
    const portInput = document.querySelector(`.component-port[data-index="${input.dataset.index}"]`);
    const publicInput = document.querySelector(`.component-public[data-index="${input.dataset.index}"]`);
    const envInput = document.querySelector(`.component-env-json[data-index="${input.dataset.index}"]`);
    const env = parseJsonObject(envInput ? envInput.value : "{}");
    const services = new Set((component.services || []).map((service) => service.type));
    for (const service of globalServices) {
      if (component.type !== "frontend") {
        services.add(service);
      }
    }
    selected.push({
      name: component.name,
      path: component.path,
      type: component.type,
      public: publicInput ? publicInput.value === "true" : Boolean(component.public),
      port: portInput ? Number(portInput.value || 8080) : Number(component.port || 8080),
      auto_detect_services: component.type !== "frontend",
      provision_services: Array.from(services),
      env,
    });
  });
  return selected;
}

function parseJsonObject(raw) {
  const trimmed = String(raw || "").trim();
  if (!trimmed) {
    return {};
  }
  const parsed = JSON.parse(trimmed);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Component environment must be a JSON object.");
  }
  return parsed;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function fetchStatus(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const githubUrl = String(form.get("github_url") || "").trim();
  if (!githubUrl) {
    throw new Error("Enter the GitHub URL.");
  }
  const repoName = repoNameFromGithubUrl(githubUrl);
  const namespace = sanitizeName(repoName);
  const appName = sanitizeName(repoName);
  const data = await api(`/apps/${encodeURIComponent(namespace)}/${encodeURIComponent(appName)}`);
  statusOutput.textContent = JSON.stringify(data, null, 2);
  log("App Status", data);
}

function repoNameFromGithubUrl(githubUrl) {
  const normalized = githubUrl.replace(/\/+$/, "");
  const match = normalized.match(/\/([^/]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`Unsupported github_url format: ${githubUrl}`);
  }
  return match[1];
}

function sanitizeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

function bindClick(id, handler) {
  document.getElementById(id).addEventListener("click", async () => {
    try {
      await handler();
    } catch (error) {
      log(`${id} failed`, String(error));
    }
  });
}

document.getElementById("save-api-key").addEventListener("click", async () => {
  setApiKey(apiKeyInput.value.trim());
  setApiKeyBanner();
  log("Auth", "User API key saved in localStorage.");
  try {
    await refreshAll();
  } catch (error) {
    log("Initial refresh failed", String(error));
  }
});

document.getElementById("deploy-form").addEventListener("submit", async (event) => {
  try {
    await deployApp(event);
  } catch (error) {
    activeJobId = null;
    statusOutput.textContent = JSON.stringify({ status: "failed", detail: String(error) }, null, 2);
    renderDeployProgress({ status: "failed", error: String(error), logs: [String(error)] });
    log("Deploy failed", String(error));
  }
});

document.getElementById("status-form").addEventListener("submit", async (event) => {
  try {
    await fetchStatus(event);
  } catch (error) {
    statusOutput.textContent = JSON.stringify({ status: "failed", detail: String(error) }, null, 2);
    log("Status lookup failed", String(error));
  }
});

document.getElementById("clear-console").addEventListener("click", () => {
  consoleOutput.textContent = "Console cleared.";
});

bindClick("refresh-all", refreshAll);
bindClick("refresh-apps", refreshApps);
bindClick("analyze-repo", analyzeRepo);

apiKeyInput.value = getApiKey();
setApiKeyBanner();
renderDeployProgress({ status: "idle", logs: [] });

if (getApiKey()) {
  refreshAll().catch((error) => log("Initial refresh failed", String(error)));
}
