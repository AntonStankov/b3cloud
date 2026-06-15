terraform {
  required_version = ">= 1.6.0"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.47"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.31"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.14"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

provider "hcloud" {
  alias = "admin_project"
  token = var.hcloud_admin_project_token != "" ? var.hcloud_admin_project_token : var.hcloud_token
}

provider "hcloud" {
  alias = "user_project"
  token = var.hcloud_user_project_token != "" ? var.hcloud_user_project_token : var.hcloud_token
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

variable "hcloud_token" {
  type      = string
  sensitive = true
}

variable "hcloud_admin_project_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Hetzner API token for the admin API project (project-scoped token)."
}

variable "hcloud_user_project_token" {
  type        = string
  sensitive   = true
  default     = ""
  description = "Hetzner API token for the user API project (project-scoped token)."
}

variable "name_prefix" {
  type    = string
  default = "paas"
}

variable "location" {
  type    = string
  default = "fsn1"
}

variable "k3s_version" {
  type    = string
  default = "v1.30.3+k3s1"
}

variable "control_plane_count" {
  type    = number
  default = 1
}

variable "control_plane_server_type" {
  type    = string
  default = "cpx22"
}

variable "worker_cpx_server_type" {
  type    = string
  default = "cpx32"
}

variable "worker_cax_server_type" {
  type    = string
  default = "cax21"
}

variable "cpx_min_nodes" {
  type    = number
  default = 1
}

variable "cpx_max_nodes" {
  type    = number
  default = 20
}

variable "cax_min_nodes" {
  type    = number
  default = 1
}

variable "cax_max_nodes" {
  type    = number
  default = 20
}

variable "ssh_public_key" {
  type        = string
  description = "SSH public key content"
}

variable "github_pat" {
  type      = string
  sensitive = true
}

variable "registry_server" {
  type        = string
  description = "Registry host, e.g. registry.example.com"
}

variable "registry_username" {
  type = string
}

variable "registry_password" {
  type      = string
  sensitive = true
}

variable "cluster_domain" {
  type        = string
  description = "Base wildcard domain routed to the Hetzner LB, e.g. apps.example.com"
}

variable "enable_cert_manager" {
  type        = bool
  description = "Enable cert-manager and ACME ClusterIssuer. Keep false for Zero Trust-only edge TLS."
  default     = false
}

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Optional Cloudflare Zone ID for wildcard bootstrap DNS. Leave empty to skip wildcard record creation."
  default     = ""
}

variable "cloudflare_tunnel_id" {
  type        = string
  description = "Existing Cloudflare Tunnel ID used by cloudflared."
}

variable "cloudflare_tunnel_token" {
  type      = string
  sensitive = true
}

variable "enable_monitoring" {
  type        = bool
  default     = true
  description = "Deploy a simple Prometheus and Grafana monitoring stack."
}

variable "monitoring_subdomain" {
  type        = string
  default     = "monitoring"
  description = "Subdomain used for the Grafana UI under cluster_domain."
}

variable "deploy_separate_api_projects" {
  type        = bool
  default     = false
  description = "Provision dedicated admin/user API VMs in separate Hetzner projects."
}

variable "api_server_type" {
  type    = string
  default = "cpx22"
}

variable "admin_api_domain" {
  type        = string
  default     = ""
  description = "Optional FQDN for admin API (for Cloudflare A record)."
}

variable "user_api_domain" {
  type        = string
  default     = ""
  description = "Optional FQDN for user API (for Cloudflare A record)."
}

variable "api_ssh_domain" {
  type        = string
  default     = ""
  description = "Optional unproxied FQDN used by automation to SSH into the API VM."
}

locals {
  network_cidr      = "10.10.0.0/16"
  subnet_cidr       = "10.10.1.0/24"
  control_plane_ips = ["10.10.1.11", "10.10.1.12", "10.10.1.13"]
  monitoring_host   = "${var.monitoring_subdomain}.${var.cluster_domain}"
}

resource "hcloud_ssh_key" "default" {
  name       = "${var.name_prefix}-ssh"
  public_key = var.ssh_public_key
}

resource "hcloud_network" "private" {
  name     = "${var.name_prefix}-private"
  ip_range = local.network_cidr
}

resource "hcloud_network_subnet" "private_subnet" {
  network_id   = hcloud_network.private.id
  type         = "cloud"
  network_zone = "eu-central"
  ip_range     = local.subnet_cidr
}

resource "hcloud_load_balancer" "ingress" {
  name               = "${var.name_prefix}-ingress"
  load_balancer_type = "lb11"
  location           = var.location
}

resource "hcloud_load_balancer_network" "ingress_net" {
  load_balancer_id = hcloud_load_balancer.ingress.id
  network_id       = hcloud_network.private.id
  ip               = "10.10.1.5"
}

