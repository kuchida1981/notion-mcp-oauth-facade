variable "project_id" {
  description = "GCP プロジェクト ID"
  type        = string
}

variable "region" {
  description = "リージョン"
  type        = string
  default     = "asia-northeast1"
}

variable "service_name" {
  description = "Cloud Run サービス名"
  type        = string
  default     = "notion-mcp-oauth-facade"
}

variable "initial_image" {
  description = "初回作成時のみ使うコンテナイメージ。以降は deploy.yml が更新する (ignore_changes)"
  type        = string
  default     = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "public_base_url" {
  description = "PUBLIC_BASE_URL (末尾スラッシュなし)。空の場合は Cloud Run の決定的 URL を使う"
  type        = string
  default     = ""
}

variable "access_ttl" {
  description = "アクセストークン寿命 (秒)"
  type        = number
  default     = 3600
}

variable "rotate_refresh" {
  description = "リフレッシュトークンをローテーションするか"
  type        = bool
  default     = false
}

variable "read_only" {
  description = "読み取り専用モード (Phase 2 以降は false)"
  type        = bool
  default     = false
}

variable "mcp_json_response" {
  description = "/mcp の POST 応答形式。true: application/json (既定) / false: text/event-stream (Gemini 互換性の実験用)"
  type        = bool
  default     = true
}
