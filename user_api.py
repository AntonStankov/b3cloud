"""B3Cloud user-facing API.

This API is intended for tenant usage and exposes a restricted subset of actions.
"""

from __future__ import annotations

import json
import os
import re
import hashlib
import hmac
import secrets
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urlencode
from urllib import error as urlerror
from urllib import request as urlrequest

from fastapi import FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from kubernetes import client
from kubernetes.client.rest import ApiException
from pydantic import BaseModel, Field

from platform_core import AutoscalingConfig, DeploymentRequest, PlatformCore, ResourceLimits, ServiceRequirement, sanitize_name


class ResourceLimitsIn(BaseModel):
    cpu_request: str = "100m"
    cpu_limit: str = "500m"
    memory_request: str = "128Mi"
    memory_limit: str = "512Mi"


class AutoscalingIn(BaseModel):
    enabled: bool = True
    min_replicas: int = Field(default=1, ge=1, le=100)
    max_replicas: int = Field(default=5, ge=1, le=100)
    target_cpu_utilization: int = Field(default=80, ge=1, le=100)
    target_memory_utilization: int = Field(default=80, ge=1, le=100)


class ComponentDeployIn(BaseModel):
    name: str
    path: str = "."
    type: str = "backend"
    public: bool = True
    port: int = 8080
    auto_detect_services: bool = True
    provision_services: List[str] = Field(default_factory=list)
    redeploy_services: bool = False
    autoscaling: Optional[AutoscalingIn] = None
    env: Dict[str, str] = Field(default_factory=dict)


class AppDeployIn(BaseModel):
    github_url: str
    github_token: Optional[str] = None
    env: Dict[str, str] = Field(default_factory=dict)
    git_revision: str = "main"
    port: int = 8080
    node_arch: Optional[str] = None
    auto_detect_services: bool = True
    provision_services: List[str] = Field(default_factory=list)
    redeploy_services: bool = False
    components: List[ComponentDeployIn] = Field(default_factory=list)
    resources: ResourceLimitsIn = Field(default_factory=ResourceLimitsIn)
    autoscaling: AutoscalingIn = Field(default_factory=AutoscalingIn)


class RepoAnalyzeIn(BaseModel):
    github_url: str
    github_token: Optional[str] = None
    git_revision: str = "main"


class SignupIn(BaseModel):
    email: str
    password: str
    name: str = ""


class LoginIn(BaseModel):
    email: str
    password: str


class GitHubLinkIn(BaseModel):
    github_url: str
    installation_id: Optional[str] = None


class DeploymentUpdateIn(BaseModel):
    env: Optional[Dict[str, str]] = None
    git_revision: Optional[str] = None
    port: Optional[int] = None
    components: Optional[List[ComponentDeployIn]] = None
    redeploy_services: Optional[bool] = None


class DeploymentDeleteIn(BaseModel):
    delete_data: bool = False


class ScaleIn(BaseModel):
    replicas: int = Field(ge=0, le=10)


class UserApi:
    def __init__(self) -> None:
        self.api_key = os.getenv("B3CLOUD_USER_API_KEY", "")
        kubeconfig = os.getenv("B3CLOUD_KUBECONFIG", "./kubeconfig")
        self.cluster_domain = os.getenv("B3CLOUD_CLUSTER_DOMAIN", "")
        self.registry_server = os.getenv("B3CLOUD_REGISTRY_SERVER", "")
        self.registry_username = os.getenv("B3CLOUD_REGISTRY_USERNAME", "")
        self.registry_namespace = os.getenv("B3CLOUD_REGISTRY_NAMESPACE", self.registry_username).lower()
        self.core = PlatformCore(kubeconfig=kubeconfig)
        self.jobs = DeployJobStore()
        self.accounts = AccountStore()
        self.supabase_url = os.getenv("B3CLOUD_SUPABASE_URL", "").rstrip("/")
        self.supabase_anon_key = os.getenv("B3CLOUD_SUPABASE_ANON_KEY", "")

    def auth(self, x_api_key: Optional[str], authorization: Optional[str] = None) -> Dict[str, object]:
        if x_api_key and self.api_key and x_api_key == self.api_key:
            return {"id": "api-key", "email": "api-key@local", "name": "API Key", "github": {}}
        if authorization and authorization.lower().startswith("bearer "):
            return self._verify_supabase_token(authorization.split(" ", 1)[1].strip())
        raise HTTPException(status_code=401, detail="Unauthorized")

    def _verify_supabase_token(self, token: str) -> Dict[str, object]:
        if not self.supabase_url or not self.supabase_anon_key:
            raise HTTPException(status_code=500, detail="Server misconfigured: Supabase auth is not configured")
        req = urlrequest.Request(
            f"{self.supabase_url}/auth/v1/user",
            headers={
                "Authorization": f"Bearer {token}",
                "apikey": self.supabase_anon_key,
                "Accept": "application/json",
            },
        )
        try:
            with urlrequest.urlopen(req, timeout=10) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urlerror.HTTPError as exc:
            if exc.code in {401, 403}:
                raise HTTPException(status_code=401, detail="Unauthorized") from exc
            detail = exc.read().decode("utf-8", errors="replace")
            raise HTTPException(status_code=502, detail=f"Supabase auth verification failed: {detail}") from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"Supabase auth verification failed: {exc}") from exc
        user_id = str(payload.get("id") or payload.get("sub") or "")
        email = str(payload.get("email") or "")
        if not user_id:
            raise HTTPException(status_code=401, detail="Unauthorized")
        return {"id": user_id, "email": email, "name": email.split("@", 1)[0] if email else "", "github": {}}

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
            "registry_repo": f"{self.registry_server.lower()}/{self.registry_namespace.lower()}",
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
                "redeploy_services": payload.redeploy_services,
                "autoscaling": payload.autoscaling.model_dump(),
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


class AccountStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._path = Path(__file__).with_name("data") / "user_accounts.json"
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._users: Dict[str, Dict[str, object]] = {}
        self._sessions: Dict[str, Dict[str, object]] = {}
        self._repo_links: Dict[str, Dict[str, object]] = {}
        self._load()

    def _load(self) -> None:
        if not self._path.exists():
            return
        try:
            payload = json.loads(self._path.read_text())
        except (OSError, json.JSONDecodeError):
            return
        if isinstance(payload, dict):
            self._users = payload.get("users", {}) if isinstance(payload.get("users"), dict) else {}
            self._sessions = payload.get("sessions", {}) if isinstance(payload.get("sessions"), dict) else {}
            self._repo_links = payload.get("repo_links", {}) if isinstance(payload.get("repo_links"), dict) else {}

    def _persist(self) -> None:
        self._path.write_text(
            json.dumps(
                {
                    "users": self._users,
                    "sessions": self._sessions,
                    "repo_links": self._repo_links,
                },
                indent=2,
                sort_keys=True,
            )
        )

    def create_user(self, email: str, password: str, name: str = "") -> Dict[str, object]:
        normalized = email.strip().lower()
        if not normalized or "@" not in normalized:
            raise HTTPException(status_code=400, detail="A valid email is required")
        if len(password) < 8:
            raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
        with self._lock:
            if any(user.get("email") == normalized for user in self._users.values()):
                raise HTTPException(status_code=409, detail="Account already exists")
            user_id = uuid.uuid4().hex
            user = {
                "id": user_id,
                "email": normalized,
                "name": name.strip(),
                "password_hash": self._hash_password(password),
                "github": {},
                "created_at": _now(),
                "updated_at": _now(),
            }
            self._users[user_id] = user
            self._persist()
            return self._public_user(user)

    def authenticate(self, email: str, password: str) -> Dict[str, object]:
        normalized = email.strip().lower()
        with self._lock:
            for user in self._users.values():
                if user.get("email") == normalized and self._verify_password(password, str(user.get("password_hash") or "")):
                    return self._public_user(user)
        raise HTTPException(status_code=401, detail="Invalid email or password")

    def create_session(self, user_id: str) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._sessions[token] = {
                "user_id": user_id,
                "created_at": _now(),
                "updated_at": _now(),
            }
            self._persist()
        return token

    def delete_session(self, token: str) -> None:
        if not token:
            return
        with self._lock:
            self._sessions.pop(token, None)
            self._persist()

    def user_for_token(self, token: str) -> Optional[Dict[str, object]]:
        if not token:
            return None
        with self._lock:
            session = self._sessions.get(token)
            if not session:
                return None
            user = self._users.get(str(session.get("user_id") or ""))
            if not user:
                return None
            session["updated_at"] = _now()
            self._persist()
            return self._public_user(user)

    def link_github_identity(self, email: str, github_payload: Dict[str, object]) -> Dict[str, object]:
        normalized = email.strip().lower()
        with self._lock:
            user_id = ""
            user: Optional[Dict[str, object]] = None
            for candidate_id, candidate in self._users.items():
                if candidate.get("email") == normalized:
                    user_id = candidate_id
                    user = candidate
                    break
            if not user:
                user_id = uuid.uuid4().hex
                user = {
                    "id": user_id,
                    "email": normalized,
                    "name": str(github_payload.get("name") or ""),
                    "password_hash": "",
                    "github": {},
                    "created_at": _now(),
                    "updated_at": _now(),
                }
                self._users[user_id] = user
            user["github"] = github_payload
            user["updated_at"] = _now()
            self._persist()
            return self._public_user(user)

    def link_repo(self, user_id: str, payload: GitHubLinkIn) -> Dict[str, object]:
        defaults = svc.defaults_from_github_url(payload.github_url)
        deployment_id = _deployment_id(defaults["namespace"], defaults["app_name"])
        link = {
            "deployment_id": deployment_id,
            "user_id": user_id,
            "github_url": payload.github_url,
            "installation_id": payload.installation_id or "",
            "namespace": defaults["namespace"],
            "app_name": defaults["app_name"],
            "domain": defaults["domain"],
            "created_at": _now(),
            "updated_at": _now(),
        }
        with self._lock:
            self._repo_links[deployment_id] = link
            self._persist()
        return dict(link)

    def repo_links_for_user(self, user_id: str) -> List[Dict[str, object]]:
        with self._lock:
            links = [dict(link) for link in self._repo_links.values() if link.get("user_id") == user_id]
        links.sort(key=lambda link: str(link.get("created_at", "")), reverse=True)
        return links

    @staticmethod
    def _hash_password(password: str) -> str:
        salt = secrets.token_hex(16)
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 200_000).hex()
        return f"pbkdf2_sha256${salt}${digest}"

    @staticmethod
    def _verify_password(password: str, password_hash: str) -> bool:
        try:
            algorithm, salt, expected = password_hash.split("$", 2)
        except ValueError:
            return False
        if algorithm != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 200_000).hex()
        return hmac.compare_digest(digest, expected)

    @staticmethod
    def _public_user(user: Dict[str, object]) -> Dict[str, object]:
        github = dict(user.get("github") or {})
        if "access_token" in github:
            github["linked"] = True
            github.pop("access_token", None)
        return {
            "id": user.get("id"),
            "email": user.get("email"),
            "name": user.get("name") or "",
            "github": github,
            "created_at": user.get("created_at"),
            "updated_at": user.get("updated_at"),
        }


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
            github_token=payload.github_token,
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
        redeploy_backing_services=bool(payload.redeploy_services or component.redeploy_services),
        autoscaling=_autoscaling_config(component.autoscaling or payload.autoscaling),
        github_token=payload.github_token,
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


