output "service_url" {
  description = "Cloud Run サービス URL"
  value       = google_cloud_run_v2_service.facade.uri
}

output "public_base_url" {
  description = "PUBLIC_BASE_URL として設定した値"
  value       = local.public_base_url
}

output "artifact_registry_repository" {
  description = "Docker イメージの push 先"
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.facade.repository_id}"
}

output "runner_service_account_email" {
  description = "Cloud Run 実行用サービスアカウント"
  value       = google_service_account.runner.email
}
