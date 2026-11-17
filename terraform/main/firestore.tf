resource "google_firestore_database" "facade" {
  name        = "notion-mcp-oauth-facade"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
}

# TTL ポリシー: 各コレクションの expire_at フィールドで期限切れドキュメントを自動削除
resource "google_firestore_field" "ttl" {
  for_each = toset(["codes", "refresh_tokens", "revoked_jti", "events"])

  database   = google_firestore_database.facade.name
  collection = each.value
  field      = "expire_at"

  ttl_config {}
}
