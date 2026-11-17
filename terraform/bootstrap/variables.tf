variable "project_id" {
  description = "GCP プロジェクト ID"
  type        = string
}

variable "region" {
  description = "リージョン"
  type        = string
  default     = "asia-northeast1"
}

variable "github_repo" {
  description = "GitHub リポジトリ (owner/repo 形式)。WIF の attribute_condition に使用"
  type        = string
}
