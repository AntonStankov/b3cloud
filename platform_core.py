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
import time
from urllib import error, request
from dataclasses import dataclass
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
class DeploymentRequest:
    github_url: str
    env: Dict[str, str]
    resources: ResourceLimits
    namespace: str
    app_name: str
    target_host: str
    registry_repo: str
    git_revision: str = "main"
    port: int = 8080
    node_arch: Optional[str] = None  # "amd64" (CPX) or "arm64" (CAX)


@dataclass
class CloudflareConfig:
    api_token: str
    account_id: str
    tunnel_id: str
    default_zone_id: Optional[str] = None
    tunnel_cname_target: Optional[str] = None
    tunnel_origin_service: str = "http://ingress-nginx-controller.ingress-nginx.svc.cluster.local:80"


class PlatformCore:
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

    def new_deployment(self, req: DeploymentRequest) -> Dict[str, str]:
        self._validate_deployment_request(req)
        self._ensure_namespace(req.namespace)
        self._apply_namespace_guardrails(req.namespace)

        kpack_image_name = f"{req.app_name}-image"
        output_image = f"{req.registry_repo}/{req.app_name}:{self._short_hash(req.github_url + req.git_revision)}"

        self._create_or_update_kpack_image(
            namespace=req.namespace,
            image_name=kpack_image_name,
            github_url=req.github_url,
            git_revision=req.git_revision,
            output_image=output_image,
        )

        ready_image = self._wait_for_kpack_image_ready(req.namespace, kpack_image_name, timeout_seconds=1800)

        self._create_or_update_deployment(req, ready_image)
        self._create_or_update_service(req.namespace, req.app_name, req.port)
        self._create_or_update_ingress(req.namespace, req.app_name, req.target_host, req.port)
        self.cloudflare.ensure_dns_and_tunnel_route(self.cloudflare_config, req.target_host)

        return {
            "namespace": req.namespace,
            "app_name": req.app_name,
            "image": ready_image,
            "url": f"https://{req.target_host}",
            "status": "deployed",
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
                "serviceAccountName": "kpack-builder-sa",
                "builder": {
                    "kind": "Builder",
                    "name": "platform-builder",
                    "namespace": "kpack",
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
            time.sleep(5)

        raise TimeoutError(f"Timed out waiting for kpack Image/{image_name} to become ready")

    def _create_or_update_deployment(self, req: DeploymentRequest, image: str) -> None:
        labels = {"app": req.app_name}
        env = [client.V1EnvVar(name=k, value=v) for k, v in req.env.items()]

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
        if req.node_arch in {"amd64", "arm64"}:
            node_selector["kubernetes.io/arch"] = req.node_arch

        template = client.V1PodTemplateSpec(
            metadata=client.V1ObjectMeta(labels=labels),
            spec=client.V1PodSpec(containers=[container], node_selector=node_selector or None),
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
        try:
            self.custom.get_namespaced_custom_object("", "v1", namespace, plural, name)
            self.custom.patch_namespaced_custom_object("", "v1", namespace, plural, name, manifest)
        except ApiException as exc:
            if exc.status == 404:
                self.custom.create_namespaced_custom_object("", "v1", namespace, plural, manifest)
            else:
                # Fallback to native core API methods when CustomObjects API is unsupported for core resources.
                if plural == "resourcequotas":
                    self._upsert_resource_quota(namespace, manifest)
                elif plural == "limitranges":
                    self._upsert_limit_range(namespace, manifest)
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
    def _short_hash(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


class CloudflareAutomation:
    base_url = "https://api.cloudflare.com/client/v4"

    def ensure_dns_and_tunnel_route(self, cfg: CloudflareConfig, hostname: str) -> None:
        cname_target = cfg.tunnel_cname_target or f"{cfg.tunnel_id}.cfargotunnel.com"
        zone_id = self._resolve_zone_id(cfg, hostname)
        self._upsert_cname_record(cfg, zone_id, hostname, cname_target)
        self._upsert_tunnel_ingress_rule(cfg, hostname)

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

    def _upsert_tunnel_ingress_rule(self, cfg: CloudflareConfig, hostname: str) -> None:
        path = f"/accounts/{cfg.account_id}/cfd_tunnel/{cfg.tunnel_id}/configurations"
        current = self._api_call(cfg.api_token, "GET", path).get("result", {})
        config_obj = current.get("config", {})
        ingress = config_obj.get("ingress", [])

        if any(isinstance(rule, dict) and rule.get("hostname") == hostname for rule in ingress):
            return

        filtered = [r for r in ingress if not (isinstance(r, dict) and r.get("service") == "http_status:404")]
        filtered.append({"hostname": hostname, "service": cfg.tunnel_origin_service})
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
