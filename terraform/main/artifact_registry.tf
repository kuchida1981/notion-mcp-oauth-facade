resource "google_artifact_registry_repository" "facade" {
  repository_id = "notion-mcp-oauth-facade"
  format        = "DOCKER"
  location      = var.region
  description   = "notion-mcp-oauth-facade container images"
}
