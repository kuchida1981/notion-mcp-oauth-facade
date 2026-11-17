terraform {
  required_version = ">= 1.6.0"

  # bucket は `terraform init -backend-config="bucket=<TF_STATE_BUCKET>"` で渡す
  backend "gcs" {
    prefix = "notion-mcp/main"
  }

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

data "google_project" "current" {
  project_id = var.project_id
}