def _autoscaling_config(payload: AutoscalingIn) -> AutoscalingConfig:
    return AutoscalingConfig(
        enabled=payload.enabled,
        min_replicas=payload.min_replicas,
        max_replicas=payload.max_replicas,
        target_cpu_utilization=payload.target_cpu_utilization,
        target_memory_utilization=payload.target_memory_utilization,
    )


def _latest_autoscaling_config(namespace: str, app_name: str) -> AutoscalingConfig:
    for job in svc.jobs.list_jobs():
        if str(job.get("namespace") or "") != namespace or str(job.get("app_name") or "") != app_name:
            continue
        payload = job.get("autoscaling")
        if isinstance(payload, dict):
            try:
                return AutoscalingConfig(
                    enabled=bool(payload.get("enabled", True)),
                    min_replicas=int(payload.get("min_replicas", 1)),
                    max_replicas=int(payload.get("max_replicas", 5)),
                    target_cpu_utilization=int(payload.get("target_cpu_utilization", 80)),
                    target_memory_utilization=int(payload.get("target_memory_utilization", 80)),
                )
            except (TypeError, ValueError):
                return AutoscalingConfig()
    return AutoscalingConfig()


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


@app.post("/api/v1/auth/signup")
def v1_signup(payload: SignupIn, response: Response) -> Dict[str, object]:
    user = svc.accounts.create_user(payload.email, payload.password, payload.name)
    token = svc.accounts.create_session(str(user["id"]))
    _set_session_cookie(response, token)
    return {"user": user, "access_token": token, "token_type": "bearer"}


@app.post("/api/v1/auth/login")
def v1_login(payload: LoginIn, response: Response) -> Dict[str, object]:
    user = svc.accounts.authenticate(payload.email, payload.password)
    token = svc.accounts.create_session(str(user["id"]))
    _set_session_cookie(response, token)
    return {"user": user, "access_token": token, "token_type": "bearer"}


@app.post("/api/v1/auth/logout")
def v1_logout(request: Request, response: Response) -> Dict[str, str]:
    token = _session_token(request)
    svc.accounts.delete_session(token)
    response.delete_cookie("b3cloud_session")
    return {"status": "logged_out"}


@app.get("/api/v1/auth/me")
def v1_me(request: Request, x_api_key: Optional[str] = Header(default=None)) -> Dict[str, object]:
    return {"user": _require_user(request, x_api_key)}


@app.get("/api/v1/auth/github/start")
def v1_github_login_start() -> Dict[str, str]:
    client_id = os.getenv("B3CLOUD_GITHUB_CLIENT_ID", "")
    redirect_uri = os.getenv("B3CLOUD_GITHUB_REDIRECT_URI", "")
    if not client_id or not redirect_uri:
        raise HTTPException(status_code=501, detail="GitHub OAuth is not configured")
    state = secrets.token_urlsafe(24)
    params = urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": "read:user user:email",
            "state": state,
        }
    )
    return {"url": f"https://github.com/login/oauth/authorize?{params}", "state": state}


