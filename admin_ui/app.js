const tokenInput = document.getElementById("admin-token");
const tokenState = document.getElementById("token-state");
const consoleOutput = document.getElementById("console-output");

const els = {
  healthStatus: document.getElementById("health-status"),
  healthDetail: document.getElementById("health-detail"),
  nodeCount: document.getElementById("node-count"),
  deploymentCount: document.getElementById("deployment-count"),
  monitoringHost: document.getElementById("monitoring-host"),
  monitoringLink: document.getElementById("monitoring-link"),
  nodesTable: document.getElementById("nodes-table"),
  deploymentsTable: document.getElementById("deployments-table"),
  podsTable: document.getElementById("pods-table"),
  podsNamespace: document.getElementById("pods-namespace"),
  reconcileHostname: document.getElementById("reconcile-hostname"),
  terraformTargets: document.getElementById("terraform-targets"),
  dnsHostname: document.getElementById("dns-hostname"),
};

const defaultTargets = [
  "helm_release.monitoring",
  "cloudflare_record.apps_wildcard",
];

function getToken() {
  return localStorage.getItem("b3cloud_admin_token") || "";
}

function setToken(value) {
  localStorage.setItem("b3cloud_admin_token", value);
}

function log(title, payload) {
  const stamp = new Date().toLocaleTimeString();
  const chunk = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  consoleOutput.textContent = `[${stamp}] ${title}\n${chunk}\n\n${consoleOutput.textContent}`;
}

function setTokenBanner() {
  tokenState.textContent = getToken() ? "Token saved in this browser." : "Token is kept in this browser only.";
}

async function api(path, options = {}) {
  const token = getToken();
  if (!token) {
    throw new Error("Set the admin token first.");
  }

  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": token,
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
    const message = data.detail || data.raw || `${response.status} ${response.statusText}`;
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }

  return data;
}

function rowsMarkup(items, columns) {
  if (!items.length) {
    return `<tr><td colspan="${columns}" class="muted">No data.</td></tr>`;
  }
  return items.join("");
}

async function refreshHealth() {
  const data = await api("/health");
  els.healthStatus.textContent = data.status;
  els.healthStatus.className = data.status === "ok" ? "ok" : "";
  els.healthDetail.textContent = `${data.nodes} nodes reachable`;
  log("Health", data);
}

async function refreshNodes() {
  const data = await api("/cluster/nodes");
  els.nodeCount.textContent = String(data.length);
  els.nodesTable.innerHTML = rowsMarkup(
    data.map(
      (node) => `<tr>
        <td>${node.name}</td>
        <td>${node.ready}</td>
        <td>${node.arch}</td>
        <td>${node.internal_ip || "-"}</td>
        <td>${node.external_ip || "-"}</td>
      </tr>`
    ),
    5
  );
}

async function refreshDeployments() {
  const data = await api("/deployments");
  els.deploymentCount.textContent = String(data.length);
  els.deploymentsTable.innerHTML = rowsMarkup(
    data.map(
      (dep) => `<tr>
        <td>${dep.namespace}</td>
        <td>${dep.name}</td>
        <td>${dep.ready_replicas}</td>
        <td>${dep.available_replicas}</td>
        <td>${dep.replicas}</td>
      </tr>`
    ),
    5
  );
}

async function refreshPods() {
  const ns = els.podsNamespace.value.trim();
  const query = ns ? `?namespace=${encodeURIComponent(ns)}` : "";
  const data = await api(`/cluster/pods${query}`);
  els.podsTable.innerHTML = rowsMarkup(
    data.map(
      (pod) => `<tr>
        <td>${pod.namespace}</td>
        <td>${pod.name}</td>
        <td>${pod.phase}</td>
        <td>${pod.node || "-"}</td>
        <td>${pod.pod_ip || "-"}</td>
      </tr>`
    ),
    5
  );
}

async function refreshConfig() {
  const data = await api("/config");
  const host = `https://${data.cloudflare.default_zone_id ? els.reconcileHostname.value.trim() || "monitoring" : "monitoring"}`;
  log("Config", data);
  return data;
}

