#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${B3_APP_DIR:-/opt/b3cloud}"
PACK_VERSION="${PACK_VERSION:-0.40.2}"
TERRAFORM_VERSION="${TERRAFORM_VERSION:-1.8.2}"

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

require_env ADMIN_DOMAIN
require_env USER_DOMAIN
require_env ADMIN_TOKEN
require_env USER_API_KEY
require_env CLUSTER_DOMAIN
require_env GITHUB_PAT
require_env REGISTRY_SERVER
require_env REGISTRY_USERNAME
require_env REGISTRY_NAMESPACE
require_env REGISTRY_PASSWORD
require_env CLOUDFLARE_API_TOKEN
require_env CLOUDFLARE_ZONE_ID
require_env CLOUDFLARE_TUNNEL_ID
require_env CF_ACCOUNT_ID

if [[ -z "${LEGACY_USER_DOMAIN:-}" ]]; then
  LEGACY_USER_DOMAIN="old-${USER_DOMAIN%%.*}.${USER_DOMAIN#*.}"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y \
  apt-transport-https \
  caddy \
  curl \
  debian-archive-keyring \
  debian-keyring \
  docker.io \
  git \
  python3-pip \
  python3-venv \
  unzip

mkdir -p "$APP_DIR"

python3 -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install --upgrade pip
"$APP_DIR/.venv/bin/pip" install fastapi uvicorn kubernetes

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

curl -fsSLo "$tmpdir/pack.tgz" "https://github.com/buildpacks/pack/releases/download/v${PACK_VERSION}/pack-v${PACK_VERSION}-linux.tgz"
tar -xzf "$tmpdir/pack.tgz" -C "$tmpdir"
install -m 0755 "$tmpdir/pack" /usr/local/bin/pack

if ! command -v terraform >/dev/null 2>&1 || [[ "$(terraform version -json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("terraform_version",""))' 2>/dev/null || true)" != "$TERRAFORM_VERSION" ]]; then
  curl -fsSLo "$tmpdir/terraform.zip" "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip"
  unzip -o "$tmpdir/terraform.zip" -d "$tmpdir"
  install -m 0755 "$tmpdir/terraform" /usr/local/bin/terraform
fi

if [[ -n "${B3CLOUD_KUBECONFIG_B64:-}" ]]; then
  printf '%s' "$B3CLOUD_KUBECONFIG_B64" | base64 -d > "$APP_DIR/kubeconfig"
  chmod 0600 "$APP_DIR/kubeconfig"
fi

cat > "$APP_DIR/.env.admin" <<EOF
B3CLOUD_ADMIN_TOKEN=$ADMIN_TOKEN
B3CLOUD_KUBECONFIG=$APP_DIR/kubeconfig
B3CLOUD_TF_DIR=$APP_DIR
CF_API_TOKEN=$CLOUDFLARE_API_TOKEN
CF_ACCOUNT_ID=$CF_ACCOUNT_ID
CF_TUNNEL_ID=$CLOUDFLARE_TUNNEL_ID
CF_ZONE_ID=$CLOUDFLARE_ZONE_ID
EOF
chmod 0600 "$APP_DIR/.env.admin"

cat > "$APP_DIR/.env.user" <<EOF
B3CLOUD_USER_API_KEY=$USER_API_KEY
B3CLOUD_KUBECONFIG=$APP_DIR/kubeconfig
B3CLOUD_CLUSTER_DOMAIN=$CLUSTER_DOMAIN
B3CLOUD_REGISTRY_SERVER=$REGISTRY_SERVER
B3CLOUD_REGISTRY_USERNAME=$REGISTRY_USERNAME
B3CLOUD_REGISTRY_NAMESPACE=$REGISTRY_NAMESPACE
B3CLOUD_REGISTRY_PASSWORD=$REGISTRY_PASSWORD
B3CLOUD_GITHUB_PAT=$GITHUB_PAT
B3CLOUD_PUBLIC_BASE_URL=https://$USER_DOMAIN
B3CLOUD_GITHUB_WEBHOOK_SECRET=${GITHUB_WEBHOOK_SECRET:-}
CF_API_TOKEN=$CLOUDFLARE_API_TOKEN
CF_ACCOUNT_ID=$CF_ACCOUNT_ID
CF_TUNNEL_ID=$CLOUDFLARE_TUNNEL_ID
CF_ZONE_ID=$CLOUDFLARE_ZONE_ID
B3CLOUD_SUPABASE_URL=${SUPABASE_URL:-}
B3CLOUD_SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY:-}
B3CLOUD_SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY:-}
EOF
chmod 0600 "$APP_DIR/.env.user"

cat > /etc/systemd/system/b3-admin-api.service <<EOF
[Unit]
Description=B3Cloud Admin API
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env.admin
ExecStart=$APP_DIR/.venv/bin/uvicorn admin_api:app --host 127.0.0.1 --port 9000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/b3-user-api.service <<EOF
[Unit]
Description=B3Cloud User API
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env.user
ExecStart=$APP_DIR/.venv/bin/uvicorn user_api:app --host 127.0.0.1 --port 9001
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

$LEGACY_USER_DOMAIN {
  reverse_proxy 127.0.0.1:9001
}

$USER_DOMAIN {
  handle /api/v1* {
    reverse_proxy 127.0.0.1:9001
  }

  handle /apps* {
    reverse_proxy 127.0.0.1:9001
  }

  handle /deploy-jobs* {
    reverse_proxy 127.0.0.1:9001
  }

  handle /health {
    reverse_proxy 127.0.0.1:9001
  }

  handle {
    root * $APP_DIR/Client/dist
    try_files {path} /index.html
    file_server
  }
}
EOF

systemctl daemon-reload
systemctl enable --now docker
systemctl enable --now b3-admin-api
systemctl enable --now b3-user-api
systemctl enable --now caddy
systemctl restart docker
systemctl restart b3-admin-api
systemctl restart b3-user-api
systemctl restart caddy
