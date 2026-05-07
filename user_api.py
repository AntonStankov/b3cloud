"""B3Cloud user-facing API.

This API is intended for tenant usage and exposes a restricted subset of actions.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from kubernetes.client.rest import ApiException
from pydantic import BaseModel, Field

from platform_core import DeploymentRequest, PlatformCore, ResourceLimits, ServiceRequirement, sanitize_name


class ResourceLimitsIn(BaseModel):
    cpu_request: str = "100m"
    cpu_limit: str = "500m"
    memory_request: str = "128Mi"
    memory_limit: str = "512Mi"


class ComponentDeployIn(BaseModel):
    name: str
    path: str = "."
    type: str = "backend"
    public: bool = True
    port: int = 8080
    auto_detect_services: bool = True
    provision_services: List[str] = Field(default_factory=list)
    env: Dict[str, str] = Field(default_factory=dict)


class AppDeployIn(BaseModel):
    github_url: str
    env: Dict[str, str] = Field(default_factory=dict)
    git_revision: str = "main"
    port: int = 8080
    node_arch: Optional[str] = None
    auto_detect_services: bool = True
    provision_services: List[str] = Field(default_factory=list)
    components: List[ComponentDeployIn] = Field(default_factory=list)
    resources: ResourceLimitsIn = Field(default_factory=ResourceLimitsIn)


class RepoAnalyzeIn(BaseModel):
    github_url: str
    git_revision: str = "main"


class UserApi:
    def __init__(self) -> None:
        self.api_key = os.getenv("B3CLOUD_USER_API_KEY", "")
        kubeconfig = os.getenv("B3CLOUD_KUBECONFIG", "./kubeconfig")
        self.cluster_domain = os.getenv("B3CLOUD_CLUSTER_DOMAIN", "")
        self.registry_server = os.getenv("B3CLOUD_REGISTRY_SERVER", "")
        self.registry_username = os.getenv("B3CLOUD_REGISTRY_USERNAME", "")
        self.registry_namespace = os.getenv("B3CLOUD_REGISTRY_NAMESPACE", self.registry_username.lower())
        self.core = PlatformCore(kubeconfig=kubeconfig)
        self.jobs = DeployJobStore()

    def auth(self, x_api_key: Optional[str]) -> None:
        if not self.api_key:
            raise HTTPException(status_code=500, detail="Server misconfigured: B3CLOUD_USER_API_KEY is not set")
        if x_api_key != self.api_key:
            raise HTTPException(status_code=401, detail="Unauthorized")

    def defaults_from_github_url(self, github_url: str) -> Dict[str, str]:
        if not self.cluster_domain:
            raise HTTPException(status_code=500, detail="Server misconfigured: B3CLOUD_CLUSTER_DOMAIN is not set")
        if not self.registry_server or not self.registry_username:
            raise HTTPException(
                status_code=500,
                detail="Server misconfigured: B3CLOUD_REGISTRY_SERVER or B3CLOUD_REGISTRY_USERNAME is not set",
            )

        repo_name = repo_name_from_github_url(github_url)
        safe_name = sanitize_name(repo_name)
        return {
            "repo_name": repo_name,
            "app_name": safe_name,
            "namespace": safe_name,
            "domain": f"{safe_name}.{self.cluster_domain}",
            "registry_repo": f"{self.registry_server}/{self.registry_namespace}",
        }

    def component_defaults(self, defaults: Dict[str, str], component: ComponentDeployIn, multi_component: bool) -> Dict[str, str]:
        component_name = sanitize_name(component.name or Path(component.path).name or "app")
        app_name = sanitize_name(f"{defaults['app_name']}-{component_name}") if multi_component else defaults["app_name"]
        namespace = defaults["namespace"]
        return {
            "repo_name": defaults["repo_name"],
            "component_name": component_name,
            "component_path": component.path,
            "component_type": component.type,
            "public": component.public,
            "app_name": app_name,
            "namespace": namespace,
            "app_domain": defaults["domain"],
            "domain": f"{app_name}.{self.cluster_domain}",
            "registry_repo": defaults["registry_repo"],
        }


def repo_name_from_github_url(github_url: str) -> str:
    normalized = github_url.rstrip("/")
    match = re.search(r"/([^/]+?)(?:\.git)?$", normalized)
    if not match:
        raise HTTPException(status_code=400, detail=f"Unsupported github_url format: {github_url}")
    return match.group(1)


class DeployJobStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs_path = Path(__file__).with_name("data") / "user_deploy_jobs.json"
        self._jobs_path.parent.mkdir(parents=True, exist_ok=True)
        self._jobs: Dict[str, Dict[str, object]] = {}
        self._load()

    def _load(self) -> None:
        if not self._jobs_path.exists():
            return
        try:
            payload = json.loads(self._jobs_path.read_text())
        except (OSError, json.JSONDecodeError):
            return
        if isinstance(payload, dict):
            self._jobs = payload

    def _persist(self) -> None:
        self._jobs_path.write_text(json.dumps(self._jobs, indent=2, sort_keys=True))

    def create_job(self, payload: AppDeployIn, defaults: Dict[str, str]) -> Dict[str, object]:
        with self._lock:
            now = _now()
            job_id = uuid.uuid4().hex
            job = {
                "job_id": job_id,
                "status": "queued",
                "created_at": now,
                "updated_at": now,
                "github_url": payload.github_url,
                "git_revision": payload.git_revision,
                "namespace": defaults["namespace"],
                "app_name": defaults["app_name"],
                "domain": defaults["domain"],
                "registry_repo": defaults["registry_repo"],
                "auto_detect_services": payload.auto_detect_services,
                "provision_services": payload.provision_services,
                "components": [component.model_dump() for component in payload.components],
                "logs": ["Job queued."],
                "result": None,
                "error": None,
            }
            self._jobs[job_id] = job
            self._trim()
            self._persist()
            return dict(job)

    def append_log(self, job_id: str, message: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            logs = list(job.get("logs", []))
            logs.append(message)
            job["logs"] = logs[-300:]
            job["updated_at"] = _now()
            self._persist()

    def set_status(self, job_id: str, status: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job["status"] = status
            job["updated_at"] = _now()
            self._persist()

    def set_result(self, job_id: str, result: Dict[str, object]) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job["result"] = result
            job["status"] = "succeeded"
            job["updated_at"] = _now()
            self._persist()

    def set_error(self, job_id: str, error_message: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
            job["error"] = error_message
            job["status"] = "failed"
            job["updated_at"] = _now()
            self._persist()

    def get_job(self, job_id: str) -> Optional[Dict[str, object]]:
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def list_jobs(self) -> List[Dict[str, object]]:
        with self._lock:
            jobs = [dict(job) for job in self._jobs.values()]
        jobs.sort(key=lambda job: str(job.get("created_at", "")), reverse=True)
        return jobs

    def _trim(self) -> None:
        if len(self._jobs) <= 100:
            return
        ordered = sorted(self._jobs.items(), key=lambda item: str(item[1].get("created_at", "")), reverse=True)
        self._jobs = dict(ordered[:100])


def _run_deploy_job(job_id: str, payload: AppDeployIn, defaults: Dict[str, str]) -> None:
    try:
        svc.jobs.set_status(job_id, "running")
        svc.jobs.append_log(job_id, "Deploy job started.")
        components = payload.components
        if not components:
            components = [
                ComponentDeployIn(
                    name=defaults["app_name"],
                    path=".",
                    type="backend",
                    public=True,
                    port=payload.port,
                    auto_detect_services=payload.auto_detect_services,
                    provision_services=payload.provision_services,
                    env=payload.env,
                )
            ]

        results: List[Dict[str, object]] = []
        multi_component = len(components) > 1
        component_defaults_list = [
            svc.component_defaults(defaults, component, multi_component)
            for component in components
        ]
        same_origin_public = multi_component and _has_public_frontend_backend_pair(component_defaults_list)
        communication_env = _component_communication_env(
            component_defaults_list,
            app_domain=defaults["domain"] if same_origin_public else None,
        )
        for component in components:
            component_defaults = svc.component_defaults(defaults, component, multi_component)
            if same_origin_public:
                component_defaults["deploy_public"] = False
            svc.jobs.append_log(job_id, f"Deploying component {component_defaults['component_name']} from {component.path}.")
            result = _deploy_component(job_id, payload, component, component_defaults, communication_env)
            results.append(result)
        shared_route = None
        if same_origin_public:
            shared_route = _ensure_same_origin_public_route(job_id, defaults, component_defaults_list)
            for result in results:
                if result.get("component_type") == "frontend":
                    result["url"] = shared_route["url"]
                    result["domain"] = defaults["domain"]
                elif result.get("component_type") == "backend":
                    result["url"] = shared_route.get("api_url", shared_route["url"])
                    result["domain"] = defaults["domain"]
        svc.jobs.append_log(job_id, "Deploy job finished successfully.")
        if len(results) == 1:
            svc.jobs.set_result(job_id, results[0])
            return
        svc.jobs.set_result(
            job_id,
            {
                "repo_name": defaults["repo_name"],
                "namespace": defaults["namespace"],
                "status": "deployed",
                "url": shared_route["url"] if shared_route else "",
                "routes": shared_route["routes"] if shared_route else [],
                "components": results,
            },
        )
    except Exception as exc:
        svc.jobs.append_log(job_id, f"Deploy job failed: {exc}")
        trace = traceback.format_exc()
        svc.jobs.append_log(job_id, trace.strip())
        svc.jobs.set_error(job_id, str(exc))


def _deploy_component(
    job_id: str,
    payload: AppDeployIn,
    component: ComponentDeployIn,
    defaults: Dict[str, str],
    communication_env: Dict[str, str],
) -> Dict[str, object]:
    service_requirements: List[ServiceRequirement] = []
    if component.auto_detect_services and component.type in {"backend", "worker"}:
        svc.jobs.append_log(job_id, f"Analyzing {component.path} for backing service requirements.")
        analysis = svc.core.analyze_repository(
            payload.github_url,
            git_revision=payload.git_revision,
            status_callback=lambda message: svc.jobs.append_log(job_id, message),
        )
        component_analysis = next(
            (
                item
                for item in analysis.get("components", [])
                if isinstance(item, dict) and item.get("path") == component.path
            ),
            None,
        )
        detected = (component_analysis or analysis).get("services", [])
        service_requirements.extend(
            ServiceRequirement(
                type=str(item["type"]),
                confidence=str(item.get("confidence", "medium")),
                evidence=[str(evidence) for evidence in item.get("evidence", [])],
                provision=True,
            )
            for item in detected
            if isinstance(item, dict)
        )
        svc.jobs.append_log(job_id, f"Detected services: {', '.join(s.type for s in service_requirements) or 'none'}.")

    requested_types = {service.strip().lower() for service in component.provision_services if service.strip()}
    existing_types = {service.type for service in service_requirements}
    for service_type in sorted(requested_types - existing_types):
        service_requirements.append(
            ServiceRequirement(
                type=service_type,
                confidence="user-selected",
                evidence=["Selected in deployment request."],
                provision=True,
            )
        )

    user_env = {
        key: value
        for key, value in {**payload.env, **component.env}.items()
        if key not in PlatformCore.PLATFORM_MANAGED_ENV_NAMES
    }
    req = DeploymentRequest(
        github_url=payload.github_url,
        env={**user_env, **communication_env},
        resources=ResourceLimits(
            cpu_request=payload.resources.cpu_request,
            cpu_limit=payload.resources.cpu_limit,
            memory_request=payload.resources.memory_request,
            memory_limit=payload.resources.memory_limit,
        ),
        namespace=defaults["namespace"],
        app_name=defaults["app_name"],
        target_host=defaults["domain"],
        registry_repo=defaults["registry_repo"],
        git_revision=payload.git_revision,
        app_path=component.path,
        port=component.port or payload.port,
        node_arch=payload.node_arch,
        service_requirements=service_requirements,
        public=bool(defaults.get("deploy_public", component.public)),
    )
    result = svc.core.new_deployment(req, status_callback=lambda message: svc.jobs.append_log(job_id, message))
    result.update(
        {
            "repo_name": defaults["repo_name"],
            "component_name": defaults["component_name"],
            "component_path": defaults["component_path"],
            "component_type": defaults["component_type"],
            "namespace": defaults["namespace"],
            "app_name": defaults["app_name"],
            "domain": defaults["domain"],
            "registry_repo": defaults["registry_repo"],
            "services": [service.type for service in service_requirements if service.provision],
        }
    )
    return result


def _component_communication_env(
    component_defaults_list: List[Dict[str, str]],
    app_domain: Optional[str] = None,
) -> Dict[str, str]:
    env: Dict[str, str] = {}
    index: Dict[str, Dict[str, str]] = {}
    backend_alias_set = False
    app_public_url = f"https://{app_domain}" if app_domain else ""
    primary_backend = _primary_backend_component(component_defaults_list)
    for defaults in component_defaults_list:
        key = _env_key(defaults["component_name"])
        internal_url = f"http://{defaults['app_name']}.{defaults['namespace']}.svc.cluster.local"
        public_url = _component_public_url(defaults, app_public_url, primary_backend)
        default_url = public_url or internal_url
        index[key] = {
            "component": defaults["component_name"],
            "app_name": defaults["app_name"],
            "internal_url": internal_url,
            "public_url": public_url,
        }
        env[f"{key}_INTERNAL_URL"] = internal_url
        env[f"{key}_URL"] = default_url
        if public_url:
            env[f"{key}_PUBLIC_URL"] = public_url
            env[f"VITE_{key}_URL"] = public_url

        is_backend_alias = (
            defaults.get("component_type") == "backend"
            or key in {"SERVER", "BACKEND", "API"}
            or key.endswith("_API")
            or key.endswith("_SERVER")
            or key.endswith("_BACKEND")
        )
        if is_backend_alias and not backend_alias_set:
            env["BACKEND_URL"] = internal_url
            env["API_URL"] = internal_url
            if public_url:
                env["BACKEND_PUBLIC_URL"] = public_url
                env["API_PUBLIC_URL"] = public_url
                env["VITE_BACKEND_URL"] = "" if app_public_url else public_url
                env["VITE_API_URL"] = "" if app_public_url else public_url
                if app_public_url:
                    env["CORS_ORIGIN"] = app_public_url
                    env["APP_PUBLIC_URL"] = app_public_url
            backend_alias_set = True

    env["B3_COMPONENTS_JSON"] = json.dumps(index, sort_keys=True)
    return env


def _has_public_frontend_backend_pair(component_defaults_list: List[Dict[str, str]]) -> bool:
    has_frontend = any(item.get("public") and item.get("component_type") == "frontend" for item in component_defaults_list)
    return has_frontend and _primary_backend_component(component_defaults_list) is not None


def _primary_backend_component(component_defaults_list: List[Dict[str, str]]) -> Optional[Dict[str, str]]:
    for defaults in component_defaults_list:
        if defaults.get("component_type") == "backend":
            return defaults
    return None


def _component_public_url(
    defaults: Dict[str, str],
    app_public_url: str,
    primary_backend: Optional[Dict[str, str]],
) -> str:
    if not app_public_url:
        return f"https://{defaults['domain']}" if defaults.get("public") else ""
    if defaults.get("component_type") == "frontend":
        return app_public_url
    if primary_backend and defaults.get("app_name") == primary_backend.get("app_name"):
        return f"{app_public_url}/api"
    if defaults.get("public"):
        return f"{app_public_url}/{defaults['component_name']}"
    return ""


def _ensure_same_origin_public_route(
    job_id: str,
    defaults: Dict[str, str],
    component_defaults_list: List[Dict[str, str]],
) -> Dict[str, object]:
    frontend = next(
        (item for item in component_defaults_list if item.get("public") and item.get("component_type") == "frontend"),
        None,
    )
    backend = _primary_backend_component(component_defaults_list)
    routes: List[Dict[str, str]] = []
    if backend:
        routes.append({"path": "/api", "service_name": backend["app_name"]})
    if frontend:
        routes.append({"path": "/", "service_name": frontend["app_name"]})
    elif backend:
        routes.append({"path": "/", "service_name": backend["app_name"]})

    if not routes:
        return {"url": "", "api_url": "", "routes": []}

    for component in component_defaults_list:
        if component.get("domain") == defaults["domain"]:
            continue
        svc.jobs.append_log(job_id, f"Removing component public route https://{component['domain']} if it exists.")
        svc.core.delete_public_route(defaults["namespace"], component["app_name"], component["domain"])

    svc.jobs.append_log(job_id, f"Creating same-origin public route https://{defaults['domain']}.")
    svc.core.create_or_update_shared_public_route(
        defaults["namespace"],
        defaults["app_name"],
        defaults["domain"],
        routes,
    )
    return {
        "url": f"https://{defaults['domain']}",
        "api_url": f"https://{defaults['domain']}/api" if backend else "",
        "routes": routes,
    }


def _env_key(value: str) -> str:
    key = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").upper()
    return key or "APP"


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


svc = UserApi()
app = FastAPI(title="B3Cloud User API", version="1.0.0")
UI_DIR = os.path.join(os.path.dirname(__file__), "user_ui")

if os.path.isdir(UI_DIR):
    app.mount("/user-ui", StaticFiles(directory=UI_DIR), name="user-ui")


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def user_frontend() -> FileResponse:
    index_path = os.path.join(UI_DIR, "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(status_code=404, detail="User UI is not installed")
    return FileResponse(index_path)


@app.get("/apps")
def list_apps(
    namespace: Optional[str] = Query(default=None),
    x_api_key: Optional[str] = Header(default=None),
) -> List[Dict[str, str]]:
    svc.auth(x_api_key)
    deployments = (
        svc.core.apps.list_namespaced_deployment(namespace).items
        if namespace
        else svc.core.apps.list_deployment_for_all_namespaces().items
    )

    out: List[Dict[str, str]] = []
    for dep in deployments:
        image = dep.spec.template.spec.containers[0].image if dep.spec.template.spec.containers else ""
        out.append(
            {
                "namespace": dep.metadata.namespace,
                "app_name": dep.metadata.name,
                "replicas": str(dep.spec.replicas or 0),
                "ready_replicas": str(dep.status.ready_replicas or 0),
                "image": image,
            }
        )
    return out


@app.post("/apps/analyze")
def analyze_app(payload: RepoAnalyzeIn, x_api_key: Optional[str] = Header(default=None)) -> Dict[str, object]:
    svc.auth(x_api_key)
    defaults = svc.defaults_from_github_url(payload.github_url)
    analysis = svc.core.analyze_repository(payload.github_url, payload.git_revision)
    analysis.update(defaults)
    return analysis


@app.post("/apps/deploy")
def deploy_app(payload: AppDeployIn, x_api_key: Optional[str] = Header(default=None)) -> Dict[str, object]:
    svc.auth(x_api_key)
    defaults = svc.defaults_from_github_url(payload.github_url)
    job = svc.jobs.create_job(payload, defaults)
    threading.Thread(
        target=_run_deploy_job,
        args=(job["job_id"], payload, defaults),
        daemon=True,
        name=f"deploy-job-{job['job_id']}",
    ).start()
    return job


@app.get("/deploy-jobs")
def list_deploy_jobs(x_api_key: Optional[str] = Header(default=None)) -> List[Dict[str, object]]:
    svc.auth(x_api_key)
    return svc.jobs.list_jobs()


@app.get("/deploy-jobs/{job_id}")
def get_deploy_job(job_id: str, x_api_key: Optional[str] = Header(default=None)) -> Dict[str, object]:
    svc.auth(x_api_key)
    job = svc.jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Deploy job not found: {job_id}")
    _attach_runtime_logs(job)
    return job


@app.get("/apps/{namespace}/{app_name}")
def app_status(namespace: str, app_name: str, x_api_key: Optional[str] = Header(default=None)) -> Dict[str, str]:
    svc.auth(x_api_key)
    try:
        dep = svc.core.apps.read_namespaced_deployment(app_name, namespace)
    except ApiException as exc:
        if exc.status == 404:
            return {
                "namespace": namespace,
                "app_name": app_name,
                "status": "not_deployed",
                "detail": "No deployment exists yet for this app.",
            }
        raise
    image = dep.spec.template.spec.containers[0].image if dep.spec.template.spec.containers else ""
    return {
        "namespace": namespace,
        "app_name": app_name,
        "status": "deployed",
        "replicas": str(dep.spec.replicas or 0),
        "ready_replicas": str(dep.status.ready_replicas or 0),
        "image": image,
    }


@app.get("/apps/{namespace}/{app_name}/runtime-logs")
def app_runtime_logs(
    namespace: str,
    app_name: str,
    tail_lines: int = Query(default=160, ge=20, le=500),
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    svc.auth(x_api_key)
    return _runtime_logs_for_component(namespace, app_name, app_name, tail_lines=tail_lines)


@app.get("/apps/{namespace}/{app_name}/pods/{pod_name}/containers/{container_name}/logs")
def app_container_logs(
    namespace: str,
    app_name: str,
    pod_name: str,
    container_name: str,
    tail_lines: int = Query(default=200, ge=20, le=1000),
    previous: bool = Query(default=False),
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    svc.auth(x_api_key)
    _ensure_pod_belongs_to_app(namespace, app_name, pod_name)
    return {
        "namespace": namespace,
        "app_name": app_name,
        "pod_name": pod_name,
        "container_name": container_name,
        "previous": previous,
        "tail_lines": tail_lines,
        "logs": _read_pod_log(namespace, pod_name, container_name, tail_lines, previous=previous),
    }


def _attach_runtime_logs(job: Dict[str, object]) -> None:
    namespace = str(job.get("namespace") or "")
    app_name = str(job.get("app_name") or "")
    if not namespace or not app_name:
        return

    components = _job_runtime_components(job)
    runtime_logs = [
        _runtime_logs_for_component(
            namespace,
            str(component["app_name"]),
            str(component["component_name"]),
            tail_lines=160,
        )
        for component in components
    ]
    job["runtime_logs"] = runtime_logs


def _job_runtime_components(job: Dict[str, object]) -> List[Dict[str, str]]:
    result = job.get("result")
    if isinstance(result, dict):
        result_components = result.get("components")
        if isinstance(result_components, list) and result_components:
            components = []
            for item in result_components:
                if not isinstance(item, dict):
                    continue
                app_name = str(item.get("app_name") or "")
                component_name = str(item.get("component_name") or app_name)
                if app_name:
                    components.append({"app_name": app_name, "component_name": component_name})
            if components:
                return components
        result_app_name = str(result.get("app_name") or "")
        if result_app_name:
            return [{"app_name": result_app_name, "component_name": str(result.get("component_name") or result_app_name)}]

    raw_components = job.get("components")
    if isinstance(raw_components, list) and raw_components:
        multi_component = len(raw_components) > 1
        defaults = {
            "repo_name": str(job.get("app_name") or ""),
            "app_name": str(job.get("app_name") or ""),
            "namespace": str(job.get("namespace") or ""),
            "domain": str(job.get("domain") or ""),
            "registry_repo": str(job.get("registry_repo") or ""),
        }
        components = []
        for item in raw_components:
            if not isinstance(item, dict):
                continue
            try:
                component = ComponentDeployIn(**item)
            except Exception:
                continue
            component_defaults = svc.component_defaults(defaults, component, multi_component)
            components.append(
                {
                    "app_name": component_defaults["app_name"],
                    "component_name": component_defaults["component_name"],
                }
            )
        if components:
            return components

    if job.get("app_name"):
        return [{"app_name": str(job["app_name"]), "component_name": str(job["app_name"])}]
    return []


def _runtime_logs_for_component(
    namespace: str,
    app_name: str,
    component_name: str,
    tail_lines: int = 160,
) -> Dict[str, object]:
    payload: Dict[str, object] = {
        "namespace": namespace,
        "app_name": app_name,
        "component_name": component_name,
        "status": "unknown",
        "ready_replicas": 0,
        "replicas": 0,
        "pods": [],
        "error_summary": "",
    }

    try:
        dep = svc.core.apps.read_namespaced_deployment(app_name, namespace)
        payload["replicas"] = dep.spec.replicas or 0
        payload["ready_replicas"] = dep.status.ready_replicas or 0
        payload["status"] = "ready" if (dep.status.ready_replicas or 0) >= (dep.spec.replicas or 0) else "not_ready"
    except ApiException as exc:
        if exc.status == 404:
            payload["status"] = "not_deployed"
            payload["error_summary"] = "Deployment does not exist yet."
            return payload
        payload["status"] = "error"
        payload["error_summary"] = f"Kubernetes deployment lookup failed: {exc}"
        return payload

    try:
        pods = svc.core.core.list_namespaced_pod(namespace, label_selector=f"app={app_name}").items
    except ApiException as exc:
        payload["status"] = "error"
        payload["error_summary"] = f"Kubernetes pod lookup failed: {exc}"
        return payload

    pod_payloads: List[Dict[str, object]] = []
    summaries: List[str] = []
    for pod in pods:
        pod_info: Dict[str, object] = {
            "name": pod.metadata.name,
            "phase": pod.status.phase,
            "containers": [],
        }
        for container_status in pod.status.container_statuses or []:
            state = _container_state(container_status)
            ready = bool(container_status.ready)
            restarts = int(container_status.restart_count or 0)
            current_logs = _read_pod_log(namespace, pod.metadata.name, container_status.name, tail_lines, previous=False)
            previous_logs = _read_pod_log(namespace, pod.metadata.name, container_status.name, tail_lines, previous=True)
            error_line = _first_error_line(current_logs) or _first_error_line(previous_logs)
            if error_line:
                summaries.append(f"{pod.metadata.name}/{container_status.name}: {error_line}")
            elif not ready and state:
                summaries.append(f"{pod.metadata.name}/{container_status.name}: {state}")

            pod_info["containers"].append(
                {
                    "name": container_status.name,
                    "ready": ready,
                    "restarts": restarts,
                    "state": state,
                    "current_logs": current_logs,
                    "previous_logs": previous_logs,
                    "error_line": error_line,
                }
            )
        pod_payloads.append(pod_info)

    payload["pods"] = pod_payloads
    if summaries:
        payload["status"] = "failing"
        payload["error_summary"] = summaries[0]
    elif not pods:
        payload["status"] = "pending"
        payload["error_summary"] = "No pods exist for this component yet."
    return payload


def _ensure_pod_belongs_to_app(namespace: str, app_name: str, pod_name: str) -> None:
    try:
        pod = svc.core.core.read_namespaced_pod(pod_name, namespace)
    except ApiException as exc:
        if exc.status == 404:
            raise HTTPException(status_code=404, detail=f"Pod not found: {pod_name}") from exc
        raise
    labels = pod.metadata.labels or {}
    if labels.get("app") != app_name:
        raise HTTPException(status_code=404, detail=f"Pod {pod_name} does not belong to app {app_name}")


def _read_pod_log(namespace: str, pod_name: str, container_name: str, tail_lines: int, previous: bool) -> str:
    try:
        return svc.core.core.read_namespaced_pod_log(
            name=pod_name,
            namespace=namespace,
            container=container_name,
            tail_lines=tail_lines,
            previous=previous,
        )
    except ApiException as exc:
        if exc.status in {400, 404}:
            return ""
        return f"Failed to read pod logs: {exc}"
    except Exception as exc:
        return f"Failed to read pod logs: {exc}"


def _container_state(container_status) -> str:
    state = container_status.state
    last_state = container_status.last_state
    if state and state.waiting:
        message = state.waiting.message or state.waiting.reason or "waiting"
        return f"waiting: {message}"
    if state and state.terminated:
        message = state.terminated.message or state.terminated.reason or "terminated"
        return f"terminated: {message} (exit {state.terminated.exit_code})"
    if state and state.running:
        return "running"
    if last_state and last_state.terminated:
        message = last_state.terminated.message or last_state.terminated.reason or "terminated"
        return f"last terminated: {message} (exit {last_state.terminated.exit_code})"
    return ""


def _first_error_line(*logs: str) -> str:
    patterns = (
        "error",
        "exception",
        "traceback",
        "econnrefused",
        "module not found",
        "cannot find module",
        "failed",
        "fatal",
    )
    for log_text in logs:
        for line in str(log_text or "").splitlines():
            normalized = line.strip()
            if not normalized:
                continue
            lowered = normalized.lower()
            if any(pattern in lowered for pattern in patterns):
                return normalized[:500]
    return ""