async function refreshOutputs() {
  const output = await api("/infra/terraform/output");
  log("Terraform Output", output);
  try {
    const parsed = JSON.parse(output.stdout || "{}");
    const monitoring = parsed.monitoring_ui_url?.value || "";
    if (monitoring) {
      els.monitoringHost.textContent = monitoring.replace(/^https?:\/\//, "");
      els.monitoringLink.href = monitoring;
    }
  } catch {
    // Ignore malformed output and keep manual host state.
  }
}

async function refreshAll() {
  try {
    await Promise.all([refreshHealth(), refreshNodes(), refreshDeployments(), refreshPods()]);
    await refreshOutputs().catch(() => {});
  } catch (error) {
    log("Refresh failed", String(error));
    throw error;
  }
}

function parseTargets() {
  return els.terraformTargets.value
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function runTerraform(endpoint) {
  const payload = endpoint === "/infra/terraform/init"
    ? undefined
    : { targets: parseTargets(), auto_approve: true };
  const data = await api(endpoint, {
    method: endpoint === "/infra/terraform/output" ? "GET" : "POST",
    body: payload ? JSON.stringify(payload) : undefined,
  });
  log(endpoint, data);
  return data;
}

async function runReconcile() {
  const payload = {
    auto_approve: true,
    sync_monitoring_route: true,
    monitoring_hostname: els.reconcileHostname.value.trim() || undefined,
    terraform_targets: parseTargets(),
  };
  const data = await api("/infra/reconcile", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  log("Infra Reconcile", data);
  if (data.monitoring_hostname) {
    els.monitoringHost.textContent = data.monitoring_hostname;
    els.monitoringLink.href = `https://${data.monitoring_hostname}`;
  }
}

async function createDnsRoute() {
  const hostname = els.dnsHostname.value.trim();
  if (!hostname) {
    throw new Error("Enter a hostname first.");
  }
  const data = await api("/dns/routes", {
    method: "POST",
    body: JSON.stringify({ hostname }),
  });
  log("DNS Route", data);
}

async function createDeployment(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  const envRaw = String(form.get("env") || "").trim();
  const payload = {
    github_url: form.get("github_url"),
    namespace: form.get("namespace"),
    app_name: form.get("app_name"),
    target_host: form.get("target_host"),
    registry_repo: form.get("registry_repo"),
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
  const data = await api("/deployments", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  log("Create Deployment", data);
  await refreshDeployments();
}

function bind(id, handler) {
  document.getElementById(id).addEventListener("click", async () => {
    try {
      await handler();
    } catch (error) {
      log(`${id} failed`, String(error));
    }
  });
}

document.getElementById("save-token").addEventListener("click", async () => {
  setToken(tokenInput.value.trim());
  setTokenBanner();
  log("Auth", "Admin token saved in localStorage.");
  try {
    await refreshAll();
  } catch (error) {
    log("Initial refresh failed", String(error));
  }
});

document.getElementById("deployment-form").addEventListener("submit", async (event) => {
  try {
    await createDeployment(event);
  } catch (error) {
    log("Create Deployment failed", String(error));
  }
});

document.getElementById("clear-console").addEventListener("click", () => {
  consoleOutput.textContent = "Console cleared.";
});

bind("refresh-all", refreshAll);
bind("refresh-nodes", refreshNodes);
bind("refresh-deployments", refreshDeployments);
bind("refresh-pods", refreshPods);
bind("run-reconcile", runReconcile);
bind("create-dns-route", createDnsRoute);
bind("terraform-init", () => runTerraform("/infra/terraform/init"));
bind("terraform-plan", () => runTerraform("/infra/terraform/plan"));
bind("terraform-apply", () => runTerraform("/infra/terraform/apply"));
bind("terraform-output", () => runTerraform("/infra/terraform/output"));

tokenInput.value = getToken();
setTokenBanner();
els.terraformTargets.value = defaultTargets.join("\n");
els.reconcileHostname.value = "monitoring.zerotrust-docker-home-server-test.download";
els.monitoringHost.textContent = "monitoring.zerotrust-docker-home-server-test.download";
els.monitoringLink.href = "https://monitoring.zerotrust-docker-home-server-test.download";

if (getToken()) {
  refreshAll().catch((error) => log("Initial refresh failed", String(error)));
}