@app.get("/api/v1/auth/github/callback")
def v1_github_login_callback(
    response: Response,
    code: str = Query(default=""),
    state: str = Query(default=""),
) -> Dict[str, object]:
    if not code:
        raise HTTPException(status_code=400, detail="Missing GitHub OAuth code")
    client_id = os.getenv("B3CLOUD_GITHUB_CLIENT_ID", "")
    client_secret = os.getenv("B3CLOUD_GITHUB_CLIENT_SECRET", "")
    redirect_uri = os.getenv("B3CLOUD_GITHUB_REDIRECT_URI", "")
    if not client_id or not client_secret:
        raise HTTPException(status_code=501, detail="GitHub OAuth is not configured")

    token_payload = _github_request(
        "https://github.com/login/oauth/access_token",
        {
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "redirect_uri": redirect_uri,
            "state": state,
        },
    )
    access_token = str(token_payload.get("access_token") or "")
    if not access_token:
        raise HTTPException(status_code=401, detail=f"GitHub OAuth failed: {token_payload}")

    github_user = _github_request("https://api.github.com/user", token=access_token)
    github_emails = _github_request("https://api.github.com/user/emails", token=access_token)
    email = str(github_user.get("email") or "")
    if not email and isinstance(github_emails, list):
        primary = next((item for item in github_emails if item.get("primary")), None) or (github_emails[0] if github_emails else {})
        email = str(primary.get("email") or "")
    if not email:
        raise HTTPException(status_code=400, detail="GitHub account did not provide an email address")

    user = svc.accounts.link_github_identity(
        email,
        {
            "id": github_user.get("id"),
            "login": github_user.get("login"),
            "name": github_user.get("name") or github_user.get("login") or "",
            "avatar_url": github_user.get("avatar_url") or "",
            "access_token": access_token,
            "linked_at": _now(),
        },
    )
    token = svc.accounts.create_session(str(user["id"]))
    _set_session_cookie(response, token)
    return {"user": user, "access_token": token, "token_type": "bearer"}


@app.get("/api/v1/github/access/request")
def v1_github_access_request(request: Request, x_api_key: Optional[str] = Header(default=None)) -> Dict[str, str]:
    _require_user(request, x_api_key)
    install_url = os.getenv("B3CLOUD_GITHUB_APP_INSTALL_URL", "")
    app_slug = os.getenv("B3CLOUD_GITHUB_APP_SLUG", "")
    if not install_url and app_slug:
        install_url = f"https://github.com/apps/{app_slug}/installations/new"
    if not install_url:
        raise HTTPException(status_code=501, detail="GitHub App install URL is not configured")
    return {"url": install_url}


@app.get("/api/v1/github/installations")
def v1_github_installations(request: Request, x_api_key: Optional[str] = Header(default=None)) -> List[Dict[str, object]]:
    user = _require_user(request, x_api_key)
    github = user.get("github") if isinstance(user, dict) else {}
    installation_id = str((github or {}).get("installation_id") or "")
    return [{"installation_id": installation_id}] if installation_id else []


@app.get("/api/v1/github/repos")
def v1_github_repos(request: Request, x_api_key: Optional[str] = Header(default=None)) -> List[Dict[str, object]]:
    user = _require_user(request, x_api_key)
    return svc.accounts.repo_links_for_user(str(user["id"]))


