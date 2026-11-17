# 値 (secret_version) は tfstate に残さないため Terraform では作らない。
# 手動で `gcloud secrets versions add` して投入する (terraform/main/README.md 参照)。
locals {
  secret_ids = {
    jwt_signing_key     = "notion-mcp-jwt-signing-key"
    owner_password_hash = "notion-mcp-owner-password-hash"
    notion_token        = "notion-mcp-notion-token"
  }
}

resource "google_secret_manager_secret" "this" {
  for_each = local.secret_ids

  secret_id = each.value

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_iam_member" "runner_accessor" {
  for_each = local.secret_ids

  secret_id = google_secret_manager_secret.this[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.runner.email}"
}
