locals {
  public_base_url = var.public_base_url != "" ? var.public_base_url : "https://${var.service_name}-${data.google_project.current.number}.${var.region}.run.app"
}

resource "google_cloud_run_v2_service" "facade" {
  name                = var.service_name
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = false

  template {
    service_account = google_service_account.runner.email
    timeout         = "300s"

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      image = var.initial_image

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      env {
        name  = "PUBLIC_BASE_URL"
        value = local.public_base_url
      }
      env {
        name  = "STORE_BACKEND"
        value = "firestore"
      }
      env {
        name  = "FIRESTORE_DATABASE_ID"
        value = google_firestore_database.facade.name
      }
      env {
        name  = "ACCESS_TTL"
        value = tostring(var.access_ttl)
      }
      env {
        name  = "ROTATE_REFRESH"
        value = tostring(var.rotate_refresh)
      }
      env {
        name  = "READ_ONLY"
        value = tostring(var.read_only)
      }
      env {
        name = "JWT_SIGNING_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.this["jwt_signing_key"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "OWNER_PASSWORD_HASH"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.this["owner_password_hash"].secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "NOTION_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.this["notion_token"].secret_id
            version = "latest"
          }
        }
      }
    }
  }

  # イメージは deploy.yml が更新するため Terraform では追従しない
  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.runner_accessor,
    google_project_iam_member.runner_datastore_user,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  name     = google_cloud_run_v2_service.facade.name
  location = google_cloud_run_v2_service.facade.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