@app.get("/api/v1/github/repos/{owner}/{repo}/branches")
def v1_github_repo_branches(
    owner: str,
    repo: str,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> List[Dict[str, str]]:
    _require_user(request, x_api_key)
    return [{"name": "main"}, {"name": "master"}]


@app.post("/api/v1/github/link")
def v1_github_link(
    payload: GitHubLinkIn,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    user = _require_user(request, x_api_key)
    return svc.accounts.link_repo(str(user["id"]), payload)


@app.post("/api/v1/github/repos/analyze")
def v1_analyze_repo(
    payload: RepoAnalyzeIn,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    return analyze_app(payload, x_api_key=svc.api_key)


@app.get("/api/v1/deployments")
def v1_list_deployments(
    request: Request,
    namespace: Optional[str] = Query(default=None),
    x_api_key: Optional[str] = Header(default=None),
) -> List[Dict[str, object]]:
    _require_user(request, x_api_key)
    return _list_deployments(namespace)


@app.post("/api/v1/deployments")
def v1_create_deployment(
    payload: AppDeployIn,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    job = deploy_app(payload, x_api_key=svc.api_key)
    job["deployment_id"] = _deployment_id(str(job["namespace"]), str(job["app_name"]))
    return job


@app.get("/api/v1/deployments/{deployment_id}")
def v1_get_deployment(
    deployment_id: str,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    namespace, app_name = _parse_deployment_id(deployment_id)
    return _deployment_detail(namespace, app_name)


@app.patch("/api/v1/deployments/{deployment_id}")
def v1_update_deployment(
    deployment_id: str,
    payload: DeploymentUpdateIn,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    namespace, app_name = _parse_deployment_id(deployment_id)
    return {
        "deployment_id": deployment_id,
        "namespace": namespace,
        "app_name": app_name,
        "status": "config_accepted",
        "detail": "Persisted deployment config storage is not implemented yet; send the updated config to redeploy.",
        "config": payload.model_dump(exclude_none=True),
    }


@app.delete("/api/v1/deployments/{deployment_id}")
def v1_delete_deployment(
    deployment_id: str,
    request: Request,
    payload: DeploymentDeleteIn = DeploymentDeleteIn(),
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    namespace, app_name = _parse_deployment_id(deployment_id)
    _delete_application(namespace, app_name, delete_data=payload.delete_data)
    return {"deployment_id": deployment_id, "namespace": namespace, "app_name": app_name, "status": "deleted"}


@app.post("/api/v1/deployments/{deployment_id}/redeploy")
def v1_redeploy(
    deployment_id: str,
    payload: AppDeployIn,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    return v1_create_deployment(payload, request, x_api_key)


@app.post("/api/v1/deployments/{deployment_id}/rollback")
def v1_rollback(
    deployment_id: str,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    raise HTTPException(status_code=409, detail="Rollback requires retaining previous releases; old releases are currently cleaned after successful switch")


@app.post("/api/v1/deployments/{deployment_id}/stop")
def v1_stop_deployment(
    deployment_id: str,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    namespace, app_name = _parse_deployment_id(deployment_id)
    deployment_name = _active_app_deployment(namespace, app_name).metadata.name
    svc.core._delete_hpa_if_exists(namespace, app_name)
    _scale_deployment(namespace, deployment_name, 0)
    return {"deployment_id": deployment_id, "status": "stopped"}


@app.post("/api/v1/deployments/{deployment_id}/start")
def v1_start_deployment(
    deployment_id: str,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    namespace, app_name = _parse_deployment_id(deployment_id)
    deployment_name = _active_app_deployment(namespace, app_name).metadata.name
    _scale_deployment(namespace, deployment_name, 1)
    autoscaling = _latest_autoscaling_config(namespace, app_name)
    if autoscaling.enabled:
        svc.core._create_or_update_hpa(namespace, app_name, deployment_name, autoscaling)
    return {"deployment_id": deployment_id, "status": "started"}


@app.get("/api/v1/deployments/{deployment_id}/jobs")
def v1_deployment_jobs(
    deployment_id: str,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> List[Dict[str, object]]:
    _require_user(request, x_api_key)
    namespace, app_name = _parse_deployment_id(deployment_id)
    return [
        job
        for job in svc.jobs.list_jobs()
        if str(job.get("namespace") or "") == namespace and str(job.get("app_name") or "") == app_name
    ]


@app.get("/api/v1/deploy-jobs")
def v1_list_deploy_jobs(request: Request, x_api_key: Optional[str] = Header(default=None)) -> List[Dict[str, object]]:
    _require_user(request, x_api_key)
    return svc.jobs.list_jobs()


@app.get("/api/v1/deploy-jobs/{job_id}")
def v1_get_deploy_job(job_id: str, request: Request, x_api_key: Optional[str] = Header(default=None)) -> Dict[str, object]:
    _require_user(request, x_api_key)
    return get_deploy_job(job_id, x_api_key=svc.api_key)


@app.get("/api/v1/deploy-jobs/{job_id}/events")
def v1_deploy_job_events(job_id: str, request: Request, x_api_key: Optional[str] = Header(default=None)) -> StreamingResponse:
    _require_user(request, x_api_key)

    def event_stream():
        sent = 0
        terminal = {"succeeded", "failed", "cancelled"}
        while True:
            job = svc.jobs.get_job(job_id)
            if not job:
                yield "event: error\ndata: Deploy job not found\n\n"
                return
            logs = list(job.get("logs", []))
            for line in logs[sent:]:
                yield f"event: log\ndata: {json.dumps({'message': line})}\n\n"
            sent = len(logs)
            yield f"event: status\ndata: {json.dumps({'status': job.get('status'), 'updated_at': job.get('updated_at')})}\n\n"
            if str(job.get("status")) in terminal:
                yield f"event: done\ndata: {json.dumps(job)}\n\n"
                return
            time.sleep(2)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/v1/deploy-jobs/{job_id}/cancel")
def v1_cancel_deploy_job(job_id: str, request: Request, x_api_key: Optional[str] = Header(default=None)) -> Dict[str, object]:
    _require_user(request, x_api_key)
    job = svc.jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Deploy job not found: {job_id}")
    if str(job.get("status")) not in {"queued"}:
        raise HTTPException(status_code=409, detail="Only queued jobs can be cancelled")
    svc.jobs.set_status(job_id, "cancelled")
    svc.jobs.append_log(job_id, "Deploy job cancelled by user.")
    return svc.jobs.get_job(job_id) or {}


@app.get("/api/v1/deployments/{deployment_id}/components")
def v1_deployment_components(
    deployment_id: str,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> List[Dict[str, object]]:
    _require_user(request, x_api_key)
    namespace, app_name = _parse_deployment_id(deployment_id)
    return _deployment_components(namespace, app_name)


@app.get("/api/v1/deployments/{deployment_id}/components/{component_id}")
def v1_deployment_component(
    deployment_id: str,
    component_id: str,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    namespace, _ = _parse_deployment_id(deployment_id)
    return _runtime_logs_for_component(namespace, component_id, component_id, tail_lines=80)


@app.post("/api/v1/deployments/{deployment_id}/components/{component_id}/restart")
def v1_restart_component(
    deployment_id: str,
    component_id: str,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    namespace, _ = _parse_deployment_id(deployment_id)
    dep = _active_app_deployment(namespace, component_id)
    svc.core.apps.patch_namespaced_deployment(
        dep.metadata.name,
        namespace,
        {"spec": {"template": {"metadata": {"annotations": {"b3cloud.io/restarted-at": _now()}}}}},
    )
    return {"deployment_id": deployment_id, "component_id": component_id, "status": "restarted"}


@app.get("/api/v1/deployments/{deployment_id}/components/{component_id}/runtime-logs")
def v1_component_runtime_logs(
    deployment_id: str,
    component_id: str,
    request: Request,
    tail_lines: int = Query(default=160, ge=20, le=500),
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    namespace, _ = _parse_deployment_id(deployment_id)
    return _runtime_logs_for_component(namespace, component_id, component_id, tail_lines=tail_lines)


@app.get("/api/v1/deployments/{deployment_id}/components/{component_id}/pods")
def v1_component_pods(
    deployment_id: str,
    component_id: str,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> List[Dict[str, object]]:
    _require_user(request, x_api_key)
    namespace, _ = _parse_deployment_id(deployment_id)
    logs = _runtime_logs_for_component(namespace, component_id, component_id, tail_lines=80)
    return list(logs.get("pods", []))


@app.get("/api/v1/deployments/{deployment_id}/components/{component_id}/pods/{pod_name}/containers/{container_name}/logs")
def v1_component_container_logs(
    deployment_id: str,
    component_id: str,
    pod_name: str,
    container_name: str,
    request: Request,
    tail_lines: int = Query(default=200, ge=20, le=1000),
    previous: bool = Query(default=False),
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    namespace, _ = _parse_deployment_id(deployment_id)
    return app_container_logs(namespace, component_id, pod_name, container_name, tail_lines, previous, x_api_key=svc.api_key)


@app.get("/api/v1/deployments/{deployment_id}/logs")
def v1_deployment_logs(
    deployment_id: str,
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    namespace, app_name = _parse_deployment_id(deployment_id)
    jobs = v1_deployment_jobs(deployment_id, request, x_api_key=x_api_key)
    return {
        "deployment_id": deployment_id,
        "namespace": namespace,
        "app_name": app_name,
        "jobs": jobs,
        "logs": [line for job in jobs for line in list(job.get("logs", []))],
    }


@app.get("/api/v1/deployments/{deployment_id}/env")
def v1_deployment_env(deployment_id: str, request: Request, x_api_key: Optional[str] = Header(default=None)) -> Dict[str, object]:
    _require_user(request, x_api_key)
    return {"deployment_id": deployment_id, "env": [], "detail": "Environment persistence API is reserved for the frontend config store."}


@app.put("/api/v1/deployments/{deployment_id}/env")
@app.patch("/api/v1/deployments/{deployment_id}/env")
def v1_update_deployment_env(
    deployment_id: str,
    payload: Dict[str, str],
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    return {"deployment_id": deployment_id, "status": "accepted", "env": {key: "***" for key in payload}}


@app.post("/api/v1/deployments/{deployment_id}/secrets")
def v1_update_deployment_secrets(
    deployment_id: str,
    payload: Dict[str, str],
    request: Request,
    x_api_key: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    _require_user(request, x_api_key)
    return {"deployment_id": deployment_id, "status": "accepted", "secrets": list(payload.keys())}


@app.get("/api/v1/deployments/{deployment_id}/domains")
def v1_deployment_domains(deployment_id: str, request: Request, x_api_key: Optional[str] = Header(default=None)) -> List[Dict[str, str]]:
    _require_user(request, x_api_key)
    detail = v1_get_deployment(deployment_id, request, x_api_key=x_api_key)
    url = str(detail.get("url") or "")
    return [{"domain": url.replace("https://", ""), "status": "active"}] if url else []


@app.get("/apps")
def list_apps(
    namespace: Optional[str] = Query(default=None),
    x_api_key: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> List[Dict[str, str]]:
    svc.auth(x_api_key, authorization)
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
def analyze_app(
    payload: RepoAnalyzeIn,
    x_api_key: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    svc.auth(x_api_key, authorization)
    defaults = svc.defaults_from_github_url(payload.github_url)
    analysis = svc.core.analyze_repository(payload.github_url, payload.git_revision, github_token=payload.github_token)
    analysis.update(defaults)
    return analysis


@app.post("/apps/deploy")
def deploy_app(
    payload: AppDeployIn,
    x_api_key: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    svc.auth(x_api_key, authorization)
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
def list_deploy_jobs(
    x_api_key: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> List[Dict[str, object]]:
    svc.auth(x_api_key, authorization)
    return svc.jobs.list_jobs()


@app.get("/deploy-jobs/{job_id}")
def get_deploy_job(
    job_id: str,
    x_api_key: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    svc.auth(x_api_key, authorization)
    job = svc.jobs.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Deploy job not found: {job_id}")
    _attach_runtime_logs(job)
    return job


@app.get("/apps/{namespace}/{app_name}")
def app_status(
    namespace: str,
    app_name: str,
    x_api_key: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    svc.auth(x_api_key, authorization)
    try:
        dep = _active_app_deployment(namespace, app_name)
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
        "deployment_name": dep.metadata.name,
        "status": "deployed",
        "replicas": str(dep.spec.replicas or 0),
        "ready_replicas": str(dep.status.ready_replicas or 0),
        "image": image,
        "autoscaling": _hpa_status(namespace, app_name),
    }


@app.get("/apps/{namespace}/{app_name}/runtime-logs")
def app_runtime_logs(
    namespace: str,
    app_name: str,
    tail_lines: int = Query(default=160, ge=20, le=500),
    x_api_key: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    svc.auth(x_api_key, authorization)
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
    authorization: Optional[str] = Header(default=None),
) -> Dict[str, object]:
    svc.auth(x_api_key, authorization)
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


def _session_token(request: Request) -> str:
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        return auth_header.split(" ", 1)[1].strip()
    return request.cookies.get("b3cloud_session", "")


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        "b3cloud_session",
        token,
        httponly=True,
        secure=True,
        samesite="lax",
        max_age=60 * 60 * 24 * 30,
    )


def _github_request(url: str, payload: Optional[Dict[str, str]] = None, token: str = ""):
    data = None
    headers = {
        "Accept": "application/json",
        "User-Agent": "B3Cloud",
    }
    if payload is not None:
        data = urlencode(payload).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urlrequest.Request(url, data=data, headers=headers, method="POST" if payload is not None else "GET")
    try:
        with urlrequest.urlopen(req, timeout=15) as response:
            return json.loads(response.read().decode("utf-8"))
    except urlerror.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise HTTPException(status_code=exc.code, detail=f"GitHub request failed: {detail}") from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GitHub request failed: {exc}") from exc


def _require_user(request: Request, x_api_key: Optional[str]) -> Dict[str, object]:
    auth_header = request.headers.get("authorization", "")
    if auth_header.lower().startswith("bearer "):
        return svc.auth(None, auth_header)
    if x_api_key and svc.api_key and x_api_key == svc.api_key:
        return {"id": "api-key", "email": "api-key@local", "name": "API Key", "github": {}}
    user = svc.accounts.user_for_token(_session_token(request))
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return user


def _deployment_id(namespace: str, app_name: str) -> str:
    return f"{namespace}:{app_name}"


def _parse_deployment_id(deployment_id: str) -> tuple[str, str]:
    if ":" not in deployment_id:
        raise HTTPException(status_code=400, detail="deployment_id must be '<namespace>:<app_name>'")
    namespace, app_name = deployment_id.split(":", 1)
    if not namespace or not app_name:
        raise HTTPException(status_code=400, detail="deployment_id must include namespace and app name")
    return namespace, app_name


def _list_deployments(namespace: Optional[str] = None) -> List[Dict[str, object]]:
    seen: set[tuple[str, str]] = set()
    deployments: List[Dict[str, object]] = []
    for job in svc.jobs.list_jobs():
        job_namespace = str(job.get("namespace") or "")
        job_app_name = str(job.get("app_name") or "")
        if not job_namespace or not job_app_name or (namespace and job_namespace != namespace):
            continue
        key = (job_namespace, job_app_name)
        if key in seen:
            continue
        seen.add(key)
        try:
            detail = _deployment_detail(job_namespace, job_app_name)
        except Exception:
            detail = {
                "deployment_id": _deployment_id(job_namespace, job_app_name),
                "namespace": job_namespace,
                "app_name": job_app_name,
                "status": "unknown",
            }
        detail["last_job"] = job
        deployments.append(detail)

    kube_deployments = (
        svc.core.apps.list_namespaced_deployment(namespace).items
        if namespace
        else svc.core.apps.list_deployment_for_all_namespaces().items
    )
    for dep in kube_deployments:
        labels = dep.metadata.labels or {}
        app_name = str(labels.get("b3cloud.io/app") or dep.metadata.name)
        dep_namespace = str(dep.metadata.namespace)
        key = (dep_namespace, app_name)
        if key in seen:
            continue
        seen.add(key)
        deployments.append(_deployment_detail(dep_namespace, app_name))

    deployments.sort(key=lambda item: str((item.get("last_job") or {}).get("updated_at") or item.get("updated_at") or ""), reverse=True)
    return deployments


def _deployment_detail(namespace: str, app_name: str) -> Dict[str, object]:
    status = app_status(namespace, app_name, x_api_key=svc.api_key)
    jobs = [
        job
        for job in svc.jobs.list_jobs()
        if str(job.get("namespace") or "") == namespace and str(job.get("app_name") or "") == app_name
    ]
    latest_job = jobs[0] if jobs else None
    url = ""
    github_url = ""
    git_revision = ""
    components: List[Dict[str, object]] = []
    if latest_job:
        url = f"https://{latest_job.get('domain')}" if latest_job.get("domain") else ""
        github_url = str(latest_job.get("github_url") or "")
        git_revision = str(latest_job.get("git_revision") or "")
        components = _deployment_components(namespace, app_name, latest_job)
    else:
        components = _deployment_components(namespace, app_name)
    status.update(
        {
            "deployment_id": _deployment_id(namespace, app_name),
            "url": url,
            "github_url": github_url,
            "git_revision": git_revision,
            "components": components,
            "last_job": latest_job,
            "updated_at": latest_job.get("updated_at") if latest_job else "",
        }
    )
    return status


def _deployment_components(
    namespace: str,
    app_name: str,
    job: Optional[Dict[str, object]] = None,
) -> List[Dict[str, object]]:
    if job is None:
        jobs = [
            item
            for item in svc.jobs.list_jobs()
            if str(item.get("namespace") or "") == namespace and str(item.get("app_name") or "") == app_name
        ]
        job = jobs[0] if jobs else None

    components = _job_runtime_components(job) if job else [{"app_name": app_name, "component_name": app_name}]
    out: List[Dict[str, object]] = []
    for component in components:
        component_app_name = str(component["app_name"])
        runtime = _runtime_logs_for_component(
            namespace,
            component_app_name,
            str(component["component_name"]),
            tail_lines=80,
        )
        out.append(
            {
                "id": component_app_name,
                "app_name": component_app_name,
                "component_name": component["component_name"],
                "status": runtime.get("status"),
                "ready_replicas": runtime.get("ready_replicas"),
                "replicas": runtime.get("replicas"),
                "error_summary": runtime.get("error_summary"),
                "deployment_name": runtime.get("deployment_name", ""),
            }
        )
    return out


def _delete_application(namespace: str, app_name: str, delete_data: bool = False) -> None:
    svc.core._cleanup_old_application_deployments(namespace, app_name, active_deployment="")
    svc.core._delete_hpa_if_exists(namespace, app_name)
    svc.core._delete_service_if_exists(namespace, app_name)
    svc.core._delete_ingress_if_exists(namespace, app_name)
    if not delete_data:
        return

    backing_services: List[ServiceRequirement] = []
    for job in svc.jobs.list_jobs():
        if str(job.get("namespace") or "") != namespace or str(job.get("app_name") or "") != app_name:
            continue
        for service_type in job.get("provision_services", []) or []:
            backing_services.append(ServiceRequirement(type=str(service_type), confidence="stored", evidence=[]))
        for component in job.get("components", []) or []:
            if not isinstance(component, dict):
                continue
            for service_type in component.get("provision_services", []) or []:
                backing_services.append(ServiceRequirement(type=str(service_type), confidence="stored", evidence=[]))
    if backing_services:
        svc.core._cleanup_backing_services(namespace, app_name, backing_services)


def _scale_deployment(namespace: str, deployment_name: str, replicas: int) -> None:
    body = client.V1Scale(
        spec=client.V1ScaleSpec(replicas=replicas),
    )
    svc.core.apps.patch_namespaced_deployment_scale(deployment_name, namespace, body)


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
        dep = _active_app_deployment(namespace, app_name)
        payload["replicas"] = dep.spec.replicas or 0
        payload["ready_replicas"] = dep.status.ready_replicas or 0
        payload["deployment_name"] = dep.metadata.name
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
        pods = svc.core.core.list_namespaced_pod(
            namespace,
            label_selector=_active_pod_label_selector(namespace, app_name),
        ).items
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


def _active_app_deployment(namespace: str, app_name: str):
    selector = _active_service_selector(namespace, app_name)
    deployments = _matching_app_deployments(namespace, app_name)
    if selector:
        for dep in deployments:
            template_labels = dep.spec.template.metadata.labels or {}
            if all(template_labels.get(key) == value for key, value in selector.items()):
                return dep
    if deployments:
        deployments.sort(
            key=lambda dep: dep.metadata.creation_timestamp.isoformat() if dep.metadata.creation_timestamp else "",
            reverse=True,
        )
        return deployments[0]
    raise ApiException(status=404, reason=f"Deployment not found for app {app_name}")


def _matching_app_deployments(namespace: str, app_name: str):
    deployments = svc.core.apps.list_namespaced_deployment(namespace).items
    return [
        dep
        for dep in deployments
        if dep.metadata.name == app_name or (dep.metadata.labels or {}).get("b3cloud.io/app") == app_name
    ]


def _active_pod_label_selector(namespace: str, app_name: str) -> str:
    selector = _active_service_selector(namespace, app_name)
    if selector:
        return ",".join(f"{key}={value}" for key, value in sorted(selector.items()))
    return f"app={app_name}"


def _active_service_selector(namespace: str, app_name: str) -> Dict[str, str]:
    try:
        service = svc.core.core.read_namespaced_service(app_name, namespace)
    except ApiException as exc:
        if exc.status == 404:
            return {}
        raise
    return dict(service.spec.selector or {})


def _hpa_status(namespace: str, app_name: str) -> Dict[str, object]:
    try:
        hpa = svc.core.autoscaling.read_namespaced_horizontal_pod_autoscaler(app_name, namespace)
    except ApiException as exc:
        if exc.status == 404:
            return {"enabled": False}
        return {"enabled": False, "error": str(exc)}
    return {
        "enabled": True,
        "min_replicas": hpa.spec.min_replicas,
        "max_replicas": hpa.spec.max_replicas,
        "current_replicas": hpa.status.current_replicas,
        "desired_replicas": hpa.status.desired_replicas,
        "current_metrics": [metric.to_dict() for metric in (hpa.status.current_metrics or [])],
    }


def _ensure_pod_belongs_to_app(namespace: str, app_name: str, pod_name: str) -> None:
    try:
        pod = svc.core.core.read_namespaced_pod(pod_name, namespace)
    except ApiException as exc:
        if exc.status == 404:
            raise HTTPException(status_code=404, detail=f"Pod not found: {pod_name}") from exc
        raise
    labels = pod.metadata.labels or {}
    if labels.get("app") != app_name and labels.get("b3cloud.io/app") != app_name:
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