resource "hcloud_load_balancer_service" "http" {
  load_balancer_id = hcloud_load_balancer.ingress.id
  protocol         = "tcp"
  listen_port      = 80
  destination_port = 80
}

resource "hcloud_load_balancer_service" "https" {
  load_balancer_id = hcloud_load_balancer.ingress.id
  protocol         = "tcp"
  listen_port      = 443
  destination_port = 443
}

resource "hcloud_server" "control_plane" {
  count       = var.control_plane_count
  name        = "${var.name_prefix}-cp-${count.index + 1}"
  server_type = var.control_plane_server_type
  image       = "ubuntu-24.04"
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.default.id]

  network {
    network_id = hcloud_network.private.id
    ip         = local.control_plane_ips[count.index]
  }

  user_data = templatefile("${path.module}/templates/k3s-control-plane-cloudinit.tftpl", {
    cluster_init = count.index == 0 ? "true" : "false"
    token        = "replace-with-secure-token"
    server_ip    = local.control_plane_ips[0]
    k3s_version  = var.k3s_version
  })
}

resource "hcloud_server" "worker_pool_cpx" {
  count       = var.cpx_min_nodes
  name        = "${var.name_prefix}-cpx-${count.index + 1}"
  server_type = var.worker_cpx_server_type
  image       = "ubuntu-24.04"
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.default.id]

  network {
    network_id = hcloud_network.private.id
  }

  labels = {
    "nodepool" = "cpx"
    "arch"     = "amd64"
  }

  user_data = templatefile("${path.module}/templates/k3s-worker-cloudinit.tftpl", {
    token       = "replace-with-secure-token"
    server_ip   = hcloud_server.control_plane[0].ipv4_address
    k3s_version = var.k3s_version
    nodepool    = "cpx"
    arch        = "amd64"
  })

  lifecycle {
    ignore_changes = [network]
  }
}

resource "hcloud_server" "worker_pool_cax" {
  count       = var.cax_min_nodes
  name        = "${var.name_prefix}-cax-${count.index + 1}"
  server_type = var.worker_cax_server_type
  image       = "ubuntu-24.04"
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.default.id]

  network {
    network_id = hcloud_network.private.id
  }

  labels = {
    "nodepool" = "cax"
    "arch"     = "arm64"
  }

  user_data = templatefile("${path.module}/templates/k3s-worker-cloudinit.tftpl", {
    token       = "replace-with-secure-token"
    server_ip   = hcloud_server.control_plane[0].ipv4_address
    k3s_version = var.k3s_version
    nodepool    = "cax"
    arch        = "arm64"
  })

  lifecycle {
    ignore_changes = [network]
  }
}

resource "hcloud_load_balancer_target" "workers_cpx" {
  count            = var.cpx_min_nodes
  load_balancer_id = hcloud_load_balancer.ingress.id
  type             = "server"
  server_id        = hcloud_server.worker_pool_cpx[count.index].id
  use_private_ip   = true
}

resource "hcloud_load_balancer_target" "workers_cax" {
  count            = var.cax_min_nodes
  load_balancer_id = hcloud_load_balancer.ingress.id
  type             = "server"
  server_id        = hcloud_server.worker_pool_cax[count.index].id
  use_private_ip   = true
}

resource "hcloud_load_balancer_target" "control_plane" {
  count            = var.control_plane_count
  load_balancer_id = hcloud_load_balancer.ingress.id
  type             = "server"
  server_id        = hcloud_server.control_plane[count.index].id
  use_private_ip   = true
}

# Bootstrap kubeconfig into this path after provisioning control plane.
# Example: scp /etc/rancher/k3s/k3s.yaml and rewrite server endpoint.
variable "kubeconfig_path" {
  type    = string
  default = "./kubeconfig"
}

provider "kubernetes" {
  config_path = var.kubeconfig_path
}

provider "helm" {
  kubernetes {
    config_path = var.kubeconfig_path
  }
}

resource "kubernetes_namespace" "platform_system" {
  metadata {
    name = "platform-system"
  }
}

