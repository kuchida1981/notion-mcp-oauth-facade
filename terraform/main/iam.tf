resource "google_service_account" "runner" {
  account_id   = "notion-mcp-runner"
  display_name = "notion-mcp-oauth-facade Cloud Run runtime"
}

resource "google_project_iam_member" "runner_datastore_user" {
  project = var.project_id
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.runner.email}"
}
