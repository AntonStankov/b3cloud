#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TFVARS="$ROOT_DIR/terraform.tfvars"
REMOTE_HOST="${1:-178.105.29.217}"
REMOTE_USER="${REMOTE_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
ADMIN_DOMAIN="${ADMIN_DOMAIN:-admin.zerotrust-docker-home-server-test.download}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
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

HCLOUD_TOKEN="$(tfvar hcloud_token)"
GITHUB_PAT="$(tfvar github_pat)"
REGISTRY_SERVER="$(tfvar registry_server)"
REGISTRY_USERNAME="$(tfvar registry_username)"
REGISTRY_PASSWORD="$(tfvar registry_password)"
CLOUDFLARE_API_TOKEN="$(tfvar cloudflare_api_token)"
CLOUDFLARE_ZONE_ID="$(tfvar cloudflare_zone_id)"
CLOUDFLARE_TUNNEL_ID="$(tfvar cloudflare_tunnel_id)"

tar -C "$ROOT_DIR" -czf "$ARCHIVE" \
  admin_api.py \
  user_api.py \
  platform_core.py \
  infrastructure.tf \
  terraform.tfvars \
  terraform.tfstate \
  terraform.tfstate.backup \
  terraform.tfstate.1777477948.backup \
  kubeconfig \
  README.md \
  templates \
  admin_ui

scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$ARCHIVE" "$REMOTE_USER@$REMOTE_HOST:/root/b3cloud-admin-ui.tgz"

ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$REMOTE_USER@$REMOTE_HOST" \
  ADMIN_DOMAIN="$ADMIN_DOMAIN" \
  ADMIN_TOKEN="$ADMIN_TOKEN" \
  HCLOUD_TOKEN="$HCLOUD_TOKEN" \
  GITHUB_PAT="$GITHUB_PAT" \
  REGISTRY_SERVER="$REGISTRY_SERVER" \
  REGISTRY_USERNAME="$REGISTRY_USERNAME" \
  REGISTRY_PASSWORD="$REGISTRY_PASSWORD" \
  CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" \
  CLOUDFLARE_ZONE_ID="$CLOUDFLARE_ZONE_ID" \
  CLOUDFLARE_TUNNEL_ID="$CLOUDFLARE_TUNNEL_ID" \
  'bash -s' <<'REMOTE'
set -euo pipefail

apt-get update
apt-get install -y python3-pip python3-venv unzip curl debian-keyring debian-archive-keyring apt-transport-https caddy

mkdir -p /opt/b3cloud
tar -xzf /root/b3cloud-admin-ui.tgz -C /opt/b3cloud

python3 -m venv /opt/b3cloud/.venv
/opt/b3cloud/.venv/bin/pip install --upgrade pip
/opt/b3cloud/.venv/bin/pip install fastapi uvicorn kubernetes

if ! command -v terraform >/dev/null 2>&1; then
  cd /tmp
  curl -fsSLo terraform.zip https://releases.hashicorp.com/terraform/1.8.2/terraform_1.8.2_linux_amd64.zip
  unzip -o terraform.zip
  install -m 0755 terraform /usr/local/bin/terraform
fi

cat > /opt/b3cloud/.env.admin <<EOF
B3CLOUD_ADMIN_TOKEN=$ADMIN_TOKEN
B3CLOUD_KUBECONFIG=/opt/b3cloud/kubeconfig
B3CLOUD_TF_DIR=/opt/b3cloud
CF_API_TOKEN=$CLOUDFLARE_API_TOKEN
CF_ACCOUNT_ID=b1d7b99d2bd8ddd695a6e9b4776d0048
CF_TUNNEL_ID=$CLOUDFLARE_TUNNEL_ID
CF_ZONE_ID=$CLOUDFLARE_ZONE_ID
EOF

cat > /etc/systemd/system/b3-admin-api.service <<'EOF'
[Unit]
Description=B3Cloud Admin API
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/b3cloud
EnvironmentFile=/opt/b3cloud/.env.admin
ExecStart=/opt/b3cloud/.venv/bin/uvicorn admin_api:app --host 127.0.0.1 --port 9000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
$ADMIN_DOMAIN {
  redir / /admin 308
  reverse_proxy 127.0.0.1:9000
}
EOF

systemctl daemon-reload
systemctl enable --now b3-admin-api
systemctl enable --now caddy
systemctl restart b3-admin-api
systemctl restart caddy
REMOTE

echo "Admin UI deployed."
echo "Admin URL: https://$ADMIN_DOMAIN/admin"
echo "Admin token: $ADMIN_TOKEN"