resource "cloudflare_record" "apps_wildcard" {
  count   = var.cloudflare_zone_id != "" ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = "*.${var.cluster_domain}"
  type    = "CNAME"
  value   = "${var.cloudflare_tunnel_id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

resource "helm_release" "nginx_ingress" {
  name       = "ingress-nginx"
  repository = "https://kubernetes.github.io/ingress-nginx"
  chart      = "ingress-nginx"
  namespace  = "ingress-nginx"

  create_namespace = true

  values = [yamlencode({
    controller = {
      service = {
        type = "ClusterIP"
      }
    }
  })]
}

resource "kubernetes_secret" "cloudflared_tunnel_token" {
  metadata {
    name      = "cloudflared-tunnel-token"
    namespace = kubernetes_namespace.platform_system.metadata[0].name
  }

  data = {
    token = var.cloudflare_tunnel_token
  }

  type = "Opaque"
}

resource "kubernetes_manifest" "cloudflared_deployment" {
  manifest = {
    apiVersion = "apps/v1"
    kind       = "Deployment"
    metadata = {
      name      = "cloudflared"
      namespace = kubernetes_namespace.platform_system.metadata[0].name
      labels = {
        app = "cloudflared"
      }
    }
    spec = {
      replicas = 2
      selector = {
        matchLabels = {
          app = "cloudflared"
        }
      }
      template = {
        metadata = {
          labels = {
            app = "cloudflared"
          }
        }
        spec = {
          containers = [{
            name  = "cloudflared"
            image = "cloudflare/cloudflared:latest"
            args  = ["tunnel", "--no-autoupdate", "run"]
            env = [{
              name = "TUNNEL_TOKEN"
              valueFrom = {
                secretKeyRef = {
                  name = "cloudflared-tunnel-token"
                  key  = "token"
                }
              }
            }]
            resources = {
              requests = {
                cpu    = "50m"
                memory = "64Mi"
              }
              limits = {
                cpu    = "250m"
                memory = "256Mi"
              }
            }
          }]
        }
      }
    }
  }

  depends_on = [
    kubernetes_secret.cloudflared_tunnel_token,
    helm_release.nginx_ingress
  ]
}

resource "helm_release" "cert_manager" {
  count      = var.enable_cert_manager ? 1 : 0
  name       = "cert-manager"
  repository = "https://charts.jetstack.io"
  chart      = "cert-manager"
  namespace  = "cert-manager"

  create_namespace = true

  values = [yamlencode({
    installCRDs = true
  })]
}

resource "kubernetes_manifest" "letsencrypt_clusterissuer" {
  count = var.enable_cert_manager ? 1 : 0
  manifest = {
    apiVersion = "cert-manager.io/v1"
    kind       = "ClusterIssuer"
    metadata = {
      name = "letsencrypt-prod"
    }
    spec = {
      acme = {
        email  = "platform-ops@${var.cluster_domain}"
        server = "https://acme-v02.api.letsencrypt.org/directory"
        privateKeySecretRef = {
          name = "letsencrypt-prod"
        }
        solvers = [{
          http01 = {
            ingress = {
              class = "nginx"
            }
          }
        }]
      }
    }
  }

  depends_on = [helm_release.cert_manager]
}

resource "kubernetes_secret" "github_pat" {
  metadata {
    name      = "github-token"
    namespace = kubernetes_namespace.platform_system.metadata[0].name
  }

  data = {
    token = var.github_pat
  }

  type = "Opaque"
}

resource "kubernetes_secret" "registry_credentials" {
  metadata {
    name      = "registry-creds"
    namespace = kubernetes_namespace.platform_system.metadata[0].name
  }

  data = {
    ".dockerconfigjson" = jsonencode({
      auths = {
        (var.registry_server) = {
          username = var.registry_username
          password = var.registry_password
          auth     = base64encode("${var.registry_username}:${var.registry_password}")
        }
      }
    })
  }

  type = "kubernetes.io/dockerconfigjson"
}

resource "helm_release" "cluster_autoscaler" {
  name       = "cluster-autoscaler"
  repository = "https://kubernetes.github.io/autoscaler"
  chart      = "cluster-autoscaler"
  namespace  = "kube-system"

  values = [yamlencode({
    cloudProvider = "hetzner"
    # CPX (amd64) and CAX (arm64) node groups.
    # The chart renders repeated --nodes flags from these entries.
    autoscalingGroups = [
      {
        name         = "cpx"
        minSize      = var.cpx_min_nodes
        maxSize      = var.cpx_max_nodes
        instanceType = upper(var.worker_cpx_server_type)
        region       = upper(var.location)
      },
      {
        name         = "cax"
        minSize      = var.cax_min_nodes
        maxSize      = var.cax_max_nodes
        instanceType = upper(var.worker_cax_server_type)
        region       = upper(var.location)
      }
    ]
    extraArgs = {
      "balance-similar-node-groups"      = true
      "enforce-node-group-min-size"      = true
      "expander"                         = "least-waste"
      "skip-nodes-with-local-storage"    = false
      "skip-nodes-with-system-pods"      = false
      "max-node-provision-time"          = "15m"
      "scale-down-enabled"               = true
      "scale-down-delay-after-add"       = "10m"
      "scale-down-unneeded-time"         = "10m"
      "scale-down-utilization-threshold" = "0.5"
    }
    rbac = {
      create = true
    }
    extraEnv = {
      HCLOUD_TOKEN      = var.hcloud_token
      HCLOUD_CLOUD_INIT = "true"
    }
  })]
}

resource "helm_release" "monitoring" {
  count      = var.enable_monitoring ? 1 : 0
  name       = "kube-prometheus-stack"
  repository = "https://prometheus-community.github.io/helm-charts"
  chart      = "kube-prometheus-stack"
  namespace  = "monitoring"
  version    = "61.3.2"

  create_namespace = true

  values = [yamlencode({
    alertmanager = {
      enabled = false
    }
    grafana = {
      adminPassword = "admin"
      ingress = {
        enabled          = true
        ingressClassName = "nginx"
        hosts            = [local.monitoring_host]
        path             = "/"
        pathType         = "Prefix"
      }
      "grafana.ini" = {
        "auth.anonymous" = {
          enabled  = true
          org_role = "Viewer"
        }
      }
    }
    prometheus = {
      ingress = {
        enabled = false
      }
      prometheusSpec = {
        retention = "7d"
      }
    }
  })]

  depends_on = [helm_release.nginx_ingress]
}

# Optional: Render node group config used by a custom autoscaler controller/wrapper
# to scale CPX and CAX pools by pending pod requirements and nodeSelector/affinity.
resource "local_file" "autoscaler_nodegroups" {
  filename = "./generated/hetzner-node-groups.yaml"
  content = yamlencode({
    nodeGroups = [
      {
        name         = "cpx"
        serverType   = var.worker_cpx_server_type
        architecture = "amd64"
        minNodes     = var.cpx_min_nodes
        maxNodes     = var.cpx_max_nodes
        labels = {
          nodepool = "cpx"
          arch     = "amd64"
        }
      },
      {
        name         = "cax"
        serverType   = var.worker_cax_server_type
        architecture = "arm64"
        minNodes     = var.cax_min_nodes
        maxNodes     = var.cax_max_nodes
        labels = {
          nodepool = "cax"
          arch     = "arm64"
        }
      }
    ]
  })
}

output "load_balancer_public_ip" {
  value = hcloud_load_balancer.ingress.ipv4
}

output "control_plane_public_ip" {
  value = hcloud_server.control_plane[0].ipv4_address
}

output "cluster_domain_hint" {
  value = "Wildcard DNS is automated in Cloudflare: *.${var.cluster_domain} -> ${var.cloudflare_tunnel_id}.cfargotunnel.com"
}

output "monitoring_ui_url" {
  value = var.enable_monitoring ? "https://${local.monitoring_host}" : ""
}

resource "hcloud_ssh_key" "admin_api" {
  count      = var.deploy_separate_api_projects ? 1 : 0
  provider   = hcloud.admin_project
  name       = "b3-admin-api-ssh"
  public_key = var.ssh_public_key
}

resource "hcloud_server" "admin_api" {
  count       = var.deploy_separate_api_projects ? 1 : 0
  provider    = hcloud.admin_project
  name        = "b3-api"
  server_type = var.api_server_type
  image       = "ubuntu-24.04"
  location    = var.location
  ssh_keys    = [hcloud_ssh_key.admin_api[0].id]
  user_data   = templatefile("${path.module}/templates/b3-api-cloudinit.tftpl", {})
}

output "api_server_public_ip" {
  value = var.deploy_separate_api_projects ? hcloud_server.admin_api[0].ipv4_address : ""
}

resource "cloudflare_record" "admin_api_a" {
  count   = var.deploy_separate_api_projects && var.cloudflare_zone_id != "" && var.admin_api_domain != "" ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(var.admin_api_domain, ".${var.cluster_domain}")
  type    = "A"
  value   = hcloud_server.admin_api[0].ipv4_address
  proxied = false
  ttl     = 1
}

resource "cloudflare_record" "user_api_a" {
  count   = var.deploy_separate_api_projects && var.cloudflare_zone_id != "" && var.user_api_domain != "" ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(var.user_api_domain, ".${var.cluster_domain}")
  type    = "A"
  value   = hcloud_server.admin_api[0].ipv4_address
  proxied = false
  ttl     = 1
}

resource "cloudflare_record" "api_ssh_a" {
  count   = var.deploy_separate_api_projects && var.cloudflare_zone_id != "" && var.api_ssh_domain != "" ? 1 : 0
  zone_id = var.cloudflare_zone_id
  name    = var.api_ssh_domain
  type    = "A"
  content = hcloud_server.admin_api[0].ipv4_address
  proxied = false
  ttl     = 1
}

output "admin_api_access" {
  value = var.deploy_separate_api_projects ? (
    var.admin_api_domain != "" ? "http://${var.admin_api_domain}:9000" : "http://${hcloud_server.admin_api[0].ipv4_address}:9000"
  ) : ""
}

output "user_api_access" {
  value = var.deploy_separate_api_projects ? (
    var.user_api_domain != "" ? "http://${var.user_api_domain}:9001" : "http://${hcloud_server.admin_api[0].ipv4_address}:9001"
  ) : ""
}
