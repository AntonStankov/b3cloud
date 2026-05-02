#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TFVARS="${TFVARS:-$ROOT_DIR/terraform.tfvars}"
KUBECONFIG_PATH="${KUBECONFIG_PATH:-$ROOT_DIR/kubeconfig}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_rsa}"
SSH_USER="${SSH_USER:-root}"

cd "$ROOT_DIR"

terraform init

# Terraform's Kubernetes and Helm providers need a kubeconfig. On a blank rebuild,
# create the servers first, fetch kubeconfig, then run the full platform apply.
terraform apply \
  -target=hcloud_ssh_key.default \
  -target=hcloud_network.private \
  -target=hcloud_network_subnet.private_subnet \
  -target=hcloud_load_balancer.ingress \
  -target=hcloud_load_balancer_network.ingress_net \
  -target=hcloud_load_balancer_service.http \
  -target=hcloud_load_balancer_service.https \
  -target=hcloud_server.control_plane \
  -target=hcloud_server.worker_pool_cpx \
  -target=hcloud_server.worker_pool_cax \
  -target=hcloud_load_balancer_target.workers_cpx \
  -target=hcloud_load_balancer_target.workers_cax \
  -target=hcloud_ssh_key.admin_api \
  -target=hcloud_server.admin_api \
  -auto-approve

control_plane_ip="$(terraform output -raw control_plane_public_ip)"
api_ip="$(terraform output -raw api_server_public_ip)"

echo "Waiting for K3s kubeconfig on ${control_plane_ip}..."
for _ in {1..60}; do
  if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "$SSH_USER@$control_plane_ip" test -f /etc/rancher/k3s/k3s.yaml; then
    break
  fi
  sleep 5
done

scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "$SSH_USER@$control_plane_ip:/etc/rancher/k3s/k3s.yaml" "$KUBECONFIG_PATH"
sed -i "s/127.0.0.1/${control_plane_ip}/g" "$KUBECONFIG_PATH"
chmod 0600 "$KUBECONFIG_PATH"

terraform apply -auto-approve

"$ROOT_DIR/deploy_admin_ui.sh" "$api_ip"

echo "B3 infrastructure bootstrap complete."
