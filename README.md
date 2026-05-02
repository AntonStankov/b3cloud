# b3cloud

## Admin API

The admin API manages B3Cloud app lifecycle, cluster inspection, Cloudflare routes, and Terraform actions.

## Infrastructure Automation

For a fresh rebuild from this repository, run:

```bash
./scripts/bootstrap_b3_infra.sh
```

That script:

- runs Terraform for the Hetzner servers, network, and API VM
- fetches the K3s kubeconfig from the control plane
- runs the full Terraform platform apply
- deploys the real admin/user APIs and UIs to the API VM
- syncs the public Cloudflare Zero Trust hostnames

The API VM runtime is installed by:

```bash
./scripts/install_b3_api_runtime.sh
```

You normally do not run that directly. It is used by `deploy_admin_ui.sh`, the bootstrap script, and GitHub Actions.

### Main Branch Updates

The workflow at `.github/workflows/deploy-b3-infrastructure.yml` redeploys the B3 API services on every push to `main`.

Required GitHub repository secrets:

- `B3_API_HOST`
- `B3_API_SSH_PRIVATE_KEY`
- `B3_API_SSH_USER` optional, defaults to `root`
- `B3_ADMIN_DOMAIN`
- `B3_USER_DOMAIN`
- `B3_MONITORING_DOMAIN`
- `B3_ADMIN_TOKEN`
- `B3_USER_API_KEY`
- `B3_CLUSTER_DOMAIN`
- `B3_GITHUB_PAT`
- `B3_REGISTRY_SERVER`
- `B3_REGISTRY_USERNAME`
- `B3_REGISTRY_NAMESPACE`
- `B3_REGISTRY_PASSWORD`
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ZONE_ID`
- `CLOUDFLARE_TUNNEL_ID`
- `CLOUDFLARE_ACCOUNT_ID`

Use `api_ssh_domain` from `terraform.tfvars` for `B3_API_HOST`. This hostname must be an unproxied Cloudflare `A` record because GitHub Actions uses it for SSH, not browser traffic.

Deployed tenant applications are intentionally not Terraform resources. They are created by the user API and should be redeployed through the user UI/API after a cluster rebuild.

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
