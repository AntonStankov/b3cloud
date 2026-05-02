#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TFVARS="$ROOT_DIR/terraform.tfvars"
REMOTE_HOST="${1:-178.105.29.217}"
REMOTE_USER="${REMOTE_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
CF_ACCOUNT_ID="${CF_ACCOUNT_ID:-b1d7b99d2bd8ddd695a6e9b4776d0048}"
ADMIN_DOMAIN="${ADMIN_DOMAIN:-admin.zerotrust-docker-home-server-test.download}"
USER_DOMAIN="${USER_DOMAIN:-api.zerotrust-docker-home-server-test.download}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
USER_API_KEY="${USER_API_KEY:-}"
TMP_DIR="$(mktemp -d)"
ARCHIVE="$TMP_DIR/b3cloud-admin-ui.tgz"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

tfvar() {
  local key="$1"
  python - "$TFVARS" "$key" <<'PY'
import re
import sys
path, key = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as fh:
    content = fh.read()
match = re.search(rf'(?m)^\s*{re.escape(key)}\s*=\s*"([^"]*)"', content)
if not match:
    sys.exit(1)
print(match.group(1))
PY
}

if [[ -z "$ADMIN_TOKEN" ]]; then
  ADMIN_TOKEN="$(openssl rand -hex 24)"
fi

if [[ -z "$USER_API_KEY" ]]; then
  USER_API_KEY="$(openssl rand -hex 24)"
fi

HCLOUD_TOKEN="$(tfvar hcloud_token)"
GITHUB_PAT="$(tfvar github_pat)"
REGISTRY_SERVER="$(tfvar registry_server)"
REGISTRY_USERNAME="$(tfvar registry_username)"
REGISTRY_PASSWORD="$(tfvar registry_password)"
REGISTRY_NAMESPACE="$(printf '%s' "$REGISTRY_USERNAME" | tr '[:upper:]' '[:lower:]')"
CLOUDFLARE_API_TOKEN="$(tfvar cloudflare_api_token)"
CLOUDFLARE_ZONE_ID="$(tfvar cloudflare_zone_id)"
CLOUDFLARE_TUNNEL_ID="$(tfvar cloudflare_tunnel_id)"
CLUSTER_DOMAIN="$(tfvar cluster_domain)"
MONITORING_SUBDOMAIN="$(python - "$TFVARS" <<'PY'
import re
import sys
path = sys.argv[1]
with open(path, "r", encoding="utf-8") as fh:
    content = fh.read()
match = re.search(r'(?m)^\s*monitoring_subdomain\s*=\s*"([^"]*)"', content)
print(match.group(1) if match else "monitoring")
PY
)"
MONITORING_DOMAIN="${MONITORING_SUBDOMAIN}.${CLUSTER_DOMAIN}"

ARCHIVE_PATHS=(
  admin_api.py
  user_api.py
  platform_core.py
  infrastructure.tf
  terraform.tfvars
  kubeconfig
  README.md
  scripts
  templates
  admin_ui
  user_ui
)

for optional_path in terraform.tfstate terraform.tfstate.backup terraform.tfstate.*.backup kpack-configuration.yaml; do
  for resolved_path in "$ROOT_DIR"/$optional_path; do
    if [[ -e "$resolved_path" ]]; then
      ARCHIVE_PATHS+=("${resolved_path#$ROOT_DIR/}")
    fi
  done
done

tar -C "$ROOT_DIR" -czf "$ARCHIVE" "${ARCHIVE_PATHS[@]}"

scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$ARCHIVE" "$REMOTE_USER@$REMOTE_HOST:/root/b3cloud-admin-ui.tgz"

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$REMOTE_USER@$REMOTE_HOST" \
  ADMIN_DOMAIN="$ADMIN_DOMAIN" \
  USER_DOMAIN="$USER_DOMAIN" \
  ADMIN_TOKEN="$ADMIN_TOKEN" \
  USER_API_KEY="$USER_API_KEY" \
  CLUSTER_DOMAIN="$CLUSTER_DOMAIN" \
  HCLOUD_TOKEN="$HCLOUD_TOKEN" \
  GITHUB_PAT="$GITHUB_PAT" \
  REGISTRY_SERVER="$REGISTRY_SERVER" \
  REGISTRY_USERNAME="$REGISTRY_USERNAME" \
  REGISTRY_NAMESPACE="$REGISTRY_NAMESPACE" \
  REGISTRY_PASSWORD="$REGISTRY_PASSWORD" \
  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
  CLOUDFLARE_ZONE_ID="$CLOUDFLARE_ZONE_ID" \
  CLOUDFLARE_TUNNEL_ID="$CLOUDFLARE_TUNNEL_ID" \
  CF_ACCOUNT_ID="$CF_ACCOUNT_ID" \
  'bash -s' <<'REMOTE'
set -euo pipefail

mkdir -p /opt/b3cloud
tar -xzf /root/b3cloud-admin-ui.tgz -C /opt/b3cloud

ADMIN_DOMAIN="$ADMIN_DOMAIN" \
USER_DOMAIN="$USER_DOMAIN" \
ADMIN_TOKEN="$ADMIN_TOKEN" \
USER_API_KEY="$USER_API_KEY" \
CLUSTER_DOMAIN="$CLUSTER_DOMAIN" \
GITHUB_PAT="$GITHUB_PAT" \
REGISTRY_SERVER="$REGISTRY_SERVER" \
REGISTRY_USERNAME="$REGISTRY_USERNAME" \
REGISTRY_NAMESPACE="$REGISTRY_NAMESPACE" \
REGISTRY_PASSWORD="$REGISTRY_PASSWORD" \
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
CLOUDFLARE_ZONE_ID="$CLOUDFLARE_ZONE_ID" \
CLOUDFLARE_TUNNEL_ID="$CLOUDFLARE_TUNNEL_ID" \
CF_ACCOUNT_ID="$CF_ACCOUNT_ID" \
bash /opt/b3cloud/scripts/install_b3_api_runtime.sh
REMOTE

export CLOUDFLARE_API_TOKEN CLOUDFLARE_ZONE_ID CLOUDFLARE_TUNNEL_ID CF_ACCOUNT_ID
export REMOTE_HOST ADMIN_DOMAIN USER_DOMAIN MONITORING_DOMAIN
export ADMIN_ORIGIN="http://${REMOTE_HOST}"
export USER_ORIGIN="http://${REMOTE_HOST}"
python "$ROOT_DIR/scripts/sync_cloudflare_routes.py"

echo "Public UIs deployed."
echo "Admin URL: https://$ADMIN_DOMAIN/admin"
echo "Admin token: $ADMIN_TOKEN"
echo "User URL: https://$USER_DOMAIN/"
echo "User API key: $USER_API_KEY"
echo "Monitoring URL: https://$MONITORING_DOMAIN"
