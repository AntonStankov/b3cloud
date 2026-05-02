#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from urllib import request


def env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


api_token = env("CLOUDFLARE_API_TOKEN")
zone_id = env("CLOUDFLARE_ZONE_ID")
tunnel_id = env("CLOUDFLARE_TUNNEL_ID")
account_id = env("CF_ACCOUNT_ID")
admin_domain = env("ADMIN_DOMAIN")
user_domain = env("USER_DOMAIN")
monitoring_domain = env("MONITORING_DOMAIN")
admin_origin = env("ADMIN_ORIGIN")
user_origin = env("USER_ORIGIN")
monitoring_origin = os.environ.get(
    "MONITORING_ORIGIN",
    "http://ingress-nginx-controller.ingress-nginx.svc.cluster.local:80",
)
tunnel_target = f"{tunnel_id}.cfargotunnel.com"


def call(method: str, path: str, payload: dict | None = None) -> dict:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"https://api.cloudflare.com/client/v4{path}",
        data=body,
        method=method,
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        },
    )
    with request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8")
    data = json.loads(raw) if raw else {}
    if not data.get("success", False):
        raise RuntimeError(f"Cloudflare API call failed for {path}: {data.get('errors')}")
    return data


def records_by_name(hostname: str) -> list[dict]:
    return call("GET", f"/zones/{zone_id}/dns_records?name={hostname}").get("result", [])


def upsert_cname(hostname: str) -> None:
    existing = None
    for record in records_by_name(hostname):
        if record["type"] in {"A", "AAAA"}:
            call("DELETE", f"/zones/{zone_id}/dns_records/{record['id']}")
        elif record["type"] == "CNAME":
            existing = record

    payload = {
        "type": "CNAME",
        "name": hostname,
        "content": tunnel_target,
        "proxied": True,
        "ttl": 1,
    }
    if existing:
        call("PUT", f"/zones/{zone_id}/dns_records/{existing['id']}", payload)
    else:
        call("POST", f"/zones/{zone_id}/dns_records", payload)


for hostname in (admin_domain, user_domain, monitoring_domain):
    upsert_cname(hostname)

config = call("GET", f"/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations").get("result", {})
ingress = ((config.get("config") or {}).get("ingress")) or []
managed_hostnames = {admin_domain, user_domain, monitoring_domain}
filtered = [
    rule
    for rule in ingress
    if not (
        isinstance(rule, dict)
        and (rule.get("service") == "http_status:404" or rule.get("hostname") in managed_hostnames)
    )
]
filtered.extend(
    [
        {"hostname": admin_domain, "service": admin_origin},
        {"hostname": user_domain, "service": user_origin},
        {"hostname": monitoring_domain, "service": monitoring_origin},
        {"service": "http_status:404"},
    ]
)
call(
    "PUT",
    f"/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations",
    {"config": {"ingress": filtered}},
)

print(f"Synced Cloudflare routes for {admin_domain}, {user_domain}, and {monitoring_domain}.")
