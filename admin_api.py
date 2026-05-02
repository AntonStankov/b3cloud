"""B3Cloud admin API for infrastructure and app lifecycle management.

Run:
  uvicorn admin_api:app --host 0.0.0.0 --port 9000

Auth:
  Set B3CLOUD_ADMIN_TOKEN and pass it via X-Admin-Token header.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
from dataclasses import asdict
from typing import Dict, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from kubernetes import client
from kubernetes.client.rest import ApiException

from platform_core import DeploymentRequest, PlatformCore, ResourceLimits, sanitize_name


class ResourceLimitsIn(BaseModel):
    cpu_request: str = "100m"
    cpu_limit: str = "500m"
    memory_request: str = "128Mi"
    memory_limit: str = "512Mi"


class DeploymentCreateIn(BaseModel):
    github_url: str
    env: Dict[str, str] = Field(default_factory=dict)
    resources: ResourceLimitsIn = Field(default_factory=ResourceLimitsIn)
    namespace: str
    app_name: str
    target_host: str
    registry_repo: str
    git_revision: str = "main"
    port: int = 8080
    node_arch: Optional[str] = None


class ScaleIn(BaseModel):
    replicas: int = Field(ge=0, le=100)


class RouteIn(BaseModel):
    hostname: str
    service: Optional[str] = None


class TerraformRunIn(BaseModel):
    targets: List[str] = Field(default_factory=list)
    auto_approve: bool = True


class InfraReconcileIn(BaseModel):
    auto_approve: bool = True
    sync_monitoring_route: bool = True
    monitoring_hostname: Optional[str] = None
    terraform_targets: List[str] = Field(
        default_factory=lambda: [
            "helm_release.monitoring",
            "cloudflare_record.apps_wildcard",
        ]
    )


class PublicEndpointsReconcileIn(BaseModel):
    admin_hostname: Optional[str] = None
    user_hostname: Optional[str] = None
    monitoring_hostname: Optional[str] = None
    admin_service: Optional[str] = None
    user_service: Optional[str] = None
    monitoring_service: Optional[str] = None


app = FastAPI(title="B3Cloud Admin API", version="1.0.0")

KUBECONFIG_PATH = os.getenv("B3CLOUD_KUBECONFIG", "./kubeconfig")
TF_WORKDIR = os.getenv("B3CLOUD_TF_DIR", ".")
ADMIN_TOKEN = os.getenv("B3CLOUD_ADMIN_TOKEN", "")
UI_DIR = os.path.join(os.path.dirname(__file__), "admin_ui")

core = PlatformCore(kubeconfig=KUBECONFIG_PATH)
corev1 = core.core
appsv1 = core.apps
netv1 = core.networking


def require_admin_token(x_admin_token: Optional[str] = Header(default=None)) -> None:
    if not ADMIN_TOKEN:
        raise HTTPException(status_code=500, detail="Server misconfigured: B3CLOUD_ADMIN_TOKEN is not set")
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")


def run_terraform(command: List[str]) -> Dict[str, str]:
    proc = subprocess.run(
        command,
        cwd=TF_WORKDIR,
        text=True,
        capture_output=True,
        check=False,
    )
    return {
        "command": " ".join(shlex.quote(x) for x in command),
        "exit_code": str(proc.returncode),
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "status": "success" if proc.returncode == 0 else "failed",
    }


def build_terraform_command(base_command: str, targets: List[str], auto_approve: bool = True) -> List[str]:
    cmd = ["terraform", base_command]
    if base_command == "apply" and auto_approve:
        cmd.append("-auto-approve")
    for target in targets:
        cmd.extend(["-target", target])
    return cmd


def read_tfvars_value(key: str, default: Optional[str] = None) -> Optional[str]:
    tfvars_path = os.path.join(TF_WORKDIR, "terraform.tfvars")
    try:
        with open(tfvars_path, "r", encoding="utf-8") as fh:
            content = fh.read()
    except FileNotFoundError:
        return default

    pattern = rf"(?m)^\s*{re.escape(key)}\s*=\s*\"([^\"]*)\""
    match = re.search(pattern, content)
    if match:
        return match.group(1)
    return default


def desired_monitoring_hostname() -> str:
    subdomain = read_tfvars_value("monitoring_subdomain", "monitoring") or "monitoring"
    cluster_domain = read_tfvars_value("cluster_domain")
    if not cluster_domain:
        raise HTTPException(status_code=500, detail="cluster_domain is not configured in terraform.tfvars")
    return f"{subdomain}.{cluster_domain}"


def desired_hostname(key: str) -> str:
    value = read_tfvars_value(key)
    if not value:
        raise HTTPException(status_code=500, detail=f"{key} is not configured in terraform.tfvars")
    return value


if os.path.isdir(UI_DIR):
    app.mount("/admin-ui", StaticFiles(directory=UI_DIR), name="admin-ui")


@app.get("/admin")
def admin_frontend() -> FileResponse:
    index_path = os.path.join(UI_DIR, "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail="Admin UI is not installed")
    return FileResponse(index_path)


@app.get("/health")
def health(_: None = Depends(require_admin_token)) -> Dict[str, str]:
    try:
        nodes = corev1.list_node().items
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Kubernetes API unreachable: {exc}") from exc
    return {"status": "ok", "nodes": str(len(nodes))}


@app.get("/cluster/nodes")
def cluster_nodes(_: None = Depends(require_admin_token)) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for n in corev1.list_node().items:
        addresses = {a.type: a.address for a in (n.status.addresses or [])}
        out.append(
            {
                "name": n.metadata.name,
                "ready": next((c.status for c in (n.status.conditions or []) if c.type == "Ready"), "Unknown"),
                "arch": (n.metadata.labels or {}).get("kubernetes.io/arch", "unknown"),
                "internal_ip": addresses.get("InternalIP", ""),
                "external_ip": addresses.get("ExternalIP", ""),
            }
        )
    return out


@app.get("/cluster/pods")
def cluster_pods(
    namespace: Optional[str] = Query(default=None),
    _: None = Depends(require_admin_token),
) -> List[Dict[str, str]]:
    pods = corev1.list_namespaced_pod(namespace).items if namespace else corev1.list_pod_for_all_namespaces().items
    return [
        {
            "namespace": p.metadata.namespace,
            "name": p.metadata.name,
            "phase": p.status.phase,
            "node": p.spec.node_name or "",
            "pod_ip": p.status.pod_ip or "",
        }
        for p in pods
    ]


@app.post("/deployments")
def create_deployment(payload: DeploymentCreateIn, _: None = Depends(require_admin_token)) -> Dict[str, str]:
    req = DeploymentRequest(
        github_url=payload.github_url,
        env=payload.env,
        resources=ResourceLimits(
            cpu_request=payload.resources.cpu_request,
            cpu_limit=payload.resources.cpu_limit,
            memory_request=payload.resources.memory_request,
            memory_limit=payload.resources.memory_limit,
        ),
        namespace=sanitize_name(payload.namespace),
        app_name=sanitize_name(payload.app_name),
        target_host=payload.target_host,
        registry_repo=payload.registry_repo,
        git_revision=payload.git_revision,
        port=payload.port,
        node_arch=payload.node_arch,
    )
    try:
        return core.new_deployment(req)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/deployments")
def list_deployments(namespace: Optional[str] = Query(default=None), _: None = Depends(require_admin_token)) -> List[Dict]:
    deployments = appsv1.list_namespaced_deployment(namespace).items if namespace else appsv1.list_deployment_for_all_namespaces().items
    out: List[Dict] = []
    for d in deployments:
        out.append(
            {
                "namespace": d.metadata.namespace,
                "name": d.metadata.name,
                "replicas": d.spec.replicas or 0,
                "ready_replicas": d.status.ready_replicas or 0,
                "available_replicas": d.status.available_replicas or 0,
                "labels": d.metadata.labels or {},
            }
        )
    return out


@app.get("/deployments/{namespace}/{app_name}")
def get_deployment(namespace: str, app_name: str, _: None = Depends(require_admin_token)) -> Dict:
    try:
        dep = appsv1.read_namespaced_deployment(app_name, namespace)
        svc = corev1.read_namespaced_service(app_name, namespace)
        ing = netv1.read_namespaced_ingress(app_name, namespace)
    except ApiException as exc:
        if exc.status == 404:
            raise HTTPException(status_code=404, detail="Deployment not found") from exc
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    image = dep.spec.template.spec.containers[0].image if dep.spec.template.spec.containers else ""
    hosts = [r.host for r in (ing.spec.rules or []) if r.host]
    return {
        "namespace": namespace,
        "app_name": app_name,
        "replicas": dep.spec.replicas or 0,
        "ready_replicas": dep.status.ready_replicas or 0,
        "image": image,
        "service_cluster_ip": svc.spec.cluster_ip or "",
        "hosts": hosts,
    }


@app.post("/deployments/{namespace}/{app_name}/scale")
def scale_deployment(namespace: str, app_name: str, payload: ScaleIn, _: None = Depends(require_admin_token)) -> Dict[str, str]:
    body = {"spec": {"replicas": payload.replicas}}
    try:
        appsv1.patch_namespaced_deployment_scale(app_name, namespace, body)
    except ApiException as exc:
        if exc.status == 404:
            raise HTTPException(status_code=404, detail="Deployment not found") from exc
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"status": "scaled", "namespace": namespace, "app_name": app_name, "replicas": str(payload.replicas)}


@app.delete("/deployments/{namespace}/{app_name}")
def delete_deployment(namespace: str, app_name: str, _: None = Depends(require_admin_token)) -> Dict[str, str]:
    errors: List[str] = []
    for fn in (
        lambda: appsv1.delete_namespaced_deployment(app_name, namespace),
        lambda: corev1.delete_namespaced_service(app_name, namespace),
        lambda: netv1.delete_namespaced_ingress(app_name, namespace),
    ):
        try:
            fn()
        except ApiException as exc:
            if exc.status != 404:
                errors.append(str(exc))

    try:
        core.custom.delete_namespaced_custom_object("kpack.io", "v1alpha2", namespace, "images", f"{app_name}-image")
    except ApiException as exc:
        if exc.status != 404:
            errors.append(str(exc))

    if errors:
        raise HTTPException(status_code=500, detail=errors)
    return {"status": "deleted", "namespace": namespace, "app_name": app_name}


@app.post("/dns/routes")
def create_dns_route(payload: RouteIn, _: None = Depends(require_admin_token)) -> Dict:
    try:
        core.cloudflare.ensure_dns_and_tunnel_route(core.cloudflare_config, payload.hostname, payload.service)
        return {"status": "configured", "hostname": payload.hostname}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/infra/terraform/init")
def terraform_init(_: None = Depends(require_admin_token)) -> Dict[str, str]:
    return run_terraform(["terraform", "init", "-input=false"])


@app.post("/infra/terraform/plan")
def terraform_plan(payload: TerraformRunIn, _: None = Depends(require_admin_token)) -> Dict[str, str]:
    return run_terraform(build_terraform_command("plan", payload.targets, auto_approve=False))


@app.post("/infra/terraform/apply")
def terraform_apply(payload: TerraformRunIn, _: None = Depends(require_admin_token)) -> Dict[str, str]:
    return run_terraform(build_terraform_command("apply", payload.targets, auto_approve=payload.auto_approve))


@app.post("/infra/reconcile")
def infra_reconcile(payload: InfraReconcileIn, _: None = Depends(require_admin_token)) -> Dict:
    monitoring_hostname = payload.monitoring_hostname or desired_monitoring_hostname()

    terraform_result = run_terraform(
        build_terraform_command("apply", payload.terraform_targets, auto_approve=payload.auto_approve)
    )

    route_result: Dict[str, str]
    if payload.sync_monitoring_route:
        try:
            core.cloudflare.ensure_dns_and_tunnel_route(core.cloudflare_config, monitoring_hostname)
            route_result = {
                "status": "configured",
                "hostname": monitoring_hostname,
            }
        except Exception as exc:
            route_result = {
                "status": "failed",
                "hostname": monitoring_hostname,
                "detail": str(exc),
            }
    else:
        route_result = {
            "status": "skipped",
            "hostname": monitoring_hostname,
        }

    overall_status = "success"
    if terraform_result["status"] != "success" or route_result["status"] == "failed":
        overall_status = "failed"

    return {
        "status": overall_status,
        "monitoring_hostname": monitoring_hostname,
        "terraform": terraform_result,
        "cloudflare_route": route_result,
    }


@app.post("/infra/public-endpoints/reconcile")
def reconcile_public_endpoints(payload: PublicEndpointsReconcileIn, _: None = Depends(require_admin_token)) -> Dict:
    admin_hostname = payload.admin_hostname or desired_hostname("admin_api_domain")
    user_hostname = payload.user_hostname or desired_hostname("user_api_domain")
    monitoring_hostname = payload.monitoring_hostname or desired_monitoring_hostname()

    admin_service = payload.admin_service or "http://178.105.29.217"
    user_service = payload.user_service or "http://178.105.29.217"
    monitoring_service = payload.monitoring_service or "http://ingress-nginx-controller.ingress-nginx.svc.cluster.local:80"

    routes = [
        ("admin", admin_hostname, admin_service),
        ("user", user_hostname, user_service),
        ("monitoring", monitoring_hostname, monitoring_service),
    ]

    results = []
    failed = False
    for name, hostname, service in routes:
        try:
            core.cloudflare.ensure_dns_and_tunnel_route(core.cloudflare_config, hostname, service)
            results.append({"name": name, "hostname": hostname, "service": service, "status": "configured"})
        except Exception as exc:
            failed = True
            results.append({"name": name, "hostname": hostname, "service": service, "status": "failed", "detail": str(exc)})

    return {
        "status": "failed" if failed else "success",
        "routes": results,
    }


@app.get("/infra/terraform/output")
def terraform_output(_: None = Depends(require_admin_token)) -> Dict[str, str]:
    return run_terraform(["terraform", "output", "-json"])


@app.get("/config")
def config_view(_: None = Depends(require_admin_token)) -> Dict:
    cfg = asdict(core.cloudflare_config)
    cfg["api_token"] = "***redacted***"
    return {
        "kubeconfig": KUBECONFIG_PATH,
        "terraform_dir": os.path.abspath(TF_WORKDIR),
        "cloudflare": cfg,
    }
