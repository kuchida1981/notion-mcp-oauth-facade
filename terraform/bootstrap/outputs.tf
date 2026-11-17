output "state_bucket" {
  description = "tfstate 用 GCS バケット名 (GitHub Secret: TF_STATE_BUCKET)"
  value       = google_storage_bucket.tfstate.name
}

output "workload_identity_provider" {
  description = "WIF プロバイダのリソース名 (GitHub Secret: GCP_WORKLOAD_IDENTITY_PROVIDER)"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "service_account_email" {
  description = "CI 用サービスアカウント (GitHub Secret: GCP_SERVICE_ACCOUNT_EMAIL)"
  value       = google_service_account.terraform_ci.email
}
