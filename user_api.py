"""B3Cloud user-facing API.

This API is intended for tenant usage and exposes a restricted subset of actions.
"""

from __future__ import annotations

import os
from typing import Dict, Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from platform_core import DeploymentRequest, PlatformCore, ResourceLimits, sanitize_name


class ResourceLimitsIn(BaseModel):
    cpu_request: str = "100m"
    cpu_limit: str = "500m"
    memory_request: str = "128Mi"
    memory_limit: str = "512Mi"


class AppDeployIn(BaseModel):
    github_url: str
    domain: str
    app_name: str
    namespace: str
    registry_repo: str
    env: Dict[str, str] = Field(default_factory=dict)
    git_revision: str = "main"
    port: int = 8080
    node_arch: Optional[str] = None
    resources: ResourceLimitsIn = Field(default_factory=ResourceLimitsIn)


class UserApi:
    def __init__(self) -> None:
        self.api_key = os.getenv("B3CLOUD_USER_API_KEY", "")
        kubeconfig = os.getenv("B3CLOUD_KUBECONFIG", "./kubeconfig")
        self.core = PlatformCore(kubeconfig=kubeconfig)

    def auth(self, x_api_key: Optional[str]) -> None:
        if not self.api_key:
            raise HTTPException(status_code=500, detail="Server misconfigured: B3CLOUD_USER_API_KEY is not set")
        if x_api_key != self.api_key:
            raise HTTPException(status_code=401, detail="Unauthorized")


svc = UserApi()
app = FastAPI(title="B3Cloud User API", version="1.0.0")


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/apps/deploy")
def deploy_app(payload: AppDeployIn, x_api_key: Optional[str] = Header(default=None)) -> Dict[str, str]:
    svc.auth(x_api_key)
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
        target_host=payload.domain,
        registry_repo=payload.registry_repo,
        git_revision=payload.git_revision,
        port=payload.port,
        node_arch=payload.node_arch,
    )
    try:
        return svc.core.new_deployment(req)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/apps/{namespace}/{app_name}")
def app_status(namespace: str, app_name: str, x_api_key: Optional[str] = Header(default=None)) -> Dict[str, str]:
    svc.auth(x_api_key)
    dep = svc.core.apps.read_namespaced_deployment(app_name, namespace)
    image = dep.spec.template.spec.containers[0].image if dep.spec.template.spec.containers else ""
    return {
        "namespace": namespace,
        "app_name": app_name,
        "replicas": str(dep.spec.replicas or 0),
        "ready_replicas": str(dep.status.ready_replicas or 0),
        "image": image,
    }
