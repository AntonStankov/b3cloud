"""Core orchestration module for GitHub -> kpack -> Kubernetes deployment.

This module creates all runtime resources required for a new PaaS app deployment:
1. Namespace + guardrails (ResourceQuota, LimitRange)
2. kpack Image for build-from-source
3. Kubernetes Deployment and Service with the resulting image
4. NGINX Ingress for internal routing behind Cloudflare Zero Trust Tunnel
5. Cloudflare API automation for DNS + tunnel hostname routing
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from copy import deepcopy
from collections.abc import Callable
from urllib import error, request
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Iterable, Optional

from kubernetes import client, config
from kubernetes.client.rest import ApiException


@dataclass
class ResourceLimits:
    cpu_request: str
    cpu_limit: str
    memory_request: str
    memory_limit: str


@dataclass
class ServiceRequirement:
    type: str
    confidence: str
    evidence: list[str]
    provision: bool = True


@dataclass
class EnvRequirement:
    name: str
    required: bool
    source: str
    evidence: list[str]
    secret: bool = False
    platform_managed: bool = False


@dataclass
class DeployableComponent:
    name: str
    path: str
    type: str
    public: bool
    port: int
    port_confidence: str
    port_evidence: list[str]
    env: list[EnvRequirement]
    services: list[ServiceRequirement]
    evidence: list[str]


@dataclass
class DeploymentRequest:
    github_url: str
    env: Dict[str, str]
    resources: ResourceLimits
    namespace: str
    app_name: str
    target_host: str
    registry_repo: str
    git_revision: str = "main"
    app_path: str = "."
    port: int = 8080
    node_arch: Optional[str] = None  # "amd64" (CPX) or "arm64" (CAX)
    service_requirements: Optional[list[ServiceRequirement]] = None
    public: bool = True


@dataclass
class CloudflareConfig:
    api_token: str
    account_id: str
    tunnel_id: str
    default_zone_id: Optional[str] = None
    tunnel_cname_target: Optional[str] = None
    tunnel_origin_service: str = "http://ingress-nginx-controller.ingress-nginx.svc.cluster.local:80"


class PlatformCore:
    BUILDER_NAME = "platform-builder"
    BUILDER_KIND = "Builder"
    BUILD_SERVICE_ACCOUNT = "kpack-builder-sa"
    REGISTRY_SECRET_NAME = "registry-creds"
    GIT_SOURCE_SECRET_NAME = "github-basic-auth"
    PACK_BUILDER_IMAGE = os.getenv("B3CLOUD_PACK_BUILDER_IMAGE", "paketobuildpacks/builder-jammy-base")
    PLATFORM_MANAGED_ENV_NAMES = {
        "PORT",
        "DATABASE_URL",
        "POSTGRES_URL",
        "POSTGRES_HOST",
        "MYSQL_URL",
        "MYSQL_HOST",
        "MONGODB_URI",
        "MONGO_URL",
        "MONGODB_HOST",
        "REDIS_URL",
        "REDIS_HOST",
        "RABBITMQ_URL",
        "AMQP_URL",
        "RABBITMQ_HOST",
    }

    def __init__(self, kubeconfig: Optional[str] = None, context: Optional[str] = None):
        if kubeconfig:
            config.load_kube_config(config_file=kubeconfig, context=context)
        else:
            config.load_kube_config(context=context)

        self.core = client.CoreV1Api()
        self.apps = client.AppsV1Api()
        self.custom = client.CustomObjectsApi()
        self.networking = client.NetworkingV1Api()
        self.cloudflare = CloudflareAutomation()
        self.cloudflare_config = self._load_cloudflare_config_from_env()

    def new_deployment(
        self,
        req: DeploymentRequest,
        status_callback: Optional[Callable[[str], None]] = None,
    ) -> Dict[str, str]:
        self._validate_deployment_request(req)
        self._emit_status(status_callback, f"Preparing namespace '{req.namespace}'.")
        self._ensure_namespace(req.namespace)
        self._apply_namespace_guardrails(req.namespace)
        self._ensure_build_namespace_prereqs(req.namespace)
        backing_services = [svc for svc in (req.service_requirements or []) if svc.provision]
        generated_env: Dict[str, client.V1EnvVar] = {}
        if backing_services:
            self._emit_status(
                status_callback,
                "Provisioning internal backing services: "
                + ", ".join(sorted({svc.type for svc in backing_services})),
            )
            generated_env = self._provision_backing_services(req.namespace, req.app_name, backing_services)

        output_image = f"{req.registry_repo}/{req.app_name}:{self._short_hash(req.github_url + req.git_revision + req.app_path)}"
        self._emit_status(status_callback, f"Starting build for '{req.app_name}' from {req.github_url}@{req.git_revision}.")
        ready_image = self._build_image_with_pack(req, output_image, status_callback=status_callback)

        self._emit_status(status_callback, f"Applying Kubernetes Deployment/Service/Ingress for '{req.app_name}'.")
        self._create_or_update_deployment(req, ready_image, generated_env)
        self._create_or_update_service(req.namespace, req.app_name, req.port)
        if req.public:
            self._create_or_update_ingress(req.namespace, req.app_name, req.target_host, req.port)
            self._emit_status(status_callback, f"Ensuring Cloudflare route for {req.target_host}.")
            self.cloudflare.ensure_dns_and_tunnel_route(self.cloudflare_config, req.target_host)
        self._emit_status(status_callback, f"Deployment finished for {req.app_name}.")

        return {
            "namespace": req.namespace,
            "app_name": req.app_name,
            "image": ready_image,
            "url": f"https://{req.target_host}" if req.public else "",
            "status": "deployed",
            "services": ",".join(sorted({svc.type for svc in backing_services})),
        }

    def analyze_repository(
        self,
        github_url: str,
        git_revision: str = "main",
        status_callback: Optional[Callable[[str], None]] = None,
    ) -> Dict[str, object]:
        github_pat = os.getenv("B3CLOUD_GITHUB_PAT", "")
        with tempfile.TemporaryDirectory(prefix="b3cloud-analyze-") as tmpdir:
            repo_dir = Path(tmpdir) / "src"
            try:
                self._emit_status(status_callback, f"Cloning source repo {github_url} for service detection.")
                self._run_command(["git", "clone", github_url, str(repo_dir)])
            except RuntimeError:
                clone_url = self._github_clone_url(github_url, github_pat)
                if clone_url == github_url:
                    raise
                self._emit_status(status_callback, "Retrying analysis clone with GitHub token.")
                self._run_command(["git", "clone", clone_url, str(repo_dir)])
            self._run_command(["git", "-C", str(repo_dir), "checkout", git_revision])
            components = self._detect_deployable_components(repo_dir)
            app_dir = repo_dir / components[0].path if components else self._detect_app_path(repo_dir)
            requirements = self._detect_service_requirements(app_dir)
            return {
                "github_url": github_url,
                "git_revision": git_revision,
                "app_path": str(app_dir.relative_to(repo_dir)),
                "services": [asdict(req) for req in requirements],
                "components": [asdict(component) for component in components],
            }

    @staticmethod
    def _validate_deployment_request(req: DeploymentRequest) -> None:
        if not req.target_host or not req.target_host.strip():
            raise ValueError("target_host is required. Provide a fully qualified domain name.")
        # Basic FQDN check; platform API should do stricter tenant-domain validation.
        if "." not in req.target_host or req.target_host.startswith(".") or req.target_host.endswith("."):
            raise ValueError(f"target_host must be a valid FQDN, got: {req.target_host}")

    @staticmethod
    def _load_cloudflare_config_from_env() -> CloudflareConfig:
        required = {
            "CF_API_TOKEN": os.getenv("CF_API_TOKEN", ""),
            "CF_ACCOUNT_ID": os.getenv("CF_ACCOUNT_ID", ""),
            "CF_TUNNEL_ID": os.getenv("CF_TUNNEL_ID", ""),
        }
        missing = [k for k, v in required.items() if not v]
        if missing:
            raise ValueError(f"Missing required Cloudflare env vars: {', '.join(missing)}")

        return CloudflareConfig(
            api_token=required["CF_API_TOKEN"],
            account_id=required["CF_ACCOUNT_ID"],
            tunnel_id=required["CF_TUNNEL_ID"],
            default_zone_id=os.getenv("CF_ZONE_ID") or None,
            tunnel_cname_target=os.getenv("CF_TUNNEL_CNAME_TARGET"),
            tunnel_origin_service=os.getenv(
                "CF_TUNNEL_ORIGIN_SERVICE",
                "http://ingress-nginx-controller.ingress-nginx.svc.cluster.local:80",
            ),
        )

    def _ensure_namespace(self, namespace: str) -> None:
        body = client.V1Namespace(metadata=client.V1ObjectMeta(name=namespace))
        try:
            self.core.create_namespace(body=body)
        except ApiException as exc:
            if exc.status != 409:
                raise

    def _apply_namespace_guardrails(self, namespace: str) -> None:
        quota_manifest = {
            "apiVersion": "v1",
            "kind": "ResourceQuota",
            "metadata": {"name": "app-quota", "namespace": namespace},
            "spec": {
                "hard": {
                    "pods": "20",
                    "requests.cpu": "8",
                    "requests.memory": "16Gi",
                    "limits.cpu": "16",
                    "limits.memory": "32Gi",
                    "services": "20",
                }
            },
        }

        limit_range_manifest = {
            "apiVersion": "v1",
            "kind": "LimitRange",
            "metadata": {"name": "app-limits", "namespace": namespace},
            "spec": {
                "limits": [
                    {
                        "type": "Container",
                        "defaultRequest": {"cpu": "100m", "memory": "128Mi"},
                        "default": {"cpu": "500m", "memory": "512Mi"},
                        "min": {"cpu": "50m", "memory": "64Mi"},
                        "max": {"cpu": "2", "memory": "4Gi"},
                    }
                ]
            },
        }

        self._apply_core_object(namespace, "resourcequotas", "app-quota", quota_manifest)
        self._apply_core_object(namespace, "limitranges", "app-limits", limit_range_manifest)

    def _create_or_update_kpack_image(
        self,
        namespace: str,
        image_name: str,
        github_url: str,
        git_revision: str,
        output_image: str,
    ) -> None:
        manifest = {
            "apiVersion": "kpack.io/v1alpha2",
            "kind": "Image",
            "metadata": {
                "name": image_name,
                "namespace": namespace,
            },
            "spec": {
                "tag": output_image,
                "serviceAccountName": self.BUILD_SERVICE_ACCOUNT,
                "builder": {
                    "kind": self.BUILDER_KIND,
                    "name": self.BUILDER_NAME,
                },
                "source": {
                    "git": {
                        "url": github_url,
                        "revision": git_revision,
                    }
                },
                "cache": {
                    "volume": {
                        "size": "2Gi"
                    }
                },
            },
        }

        group = "kpack.io"
        version = "v1alpha2"
        plural = "images"

        try:
            self.custom.get_namespaced_custom_object(group, version, namespace, plural, image_name)
            self.custom.patch_namespaced_custom_object(group, version, namespace, plural, image_name, manifest)
        except ApiException as exc:
            if exc.status == 404:
                self.custom.create_namespaced_custom_object(group, version, namespace, plural, manifest)
            else:
                raise

    def _wait_for_kpack_image_ready(self, namespace: str, image_name: str, timeout_seconds: int) -> str:
        group = "kpack.io"
        version = "v1alpha2"
        plural = "images"

        deadline = time.time() + timeout_seconds
        while time.time() < deadline:
            obj = self.custom.get_namespaced_custom_object(group, version, namespace, plural, image_name)
            status = obj.get("status", {})
            latest = status.get("latestImage")
            ready = self._condition_is_true(status.get("conditions", []), "Ready")
            if ready and latest:
                return latest
            latest_build = status.get("latestBuildRef")
            if latest_build:
                build = self.custom.get_namespaced_custom_object(group, version, namespace, "builds", latest_build)
                build_message = self._first_false_condition_message(build.get("status", {}).get("conditions", []))
                if build_message:
                    raise RuntimeError(f"kpack build {latest_build} failed: {build_message}")
            ready_message = self._first_false_condition_message(status.get("conditions", []), condition_type="Ready")
            if ready_message and "build '" not in ready_message.lower():
                raise RuntimeError(f"kpack image {image_name} is not ready: {ready_message}")
            time.sleep(5)

        raise TimeoutError(f"Timed out waiting for kpack Image/{image_name} to become ready")

    def _build_image_with_pack(
        self,
        req: DeploymentRequest,
        output_image: str,
        status_callback: Optional[Callable[[str], None]] = None,
    ) -> str:
        registry_username = os.getenv("B3CLOUD_REGISTRY_USERNAME", "")
        registry_password = os.getenv("B3CLOUD_REGISTRY_PASSWORD", "")
        github_pat = os.getenv("B3CLOUD_GITHUB_PAT", "")
        if not registry_username or not registry_password:
            raise RuntimeError("Server misconfigured: B3CLOUD_REGISTRY_USERNAME or B3CLOUD_REGISTRY_PASSWORD is not set")

        if shutil.which("pack") is None:
            raise RuntimeError("Server misconfigured: pack CLI is not installed")
        if shutil.which("docker") is None:
            raise RuntimeError("Server misconfigured: docker CLI is not installed")
        if shutil.which("git") is None:
            raise RuntimeError("Server misconfigured: git is not installed")

        with tempfile.TemporaryDirectory(prefix="b3cloud-build-") as tmpdir:
            env = os.environ.copy()
            env["DOCKER_BUILDKIT"] = "1"
            env["PORT"] = str(req.port)
            env["HOME"] = env.get("HOME") or str(Path(tmpdir) / "home")
            env["PACK_HOME"] = str(Path(env["HOME"]) / ".pack")
            env["XDG_CACHE_HOME"] = str(Path(env["HOME"]) / ".cache")
            env["DOCKER_CONFIG"] = str(Path(env["HOME"]) / ".docker")
            Path(env["PACK_HOME"]).mkdir(parents=True, exist_ok=True)
            Path(env["XDG_CACHE_HOME"]).mkdir(parents=True, exist_ok=True)
            Path(env["DOCKER_CONFIG"]).mkdir(parents=True, exist_ok=True)
            self._emit_status(status_callback, f"Logging in to registry {req.registry_repo.split('/')[0]}.")
            self._run_command(
                ["docker", "login", req.registry_repo.split("/")[0], "-u", registry_username, "--password-stdin"],
                env=env,
                input_text=registry_password,
            )
            self._emit_status(status_callback, f"Seeding registry access for {req.app_name} if needed.")
            self._ensure_registry_seed_image(req, env)

            repo_dir = Path(tmpdir) / "src"
            try:
                self._emit_status(status_callback, f"Cloning source repo {req.github_url}.")
                self._run_command(["git", "clone", req.github_url, str(repo_dir)])
            except RuntimeError:
                clone_url = self._github_clone_url(req.github_url, github_pat)
                if clone_url == req.github_url:
                    raise
                self._emit_status(status_callback, "Retrying clone with GitHub token.")
                self._run_command(["git", "clone", clone_url, str(repo_dir)])
            self._run_command(["git", "-C", str(repo_dir), "checkout", req.git_revision])
            app_dir = self._safe_component_path(repo_dir, req.app_path)
            if req.app_path == ".":
                app_dir = self._detect_app_path(repo_dir)
            self._emit_status(status_callback, f"Using app path: {app_dir}.")

            cmd = [
                "pack",
                "build",
                output_image,
                "--path",
                str(app_dir),
                "--builder",
                self.PACK_BUILDER_IMAGE,
                "--publish",
                "--verbose",
            ]
            inferred_build_env = self._infer_build_env(app_dir)
            for key, value in inferred_build_env.items():
                env[key] = value
                cmd.extend(["--env", f"{key}={value}"])
            for key, value in req.env.items():
                env[key] = value
                cmd.extend(["--env", f"{key}={value}"])
            cmd.extend(["--env", f"PORT={req.port}"])
            self._emit_status(status_callback, f"Running Buildpacks publish to {output_image}.")
            self._run_command(cmd, env=env, stream_callback=status_callback)
            self._emit_status(status_callback, f"Image published: {output_image}.")

        return output_image

    def _ensure_registry_seed_image(self, req: DeploymentRequest, env: Dict[str, str]) -> None:
        registry_host = req.registry_repo.split("/")[0]
        target_repo = f"{req.registry_repo}/{req.app_name}"
        bootstrap_tag = f"{target_repo}:bootstrap"

        if registry_host != "ghcr.io":
            return

        try:
            self._run_command(["docker", "manifest", "inspect", bootstrap_tag], env=env)
            return
        except RuntimeError:
            pass

        self._run_command(["docker", "pull", "docker.io/library/alpine:3.20"], env=env)
        self._run_command(["docker", "tag", "docker.io/library/alpine:3.20", bootstrap_tag], env=env)
        self._run_command(["docker", "push", bootstrap_tag], env=env)
        self._run_command(["docker", "rmi", bootstrap_tag], env=env)

    def _create_or_update_deployment(
        self,
        req: DeploymentRequest,
        image: str,
        generated_env: Optional[Dict[str, client.V1EnvVar]] = None,
    ) -> None:
        labels = {"app": req.app_name}
        env = [client.V1EnvVar(name="PORT", value=str(req.port))]
        reserved_env_names = self.PLATFORM_MANAGED_ENV_NAMES.union((generated_env or {}).keys())
        env.extend(client.V1EnvVar(name=k, value=v) for k, v in req.env.items() if k not in reserved_env_names)
        env.extend((generated_env or {}).values())

        container = client.V1Container(
            name=req.app_name,
            image=image,
            ports=[client.V1ContainerPort(container_port=req.port)],
            env=env,
            resources=client.V1ResourceRequirements(
                requests={
                    "cpu": req.resources.cpu_request,
                    "memory": req.resources.memory_request,
                },
                limits={
                    "cpu": req.resources.cpu_limit,
                    "memory": req.resources.memory_limit,
                },
            ),
        )

        node_selector = {}
        node_selector["kubernetes.io/arch"] = req.node_arch if req.node_arch in {"amd64", "arm64"} else "amd64"

        template = client.V1PodTemplateSpec(
            metadata=client.V1ObjectMeta(labels=labels),
            spec=client.V1PodSpec(
                containers=[container],
                image_pull_secrets=[client.V1LocalObjectReference(name=self.REGISTRY_SECRET_NAME)],
                node_selector=node_selector,
            ),
        )

        body = client.V1Deployment(
            metadata=client.V1ObjectMeta(name=req.app_name, namespace=req.namespace),
            spec=client.V1DeploymentSpec(
                replicas=1,
                selector=client.V1LabelSelector(match_labels=labels),
                template=template,
            ),
        )

        try:
            self.apps.read_namespaced_deployment(req.app_name, req.namespace)
            self.apps.patch_namespaced_deployment(req.app_name, req.namespace, body)
        except ApiException as exc:
            if exc.status == 404:
                self.apps.create_namespaced_deployment(req.namespace, body)
            else:
                raise

    def _provision_backing_services(
        self,
        namespace: str,
        app_name: str,
        requirements: list[ServiceRequirement],
    ) -> Dict[str, client.V1EnvVar]:
        env: Dict[str, client.V1EnvVar] = {}
        service_types = sorted({req.type for req in requirements})
        database_types = {"postgres", "mysql", "mongodb"}.intersection(service_types)
        include_database_url = len(database_types) == 1
        for service_type in service_types:
            if service_type == "postgres":
                env.update(self._ensure_postgres(namespace, app_name, include_database_url))
            elif service_type == "mysql":
                env.update(self._ensure_mysql(namespace, app_name, include_database_url))
            elif service_type == "mongodb":
                env.update(self._ensure_mongodb(namespace, app_name, include_database_url))
            elif service_type == "redis":
                env.update(self._ensure_redis(namespace, app_name))
            elif service_type == "rabbitmq":
                env.update(self._ensure_rabbitmq(namespace, app_name))
        return env

    def _ensure_postgres(self, namespace: str, app_name: str, include_database_url: bool) -> Dict[str, client.V1EnvVar]:
        name = f"{app_name}-postgres"
        secret_name = f"{name}-credentials"
        user = "app"
        database = sanitize_name(app_name).replace("-", "_")
        password = self._ensure_generated_secret(namespace, secret_name, {"username": user, "password": None, "database": database})
        host = f"{name}.{namespace}.svc.cluster.local"
        url = f"postgresql://{user}:{password['password']}@{host}:5432/{database}"
        self._upsert_cluster_ip_service(namespace, name, {"app": name}, [{"name": "postgres", "port": 5432, "target_port": 5432}])
        container = client.V1Container(
            name="postgres",
            image="postgres:16-alpine",
            ports=[client.V1ContainerPort(container_port=5432)],
            env=[
                self._secret_env("POSTGRES_USER", secret_name, "username"),
                self._secret_env("POSTGRES_PASSWORD", secret_name, "password"),
                self._secret_env("POSTGRES_DB", secret_name, "database"),
            ],
            volume_mounts=[client.V1VolumeMount(name="data", mount_path="/var/lib/postgresql/data")],
            resources=client.V1ResourceRequirements(
                requests={"cpu": "100m", "memory": "256Mi"},
                limits={"cpu": "1", "memory": "1Gi"},
            ),
        )
        self._upsert_stateful_set(namespace, name, {"app": name}, container, "data", "5Gi")
        self._ensure_connection_secret(namespace, secret_name, {"DATABASE_URL": url, "POSTGRES_URL": url, "POSTGRES_HOST": host})
        env = {
            "POSTGRES_URL": self._secret_env("POSTGRES_URL", secret_name, "POSTGRES_URL"),
            "POSTGRES_HOST": self._secret_env("POSTGRES_HOST", secret_name, "POSTGRES_HOST"),
        }
        if include_database_url:
            env["DATABASE_URL"] = self._secret_env("DATABASE_URL", secret_name, "DATABASE_URL")
        return env

    def _ensure_mysql(self, namespace: str, app_name: str, include_database_url: bool) -> Dict[str, client.V1EnvVar]:
        name = f"{app_name}-mysql"
        secret_name = f"{name}-credentials"
        user = "app"
        database = sanitize_name(app_name).replace("-", "_")
        secret = self._ensure_generated_secret(namespace, secret_name, {"username": user, "password": None, "root_password": None, "database": database})
        host = f"{name}.{namespace}.svc.cluster.local"
        url = f"mysql://{user}:{secret['password']}@{host}:3306/{database}"
        self._upsert_cluster_ip_service(namespace, name, {"app": name}, [{"name": "mysql", "port": 3306, "target_port": 3306}])
        container = client.V1Container(
            name="mysql",
            image="mysql:8.4",
            ports=[client.V1ContainerPort(container_port=3306)],
            env=[
                self._secret_env("MYSQL_USER", secret_name, "username"),
                self._secret_env("MYSQL_PASSWORD", secret_name, "password"),
                self._secret_env("MYSQL_ROOT_PASSWORD", secret_name, "root_password"),
                self._secret_env("MYSQL_DATABASE", secret_name, "database"),
            ],
            volume_mounts=[client.V1VolumeMount(name="data", mount_path="/var/lib/mysql")],
            resources=client.V1ResourceRequirements(
                requests={"cpu": "100m", "memory": "512Mi"},
                limits={"cpu": "1", "memory": "1Gi"},
            ),
        )
        self._upsert_stateful_set(namespace, name, {"app": name}, container, "data", "5Gi")
        self._ensure_connection_secret(namespace, secret_name, {"DATABASE_URL": url, "MYSQL_URL": url, "MYSQL_HOST": host})
        env = {
            "MYSQL_URL": self._secret_env("MYSQL_URL", secret_name, "MYSQL_URL"),
            "MYSQL_HOST": self._secret_env("MYSQL_HOST", secret_name, "MYSQL_HOST"),
        }
        if include_database_url:
            env["DATABASE_URL"] = self._secret_env("DATABASE_URL", secret_name, "DATABASE_URL")
        return env

    def _ensure_mongodb(self, namespace: str, app_name: str, include_database_url: bool) -> Dict[str, client.V1EnvVar]:
        name = f"{app_name}-mongodb"
        secret_name = f"{name}-credentials"
        user = "app"
        database = sanitize_name(app_name).replace("-", "_")
        secret = self._ensure_generated_secret(namespace, secret_name, {"username": user, "password": None, "root_password": None, "database": database})
        host = f"{name}.{namespace}.svc.cluster.local"
        url = f"mongodb://{user}:{secret['password']}@{host}:27017/{database}?authSource=admin"
        self._upsert_cluster_ip_service(namespace, name, {"app": name}, [{"name": "mongodb", "port": 27017, "target_port": 27017}])
        container = client.V1Container(
            name="mongodb",
            image="mongo:7",
            ports=[client.V1ContainerPort(container_port=27017)],
            env=[
                self._secret_env("MONGO_INITDB_ROOT_USERNAME", secret_name, "username"),
                self._secret_env("MONGO_INITDB_ROOT_PASSWORD", secret_name, "password"),
                self._secret_env("MONGO_INITDB_DATABASE", secret_name, "database"),
            ],
            volume_mounts=[client.V1VolumeMount(name="data", mount_path="/data/db")],
            resources=client.V1ResourceRequirements(
                requests={"cpu": "100m", "memory": "256Mi"},
                limits={"cpu": "1", "memory": "1Gi"},
            ),
        )
        self._upsert_stateful_set(namespace, name, {"app": name}, container, "data", "5Gi")
        self._ensure_connection_secret(namespace, secret_name, {"DATABASE_URL": url, "MONGODB_URI": url, "MONGO_URL": url, "MONGODB_HOST": host})
        env = {
            "MONGODB_URI": self._secret_env("MONGODB_URI", secret_name, "MONGODB_URI"),
            "MONGO_URL": self._secret_env("MONGO_URL", secret_name, "MONGO_URL"),
        }
        if include_database_url:
            env["DATABASE_URL"] = self._secret_env("DATABASE_URL", secret_name, "DATABASE_URL")
        return env

    def _ensure_redis(self, namespace: str, app_name: str) -> Dict[str, client.V1EnvVar]:
        name = f"{app_name}-redis"
        secret_name = f"{name}-credentials"
        secret = self._ensure_generated_secret(namespace, secret_name, {"password": None})
        host = f"{name}.{namespace}.svc.cluster.local"
        url = f"redis://:{secret['password']}@{host}:6379/0"
        self._upsert_cluster_ip_service(namespace, name, {"app": name}, [{"name": "redis", "port": 6379, "target_port": 6379}])
        container = client.V1Container(
            name="redis",
            image="redis:7-alpine",
            command=["sh", "-c", 'redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"'],
            ports=[client.V1ContainerPort(container_port=6379)],
            env=[self._secret_env("REDIS_PASSWORD", secret_name, "password")],
            volume_mounts=[client.V1VolumeMount(name="data", mount_path="/data")],
            resources=client.V1ResourceRequirements(
                requests={"cpu": "50m", "memory": "128Mi"},
                limits={"cpu": "500m", "memory": "512Mi"},
            ),
        )
        self._upsert_stateful_set(namespace, name, {"app": name}, container, "data", "2Gi")
        self._ensure_connection_secret(namespace, secret_name, {"REDIS_URL": url, "REDIS_HOST": host})
        return {
            "REDIS_URL": self._secret_env("REDIS_URL", secret_name, "REDIS_URL"),
            "REDIS_HOST": self._secret_env("REDIS_HOST", secret_name, "REDIS_HOST"),
        }

    def _ensure_rabbitmq(self, namespace: str, app_name: str) -> Dict[str, client.V1EnvVar]:
        name = f"{app_name}-rabbitmq"
        secret_name = f"{name}-credentials"
        user = "app"
        secret = self._ensure_generated_secret(namespace, secret_name, {"username": user, "password": None})
        host = f"{name}.{namespace}.svc.cluster.local"
        url = f"amqp://{user}:{secret['password']}@{host}:5672/"
        self._upsert_cluster_ip_service(namespace, name, {"app": name}, [{"name": "amqp", "port": 5672, "target_port": 5672}])
        container = client.V1Container(
            name="rabbitmq",
            image="rabbitmq:3.13-alpine",
            ports=[client.V1ContainerPort(container_port=5672)],
            env=[
                self._secret_env("RABBITMQ_DEFAULT_USER", secret_name, "username"),
                self._secret_env("RABBITMQ_DEFAULT_PASS", secret_name, "password"),
            ],
            volume_mounts=[client.V1VolumeMount(name="data", mount_path="/var/lib/rabbitmq")],
            resources=client.V1ResourceRequirements(
                requests={"cpu": "100m", "memory": "256Mi"},
                limits={"cpu": "1", "memory": "1Gi"},
            ),
        )
        self._upsert_stateful_set(namespace, name, {"app": name}, container, "data", "3Gi")
        self._ensure_connection_secret(namespace, secret_name, {"RABBITMQ_URL": url, "AMQP_URL": url, "RABBITMQ_HOST": host})
        return {
            "RABBITMQ_URL": self._secret_env("RABBITMQ_URL", secret_name, "RABBITMQ_URL"),
            "AMQP_URL": self._secret_env("AMQP_URL", secret_name, "AMQP_URL"),
        }

    def _ensure_generated_secret(self, namespace: str, name: str, values: Dict[str, Optional[str]]) -> Dict[str, str]:
        existing_values: Dict[str, str] = {}
        try:
            existing = self.core.read_namespaced_secret(name, namespace)
            if existing.data:
                import base64

                for key, raw_value in existing.data.items():
                    existing_values[key] = base64.b64decode(raw_value).decode("utf-8")
        except ApiException as exc:
            if exc.status != 404:
                raise

        merged: Dict[str, str] = {}
        for key, value in values.items():
            merged[key] = existing_values.get(key) or value or secrets.token_urlsafe(24)

        body = client.V1Secret(
            metadata=client.V1ObjectMeta(name=name, namespace=namespace),
            type="Opaque",
            string_data=merged,
        )
        try:
            self.core.read_namespaced_secret(name, namespace)
            self.core.patch_namespaced_secret(name, namespace, body)
        except ApiException as exc:
            if exc.status == 404:
                self.core.create_namespaced_secret(namespace, body)
            else:
                raise
        return merged

    def _ensure_connection_secret(self, namespace: str, name: str, values: Dict[str, str]) -> None:
        current = self._ensure_generated_secret(namespace, name, {})
        current.update(values)
        body = client.V1Secret(
            metadata=client.V1ObjectMeta(name=name, namespace=namespace),
            type="Opaque",
            string_data=current,
        )
        self.core.patch_namespaced_secret(name, namespace, body)

    @staticmethod
    def _secret_env(env_name: str, secret_name: str, key: str) -> client.V1EnvVar:
        return client.V1EnvVar(
            name=env_name,
            value_from=client.V1EnvVarSource(
                secret_key_ref=client.V1SecretKeySelector(name=secret_name, key=key)
            ),
        )

    def _upsert_cluster_ip_service(self, namespace: str, name: str, selector: Dict[str, str], ports: list[Dict[str, object]]) -> None:
        body = client.V1Service(
            metadata=client.V1ObjectMeta(name=name, namespace=namespace),
            spec=client.V1ServiceSpec(
                selector=selector,
                type="ClusterIP",
                ports=[
                    client.V1ServicePort(
                        name=str(port["name"]),
                        port=int(port["port"]),
                        target_port=int(port["target_port"]),
                    )
                    for port in ports
                ],
            ),
        )
        try:
            self.core.read_namespaced_service(name, namespace)
            self.core.patch_namespaced_service(name, namespace, body)
        except ApiException as exc:
            if exc.status == 404:
                self.core.create_namespaced_service(namespace, body)
            else:
                raise

    def _upsert_stateful_set(
        self,
        namespace: str,
        name: str,
        labels: Dict[str, str],
        container: client.V1Container,
        volume_name: str,
        storage_size: str,
    ) -> None:
        body = client.V1StatefulSet(
            metadata=client.V1ObjectMeta(name=name, namespace=namespace),
            spec=client.V1StatefulSetSpec(
                service_name=name,
                replicas=1,
                selector=client.V1LabelSelector(match_labels=labels),
                template=client.V1PodTemplateSpec(
                    metadata=client.V1ObjectMeta(labels=labels),
                    spec=client.V1PodSpec(containers=[container]),
                ),
                volume_claim_templates=[
                    client.V1PersistentVolumeClaim(
                        metadata=client.V1ObjectMeta(name=volume_name),
                        spec=client.V1PersistentVolumeClaimSpec(
                            access_modes=["ReadWriteOnce"],
                            resources=client.V1VolumeResourceRequirements(requests={"storage": storage_size}),
                        ),
                    )
                ],
            ),
        )
        try:
            self.apps.read_namespaced_stateful_set(name, namespace)
            self.apps.patch_namespaced_stateful_set(name, namespace, body)
        except ApiException as exc:
            if exc.status == 404:
                self.apps.create_namespaced_stateful_set(namespace, body)
            else:
                raise

    def _create_or_update_service(self, namespace: str, app_name: str, port: int) -> None:
        body = client.V1Service(
            metadata=client.V1ObjectMeta(name=app_name, namespace=namespace),
            spec=client.V1ServiceSpec(
                selector={"app": app_name},
                ports=[client.V1ServicePort(port=80, target_port=port)],
                type="ClusterIP",
            ),
        )

        try:
            self.core.read_namespaced_service(app_name, namespace)
            self.core.patch_namespaced_service(app_name, namespace, body)
        except ApiException as exc:
            if exc.status == 404:
                self.core.create_namespaced_service(namespace, body)
            else:
                raise

    def _create_or_update_ingress(self, namespace: str, app_name: str, host: str, service_port: int) -> None:
        body = client.V1Ingress(
            metadata=client.V1ObjectMeta(
                name=app_name,
                namespace=namespace,
                annotations={
                    "kubernetes.io/ingress.class": "nginx",
                },
            ),
            spec=client.V1IngressSpec(
                rules=[
                    client.V1IngressRule(
                        host=host,
                        http=client.V1HTTPIngressRuleValue(
                            paths=[
                                client.V1HTTPIngressPath(
                                    path="/",
                                    path_type="Prefix",
                                    backend=client.V1IngressBackend(
                                        service=client.V1IngressServiceBackend(
                                            name=app_name,
                                            port=client.V1ServiceBackendPort(number=80),
                                        )
                                    ),
                                )
                            ]
                        ),
                    )
                ],
            ),
        )

        try:
            self.networking.read_namespaced_ingress(app_name, namespace)
            self.networking.patch_namespaced_ingress(app_name, namespace, body)
        except ApiException as exc:
            if exc.status == 404:
                self.networking.create_namespaced_ingress(namespace, body)
            else:
                raise

    def _apply_core_object(self, namespace: str, plural: str, name: str, manifest: Dict) -> None:
        if plural == "resourcequotas":
            self._upsert_resource_quota(namespace, manifest)
            return
        if plural == "limitranges":
            self._upsert_limit_range(namespace, manifest)
            return
        raise ValueError(f"Unsupported core plural for native apply: {plural}")

    def _ensure_build_namespace_prereqs(self, namespace: str) -> None:
        self._sync_secret_from_namespace("kpack", self.REGISTRY_SECRET_NAME, namespace, required=True)
        self._sync_secret_from_namespace("kpack", self.GIT_SOURCE_SECRET_NAME, namespace, required=False)
        self._upsert_service_account(
            namespace,
            self.BUILD_SERVICE_ACCOUNT,
            secret_names=[self.REGISTRY_SECRET_NAME, self.GIT_SOURCE_SECRET_NAME],
            image_pull_secret_names=[self.REGISTRY_SECRET_NAME],
        )

    def _sync_secret_from_namespace(
        self,
        source_namespace: str,
        secret_name: str,
        target_namespace: str,
        required: bool,
    ) -> None:
        try:
            source = self.core.read_namespaced_secret(secret_name, source_namespace)
        except ApiException as exc:
            if exc.status == 404 and not required:
                return
            raise

        body = client.V1Secret(
            metadata=client.V1ObjectMeta(name=secret_name, namespace=target_namespace),
            type=source.type,
            data=deepcopy(source.data),
            string_data=deepcopy(source.string_data) if source.string_data else None,
        )

        try:
            self.core.read_namespaced_secret(secret_name, target_namespace)
            self.core.patch_namespaced_secret(secret_name, target_namespace, body)
        except ApiException as exc:
            if exc.status == 404:
                self.core.create_namespaced_secret(target_namespace, body)
            else:
                raise

    def _upsert_service_account(
        self,
        namespace: str,
        name: str,
        secret_names: Iterable[str],
        image_pull_secret_names: Iterable[str],
    ) -> None:
        existing_secrets = []
        for secret_name in secret_names:
            try:
                self.core.read_namespaced_secret(secret_name, namespace)
                existing_secrets.append(secret_name)
            except ApiException as exc:
                if exc.status != 404:
                    raise

        body = client.V1ServiceAccount(
            metadata=client.V1ObjectMeta(name=name, namespace=namespace),
            secrets=[client.V1ObjectReference(name=secret_name) for secret_name in existing_secrets],
            image_pull_secrets=[
                client.V1LocalObjectReference(name=secret_name) for secret_name in image_pull_secret_names
            ],
        )

        try:
            self.core.read_namespaced_service_account(name, namespace)
            self.core.patch_namespaced_service_account(name, namespace, body)
        except ApiException as exc:
            if exc.status == 404:
                self.core.create_namespaced_service_account(namespace, body)
            else:
                raise

    def _upsert_resource_quota(self, namespace: str, manifest: Dict) -> None:
        body = client.V1ResourceQuota(
            metadata=client.V1ObjectMeta(name=manifest["metadata"]["name"], namespace=namespace),
            spec=client.V1ResourceQuotaSpec(hard=manifest["spec"]["hard"]),
        )
        name = manifest["metadata"]["name"]
        try:
            self.core.read_namespaced_resource_quota(name, namespace)
            self.core.patch_namespaced_resource_quota(name, namespace, body)
        except ApiException as exc:
            if exc.status == 404:
                self.core.create_namespaced_resource_quota(namespace, body)
            else:
                raise

    def _upsert_limit_range(self, namespace: str, manifest: Dict) -> None:
        item = manifest["spec"]["limits"][0]
        body = client.V1LimitRange(
            metadata=client.V1ObjectMeta(name=manifest["metadata"]["name"], namespace=namespace),
            spec=client.V1LimitRangeSpec(
                limits=[
                    client.V1LimitRangeItem(
                        type=item["type"],
                        default=item["default"],
                        default_request=item["defaultRequest"],
                        min=item["min"],
                        max=item["max"],
                    )
                ]
            ),
        )
        name = manifest["metadata"]["name"]
        try:
            self.core.read_namespaced_limit_range(name, namespace)
            self.core.patch_namespaced_limit_range(name, namespace, body)
        except ApiException as exc:
            if exc.status == 404:
                self.core.create_namespaced_limit_range(namespace, body)
            else:
                raise

    @staticmethod
    def _condition_is_true(conditions: Iterable[Dict], condition_type: str) -> bool:
        for c in conditions:
            if c.get("type") == condition_type and c.get("status") == "True":
                return True
        return False

    @staticmethod
    def _first_false_condition_message(conditions: Iterable[Dict], condition_type: Optional[str] = None) -> Optional[str]:
        for condition in conditions:
            if condition_type and condition.get("type") != condition_type:
                continue
            if condition.get("status") == "False":
                return condition.get("message") or condition.get("reason") or "Unknown failure"
        return None

    @staticmethod
    def _short_hash(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]

    @staticmethod
    def _github_clone_url(github_url: str, github_pat: str) -> str:
        if not github_pat or "github.com/" not in github_url:
            return github_url
        return github_url.replace("https://github.com/", f"https://x-access-token:{github_pat}@github.com/")

    @staticmethod
    def _detect_app_path(repo_dir: Path) -> Path:
        markers = ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Gemfile", "composer.json"]

        def score(path: Path) -> tuple[int, int]:
            count = sum(1 for marker in markers if (path / marker).exists())
            depth = len(path.relative_to(repo_dir).parts)
            return (count, -depth)

        candidates = []
        for path in [repo_dir] + [p for p in repo_dir.iterdir() if p.is_dir()]:
            marker_count, depth_score = score(path)
            if marker_count:
                candidates.append((marker_count, depth_score, path))

        if not candidates:
            return repo_dir

        candidates.sort(reverse=True)
        return candidates[0][2]

    @staticmethod
    def _safe_component_path(repo_dir: Path, app_path: str) -> Path:
        requested = app_path.strip() or "."
        path = (repo_dir / requested).resolve()
        repo_root = repo_dir.resolve()
        if path != repo_root and repo_root not in path.parents:
            raise ValueError(f"app_path escapes repository root: {app_path}")
        if not path.exists() or not path.is_dir():
            raise ValueError(f"app_path does not exist or is not a directory: {app_path}")
        return path

    @classmethod
    def _detect_deployable_components(cls, repo_dir: Path) -> list[DeployableComponent]:
        markers = {
            "package.json",
            "pyproject.toml",
            "requirements.txt",
            "go.mod",
            "Gemfile",
            "composer.json",
            "pom.xml",
            "build.gradle",
        }
        ignored_dirs = {".git", "node_modules", "vendor", ".venv", "venv", "__pycache__", "dist", "build", ".next"}
        candidates: list[Path] = []
        for root, dirs, files in os.walk(repo_dir):
            root_path = Path(root)
            rel_parts = root_path.relative_to(repo_dir).parts
            if len(rel_parts) > 3:
                dirs[:] = []
                continue
            dirs[:] = [directory for directory in dirs if directory not in ignored_dirs]
            if markers.intersection(files):
                candidates.append(root_path)

        if not candidates:
            candidates = [repo_dir]

        components: list[DeployableComponent] = []
        for path in sorted(set(candidates), key=lambda item: (len(item.relative_to(repo_dir).parts), str(item))):
            rel = "." if path == repo_dir else str(path.relative_to(repo_dir))
            name = sanitize_name(path.name if rel != "." else "app") or "app"
            component_type, evidence = cls._classify_component(path)
            port, port_confidence, port_evidence = cls._detect_component_port(path, component_type)
            env_requirements = cls._detect_env_requirements(path)
            services = cls._detect_service_requirements(path) if component_type in {"backend", "worker"} else []
            components.append(
                DeployableComponent(
                    name=name,
                    path=rel,
                    type=component_type,
                    public=component_type != "worker",
                    port=port,
                    port_confidence=port_confidence,
                    port_evidence=port_evidence,
                    env=env_requirements,
                    services=services,
                    evidence=evidence,
                )
            )
        return components

    @staticmethod
    def _detect_env_requirements(app_dir: Path) -> list[EnvRequirement]:
        env: Dict[str, EnvRequirement] = {}
        platform_managed_names = {
            "PORT",
            "DATABASE_URL",
            "POSTGRES_URL",
            "POSTGRES_HOST",
            "MYSQL_URL",
            "MYSQL_HOST",
            "MONGODB_URI",
            "MONGO_URL",
            "MONGODB_HOST",
            "REDIS_URL",
            "REDIS_HOST",
            "RABBITMQ_URL",
            "AMQP_URL",
            "RABBITMQ_HOST",
        }
        secret_markers = ("SECRET", "TOKEN", "KEY", "PASSWORD", "PASS", "PRIVATE", "CREDENTIAL", "MONGO", "DATABASE", "REDIS", "RABBIT", "AMQP")

        def upsert(name: str, required: bool, source: str, evidence: str) -> None:
            if not re.fullmatch(r"[A-Z_][A-Z0-9_]{1,80}", name):
                return
            item = env.get(name)
            is_secret = any(marker in name for marker in secret_markers)
            platform_managed = name in platform_managed_names
            if item:
                item.required = item.required or required
                item.secret = item.secret or is_secret
                item.platform_managed = item.platform_managed or platform_managed
                if evidence not in item.evidence:
                    item.evidence.append(evidence)
                return
            env[name] = EnvRequirement(
                name=name,
                required=required,
                source=source,
                evidence=[evidence],
                secret=is_secret,
                platform_managed=platform_managed,
            )

        def read(path: Path, max_bytes: int = 512_000) -> str:
            try:
                return path.read_bytes()[:max_bytes].decode("utf-8", errors="ignore")
            except OSError:
                return ""

        sample_names = {".env.example", ".env.sample", ".env.defaults", "example.env", ".env.template"}
        for filename in sample_names:
            path = app_dir / filename
            if not path.exists():
                continue
            for line in read(path).splitlines():
                match = re.match(r"^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$", line)
                if not match:
                    continue
                name, raw_value = match.group(1), match.group(2).strip().strip("'\"")
                required = raw_value == "" or raw_value.lower() in {"changeme", "change_me", "required", "todo", "your_value", "<required>"}
                upsert(name, required, filename, f"{filename}: {name}={'<empty>' if raw_value == '' else '<provided>'}")

        ignored_dirs = {".git", "node_modules", "vendor", ".venv", "venv", "__pycache__", "dist", "build", ".next"}
        source_suffixes = {".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".php", ".java", ".kt", ".cs", ".yml", ".yaml", ".json"}
        patterns = [
            re.compile(r"process\.env\.([A-Z_][A-Z0-9_]*)"),
            re.compile(r"os\.getenv\(\s*['\"]([A-Z_][A-Z0-9_]*)['\"]\s*(?:,\s*([^)]+))?\)"),
            re.compile(r"os\.environ(?:\.get)?\[\s*['\"]([A-Z_][A-Z0-9_]*)['\"]\s*\]"),
            re.compile(r"ENV\[(['\"])([A-Z_][A-Z0-9_]*)\1\]"),
            re.compile(r"System\.getenv\(\s*['\"]([A-Z_][A-Z0-9_]*)['\"]\s*\)"),
        ]
        for root, dirs, files in os.walk(app_dir):
            dirs[:] = [directory for directory in dirs if directory not in ignored_dirs]
            root_path = Path(root)
            for filename in files:
                path = root_path / filename
                if path.name in {".env", ".npmrc"} or path.suffix.lower() not in source_suffixes:
                    continue
                content = read(path)
                rel = str(path.relative_to(app_dir))
                for pattern in patterns:
                    for match in pattern.finditer(content):
                        name = match.group(2) if pattern.pattern.startswith("ENV") else match.group(1)
                        line_start = content.rfind("\n", 0, match.start()) + 1
                        line_end = content.find("\n", match.end())
                        line = content[line_start : line_end if line_end != -1 else len(content)].strip()
                        has_inline_default = bool(re.search(rf"{re.escape(match.group(0))}\s*(?:\|\||\?\?)", line))
                        required = not has_inline_default and ("getenv" not in match.group(0) or ", " not in match.group(0))
                        upsert(name, required, rel, f"{rel}: {line[:160]}")

        ordered = sorted(
            env.values(),
            key=lambda item: (item.platform_managed, not item.required, item.name),
        )
        for item in ordered:
            item.evidence = item.evidence[:6]
        return ordered

    @staticmethod
    def _detect_component_port(app_dir: Path, component_type: str) -> tuple[int, str, list[str]]:
        evidence: list[str] = []

        def valid_port(value: int) -> bool:
            return 1 <= value <= 65535

        def read(path: Path, max_bytes: int = 512_000) -> str:
            try:
                return path.read_bytes()[:max_bytes].decode("utf-8", errors="ignore")
            except OSError:
                return ""

        env_candidates = [".env.example", ".env.sample", ".env.defaults", "example.env"]
        for filename in env_candidates:
            path = app_dir / filename
            if not path.exists():
                continue
            content = read(path)
            match = re.search(r"(?m)^\s*(?:PORT|SERVER_PORT|APP_PORT|VITE_PORT)\s*=\s*['\"]?(\d{2,5})", content)
            if match:
                port = int(match.group(1))
                if valid_port(port):
                    return port, "high", [f"{filename}: {match.group(0).strip()}"]

        dockerfile = app_dir / "Dockerfile"
        if dockerfile.exists():
            content = read(dockerfile)
            match = re.search(r"(?im)^\s*EXPOSE\s+(\d{2,5})\b", content)
            if match:
                port = int(match.group(1))
                if valid_port(port):
                    return port, "high", [f"Dockerfile: EXPOSE {port}"]

        package_json = app_dir / "package.json"
        if package_json.exists():
            try:
                package_data = json.loads(package_json.read_text())
            except (OSError, json.JSONDecodeError):
                package_data = {}
            scripts = package_data.get("scripts", {}) if isinstance(package_data, dict) else {}
            if isinstance(scripts, dict):
                for name, script in scripts.items():
                    if not isinstance(script, str):
                        continue
                    match = re.search(r"(?:--port|--host\s+\S+\s+--port|-p)\s+(\d{2,5})\b", script)
                    if not match:
                        match = re.search(r"\bPORT\s*=\s*(\d{2,5})\b", script)
                    if match:
                        port = int(match.group(1))
                        if valid_port(port):
                            return port, "medium", [f"package.json script '{name}': {script}"]

        ignored_dirs = {".git", "node_modules", "vendor", ".venv", "venv", "__pycache__", "dist", "build", ".next"}
        source_suffixes = {".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".php", ".java", ".kt", ".cs"}
        source_files: list[Path] = []
        for root, dirs, files in os.walk(app_dir):
            dirs[:] = [directory for directory in dirs if directory not in ignored_dirs]
            root_path = Path(root)
            for filename in files:
                path = root_path / filename
                if path.suffix.lower() in source_suffixes:
                    source_files.append(path)

        source_files.sort(key=lambda path: (0 if path.name.lower() in {"server.ts", "server.js", "index.ts", "index.js", "main.ts", "main.js", "app.ts", "app.js"} else 1, len(path.parts), str(path)))
        patterns = [
            re.compile(r"\b(?:app|server|httpServer|httpsServer)\.listen\s*\(\s*(?:process\.env\.PORT\s*(?:\|\||\?\?)\s*)?(\d{2,5})", re.IGNORECASE),
            re.compile(r"\blisten\s*\(\s*(?:process\.env\.PORT\s*(?:\|\||\?\?)\s*)?(\d{2,5})", re.IGNORECASE),
            re.compile(r"\bPORT\s*=\s*(?:process\.env\.PORT\s*(?:\|\||\?\?)\s*)?(\d{2,5})", re.IGNORECASE),
            re.compile(r"\bport\s*[:=]\s*(?:process\.env\.PORT\s*(?:\|\||\?\?)\s*)?(\d{2,5})", re.IGNORECASE),
            re.compile(r"\b(?:uvicorn|gunicorn).*:(\d{2,5})\b", re.IGNORECASE),
        ]
        for path in source_files[:250]:
            content = read(path)
            for pattern in patterns:
                match = pattern.search(content)
                if match:
                    port = int(match.group(1))
                    if valid_port(port):
                        rel = str(path.relative_to(app_dir))
                        return port, "medium", [f"{rel}: {match.group(0)[:120]}"]

        if component_type == "frontend":
            evidence.append("No explicit port found; static Buildpacks web server default is 8080.")
        else:
            evidence.append("No explicit port found; platform default is 8080.")
        return 8080, "default", evidence

    @staticmethod
    def _classify_component(app_dir: Path) -> tuple[str, list[str]]:
        evidence: list[str] = []
        package_json = app_dir / "package.json"
        dependencies: Dict[str, str] = {}
        scripts: Dict[str, str] = {}
        if package_json.exists():
            try:
                package_data = json.loads(package_json.read_text())
                dependencies = {
                    **package_data.get("dependencies", {}),
                    **package_data.get("devDependencies", {}),
                    **package_data.get("optionalDependencies", {}),
                }
                scripts = package_data.get("scripts", {})
            except (OSError, json.JSONDecodeError):
                pass

        frontend_deps = {"vite", "@vitejs/plugin-react", "react", "react-dom", "next", "nuxt", "vue", "@angular/core"}
        backend_deps = {"express", "fastify", "koa", "hapi", "nestjs", "@nestjs/core", "pg", "mysql2", "mongoose", "redis", "ioredis", "amqplib"}
        if frontend_deps.intersection(dependencies) and not backend_deps.intersection(dependencies):
            evidence.append("frontend JavaScript dependencies")
            return "frontend", evidence
        if backend_deps.intersection(dependencies):
            evidence.append("backend JavaScript dependencies")
            return "backend", evidence
        if (app_dir / "requirements.txt").exists() or (app_dir / "pyproject.toml").exists():
            text = ((app_dir / "requirements.txt").read_text(errors="ignore") if (app_dir / "requirements.txt").exists() else "").lower()
            text += ((app_dir / "pyproject.toml").read_text(errors="ignore") if (app_dir / "pyproject.toml").exists() else "").lower()
            if any(marker in text for marker in ("fastapi", "flask", "django", "uvicorn", "gunicorn")):
                evidence.append("Python web framework")
                return "backend", evidence
            evidence.append("Python project")
            return "worker", evidence
        if (app_dir / "go.mod").exists():
            evidence.append("Go module")
            return "backend", evidence
        if (app_dir / "pom.xml").exists() or (app_dir / "build.gradle").exists():
            evidence.append("Java project")
            return "backend", evidence
        if isinstance(scripts.get("start"), str):
            evidence.append("package.json start script")
            return "backend", evidence
        evidence.append("deployable project marker")
        return "backend", evidence

    @staticmethod
    def _infer_build_env(app_dir: Path) -> Dict[str, str]:
        package_json = app_dir / "package.json"
        if not package_json.exists():
            return {}

        try:
            package_data = json.loads(package_json.read_text())
        except (OSError, json.JSONDecodeError):
            return {}

        scripts = package_data.get("scripts", {})
        dependencies = package_data.get("dependencies", {})
        dev_dependencies = package_data.get("devDependencies", {})
        has_build = isinstance(scripts.get("build"), str) and scripts["build"].strip() != ""
        has_start = isinstance(scripts.get("start"), str) and scripts["start"].strip() != ""
        combined_dependencies = {**dependencies, **dev_dependencies}
        is_frontend = any(dep in combined_dependencies for dep in ("vite", "@vitejs/plugin-react", "react", "react-dom"))
        if has_build and not has_start and is_frontend:
            return {
                "BP_NODE_RUN_SCRIPTS": "build",
                "BP_WEB_SERVER": "nginx",
                "BP_WEB_SERVER_ROOT": "dist",
                "BP_WEB_SERVER_ENABLE_PUSH_STATE": "true",
            }
        return {}

    @staticmethod
    def _detect_service_requirements(app_dir: Path) -> list[ServiceRequirement]:
        evidence: Dict[str, list[str]] = {
            "postgres": [],
            "mysql": [],
            "mongodb": [],
            "redis": [],
            "rabbitmq": [],
        }

        def add(service: str, reason: str) -> None:
            evidence.setdefault(service, []).append(reason)

        def read_text(path: Path, max_bytes: int = 1_000_000) -> str:
            try:
                return path.read_bytes()[:max_bytes].decode("utf-8", errors="ignore")
            except OSError:
                return ""

        package_json = app_dir / "package.json"
        if package_json.exists():
            try:
                package_data = json.loads(package_json.read_text())
                dependencies = {
                    **package_data.get("dependencies", {}),
                    **package_data.get("devDependencies", {}),
                    **package_data.get("optionalDependencies", {}),
                }
                dependency_map = {
                    "postgres": {"pg", "postgres", "postgresql", "prisma", "@prisma/client", "typeorm", "sequelize"},
                    "mysql": {"mysql", "mysql2", "mariadb", "sequelize", "typeorm"},
                    "mongodb": {"mongodb", "mongoose"},
                    "redis": {"redis", "ioredis", "@redis/client", "bull", "bullmq"},
                    "rabbitmq": {"amqplib", "rascal"},
                }
                for service, names in dependency_map.items():
                    matches = sorted(names.intersection(dependencies.keys()))
                    if matches:
                        add(service, f"package.json dependencies: {', '.join(matches)}")
            except (OSError, json.JSONDecodeError):
                pass

        text_files = [
            "requirements.txt",
            "pyproject.toml",
            "Pipfile",
            "poetry.lock",
            "go.mod",
            "pom.xml",
            "build.gradle",
            "Gemfile",
            "composer.json",
            "docker-compose.yml",
            "compose.yml",
            ".env.example",
            ".env.sample",
            "README.md",
        ]
        combined = "\n".join(read_text(app_dir / name) for name in text_files if (app_dir / name).exists()).lower()
        keyword_map = {
            "postgres": ["postgres", "postgresql", "psycopg", "asyncpg", "jdbc:postgresql", "provider = \"postgresql\""],
            "mysql": ["mysql", "mariadb", "pymysql", "mysqlclient", "jdbc:mysql"],
            "mongodb": ["mongodb", "mongoose", "mongo_uri", "mongodb_uri"],
            "redis": ["redis", "redis_url", "ioredis", "bullmq"],
            "rabbitmq": ["rabbitmq", "amqp://", "amqplib", "celery_broker_url"],
        }
        for service, keywords in keyword_map.items():
            hits = [keyword for keyword in keywords if keyword in combined]
            if hits:
                add(service, f"config/dependency keywords: {', '.join(sorted(set(hits))[:6])}")

        ignored_dirs = {".git", "node_modules", "vendor", ".venv", "venv", "__pycache__", "dist", "build", ".next"}
        ignored_files = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Gemfile.lock", "go.sum"}
        for root, dirs, files in os.walk(app_dir):
            dirs[:] = [directory for directory in dirs if directory not in ignored_dirs]
            root_path = Path(root)
            for filename in files:
                if filename in ignored_files:
                    continue
                path = root_path / filename
                try:
                    if path.stat().st_size > 512_000:
                        continue
                except OSError:
                    continue
                if path.name in {".env", ".npmrc"}:
                    continue
                if path.suffix.lower() not in {".js", ".ts", ".jsx", ".tsx", ".py", ".go", ".rb", ".php", ".java", ".kt", ".cs", ".yml", ".yaml", ".toml", ".json"}:
                    continue
                content = read_text(path, max_bytes=512_000).lower()
                rel = str(path.relative_to(app_dir))
                for service, keywords in keyword_map.items():
                    hits = [keyword for keyword in keywords if keyword in content]
                    if hits:
                        add(service, f"{rel}: {', '.join(sorted(set(hits))[:4])}")

        requirements: list[ServiceRequirement] = []
        for service, reasons in evidence.items():
            unique_reasons = list(dict.fromkeys(reasons))[:8]
            if not unique_reasons:
                continue
            confidence = "high" if len(unique_reasons) >= 2 else "medium"
            requirements.append(ServiceRequirement(type=service, confidence=confidence, evidence=unique_reasons))
        return requirements

    @staticmethod
    def _emit_status(status_callback: Optional[Callable[[str], None]], message: str) -> None:
        if status_callback:
            status_callback(message)

    @staticmethod
    def _run_command(
        cmd: list[str],
        env: Optional[Dict[str, str]] = None,
        input_text: Optional[str] = None,
        stream_callback: Optional[Callable[[str], None]] = None,
    ) -> str:
        if stream_callback:
            process = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE if input_text is not None else None,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env=env,
                bufsize=1,
            )
            output_chunks: list[str] = []
            assert process.stdout is not None
            if input_text is not None and process.stdin is not None:
                process.stdin.write(input_text)
                process.stdin.close()
            for raw_line in process.stdout:
                line = raw_line.rstrip()
                output_chunks.append(raw_line)
                if line:
                    stream_callback(line)
            return_code = process.wait()
            output = "".join(output_chunks).strip()
            if return_code != 0:
                raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{output or f'exit code {return_code}'}")
            return output
        try:
            result = subprocess.run(
                cmd,
                input=input_text,
                text=True,
                env=env,
                check=True,
                capture_output=True,
            )
            return result.stdout
        except subprocess.CalledProcessError as exc:
            stderr = exc.stderr.strip()
            stdout = exc.stdout.strip()
            detail_parts = [part for part in (stderr, stdout) if part]
            detail = "\n".join(detail_parts) if detail_parts else str(exc)
            raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{detail}") from exc


class CloudflareAutomation:
    base_url = "https://api.cloudflare.com/client/v4"

    def ensure_dns_and_tunnel_route(self, cfg: CloudflareConfig, hostname: str, service: Optional[str] = None) -> None:
        cname_target = cfg.tunnel_cname_target or f"{cfg.tunnel_id}.cfargotunnel.com"
        zone_id = self._resolve_zone_id(cfg, hostname)
        self._upsert_cname_record(cfg, zone_id, hostname, cname_target)
        self._upsert_tunnel_ingress_rule(cfg, hostname, service or cfg.tunnel_origin_service)

    def _upsert_cname_record(self, cfg: CloudflareConfig, zone_id: str, hostname: str, target: str) -> None:
        existing = self._find_dns_record(cfg, zone_id, hostname, "CNAME")
        payload = {"type": "CNAME", "name": hostname, "content": target, "proxied": True, "ttl": 1}
        if existing:
            record_id = existing["id"]
            self._api_call(cfg.api_token, "PUT", f"/zones/{zone_id}/dns_records/{record_id}", payload)
            return
        self._api_call(cfg.api_token, "POST", f"/zones/{zone_id}/dns_records", payload)

    def _find_dns_record(self, cfg: CloudflareConfig, zone_id: str, hostname: str, record_type: str) -> Optional[Dict]:
        result = self._api_call(
            cfg.api_token,
            "GET",
            f"/zones/{zone_id}/dns_records?type={record_type}&name={hostname}",
        )
        records = result.get("result", [])
        return records[0] if records else None

    def _resolve_zone_id(self, cfg: CloudflareConfig, hostname: str) -> str:
        if cfg.default_zone_id:
            return cfg.default_zone_id

        labels = hostname.split(".")
        if len(labels) < 2:
            raise ValueError(f"Cannot resolve zone for invalid hostname: {hostname}")

        # Try most specific to least specific suffix: a.b.c.com -> b.c.com, c.com
        for i in range(1, len(labels) - 1):
            candidate = ".".join(labels[i:])
            result = self._api_call(
                cfg.api_token,
                "GET",
                f"/zones?name={candidate}&account.id={cfg.account_id}&status=active",
            )
            zones = result.get("result", [])
            if zones:
                return zones[0]["id"]

        raise RuntimeError(
            f"No active Cloudflare zone found for hostname {hostname}. "
            "Ensure the client's domain is added to this Cloudflare account."
        )

    def _upsert_tunnel_ingress_rule(self, cfg: CloudflareConfig, hostname: str, service: str) -> None:
        path = f"/accounts/{cfg.account_id}/cfd_tunnel/{cfg.tunnel_id}/configurations"
        current = self._api_call(cfg.api_token, "GET", path).get("result", {})
        config_obj = current.get("config", {})
        ingress = config_obj.get("ingress", [])

        filtered = [
            r
            for r in ingress
            if not (
                isinstance(r, dict)
                and (
                    r.get("service") == "http_status:404"
                    or r.get("hostname") == hostname
                )
            )
        ]
        filtered.append({"hostname": hostname, "service": service})
        filtered.append({"service": "http_status:404"})

        payload = {"config": {"ingress": filtered}}
        self._api_call(cfg.api_token, "PUT", path, payload)

    def _api_call(self, api_token: str, method: str, path: str, payload: Optional[Dict] = None) -> Dict:
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")

        req = request.Request(
            f"{self.base_url}{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {api_token}",
                "Content-Type": "application/json",
            },
        )

        try:
            with request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                data = json.loads(raw) if raw else {}
        except error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")
            raise RuntimeError(f"Cloudflare API error {exc.code} on {path}: {detail}") from exc

        if not data.get("success", False):
            raise RuntimeError(f"Cloudflare API call failed for {path}: {data.get('errors')}")
        return data


def sanitize_name(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9-]", "-", value.lower()).strip("-")
    return normalized[:50] if len(normalized) > 50 else normalized


if __name__ == "__main__":
    # Example invocation.
    core = PlatformCore(kubeconfig="./kubeconfig")
    request = DeploymentRequest(
        github_url="https://github.com/example/my-app.git",
        env={"NODE_ENV": "production", "PORT": "8080"},
        resources=ResourceLimits(
            cpu_request="100m",
            cpu_limit="500m",
            memory_request="128Mi",
            memory_limit="512Mi",
        ),
        namespace="tenant-demo",
        app_name=sanitize_name("my-app"),
        target_host="my-app.apps.example.com",  # required
        registry_repo="registry.example.com/platform/apps",
        git_revision="main",
        node_arch="amd64",
    )

    # Required env vars:
    # CF_API_TOKEN, CF_ACCOUNT_ID, CF_TUNNEL_ID
    # Optional:
    # CF_ZONE_ID (if omitted, zone is resolved dynamically from target_host)
    # CF_TUNNEL_CNAME_TARGET, CF_TUNNEL_ORIGIN_SERVICE
    result = core.new_deployment(request)
    print(result)
