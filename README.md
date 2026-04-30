# b3cloud

## Admin API

The admin API manages B3Cloud app lifecycle, cluster inspection, Cloudflare routes, and Terraform actions.

### Install

```bash
pip install fastapi uvicorn kubernetes
```

### Run

```bash
export B3CLOUD_ADMIN_TOKEN='change-me'
export B3CLOUD_KUBECONFIG='./kubeconfig'
export B3CLOUD_TF_DIR='.'
uvicorn admin_api:app --host 0.0.0.0 --port 9000
```

### Admin UI

Once the admin API is running, open:

```text
http://127.0.0.1:9000/admin
```

Or, if you expose the admin API remotely, use the same host on port `9000` with
the `/admin` path.

Paste the `B3CLOUD_ADMIN_TOKEN` into the UI to unlock the API actions.

### Required Cloudflare env vars (for deploy + DNS endpoints)

```bash
export CF_API_TOKEN='...'
export CF_ACCOUNT_ID='...'
export CF_TUNNEL_ID='...'
```

Optional:

```bash
export CF_ZONE_ID='...'
export CF_TUNNEL_CNAME_TARGET='...'
export CF_TUNNEL_ORIGIN_SERVICE='http://ingress-nginx-controller.ingress-nginx.svc.cluster.local:80'
```

### Main endpoints

- `GET /health`
- `GET /cluster/nodes`
- `GET /cluster/pods?namespace=<ns>`
- `POST /deployments`
- `GET /deployments`
- `GET /deployments/{namespace}/{app_name}`
- `POST /deployments/{namespace}/{app_name}/scale`
- `DELETE /deployments/{namespace}/{app_name}`
- `POST /dns/routes`
- `POST /infra/terraform/init`
- `POST /infra/terraform/plan`
- `POST /infra/terraform/apply`
- `POST /infra/reconcile`
- `GET /infra/terraform/output`
- `GET /config`

### Automated infrastructure reconciliation

Use this endpoint to apply the common B3 platform updates and sync the monitoring
hostname in Cloudflare in one step.

Example:

```bash
curl -X POST http://127.0.0.1:9000/infra/reconcile \
  -H 'Content-Type: application/json' \
  -H "X-Admin-Token: $B3CLOUD_ADMIN_TOKEN" \
  -d '{}'
```

By default it:

- runs `terraform apply -target=helm_release.monitoring -target=cloudflare_record.apps_wildcard`
- reads `cluster_domain` and optional `monitoring_subdomain` from `terraform.tfvars`
- ensures the Cloudflare DNS + tunnel route exists for the monitoring hostname

Every endpoint requires header:

```text
X-Admin-Token: <B3CLOUD_ADMIN_TOKEN>
```
