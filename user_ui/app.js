const apiKeyInput = document.getElementById("api-key");
const apiKeyState = document.getElementById("api-key-state");
const consoleOutput = document.getElementById("console-output");
const statusOutput = document.getElementById("status-output");
let activeJobId = null;
let lastJobFingerprint = null;

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
  const payload = {
    github_url: githubUrl,
    git_revision: form.get("git_revision") || "main",
    port: Number(form.get("port") || 8080),
    node_arch: form.get("node_arch") || null,
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
  log("Deploy started", payload);
  const job = await api("/apps/deploy", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  statusOutput.textContent = JSON.stringify(job, null, 2);
  log("Deploy queued", job);
  await pollJob(job.job_id);
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

apiKeyInput.value = getApiKey();
setApiKeyBanner();

if (getApiKey()) {
  refreshAll().catch((error) => log("Initial refresh failed", String(error)));
}
