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
        communication_env = _component_communication_env(component_defaults_list)
        for component in components:
            component_defaults = svc.component_defaults(defaults, component, multi_component)
            svc.jobs.append_log(job_id, f"Deploying component {component_defaults['component_name']} from {component.path}.")
            result = _deploy_component(job_id, payload, component, component_defaults, communication_env)
            results.append(result)
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
        public=component.public,
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


def _component_communication_env(component_defaults_list: List[Dict[str, str]]) -> Dict[str, str]:
    env: Dict[str, str] = {}
    index: Dict[str, Dict[str, str]] = {}
    backend_alias_set = False
    for defaults in component_defaults_list:
        key = _env_key(defaults["component_name"])
        internal_url = f"http://{defaults['app_name']}.{defaults['namespace']}.svc.cluster.local"
        public_url = f"https://{defaults['domain']}" if defaults.get("public") else ""
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
                env["VITE_BACKEND_URL"] = public_url
                env["VITE_API_URL"] = public_url
            backend_alias_set = True

    env["B3_COMPONENTS_JSON"] = json.dumps(index, sort_keys=True)
    return env


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
