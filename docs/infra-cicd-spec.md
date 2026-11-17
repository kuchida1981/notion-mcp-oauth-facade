# インフラ (Terraform) & CI/CD (GitHub Actions) 設計仕様書

## 1. 方針
`../n8n-ops` と同様の 2 段構成 (`terraform/bootstrap` + `terraform/main`) を採用し、GitHub Actions から Workload Identity Federation (WIF) 経由で GCP へ認証・デプロイする。

## 2. `terraform/bootstrap/` (ローカル実行・1回限り)
tfstate 用バケットと GitHub Actions 用の WIF・CI サービスアカウントを作成する。
- **State**: ローカル管理 (`terraform.tfstate` は `.gitignore` で除外)
- **作成リソース**:
  - `google_project_service`: `run.googleapis.com`, `firestore.googleapis.com`, `secretmanager.googleapis.com`, `artifactregistry.googleapis.com`, `iam.googleapis.com`, `iamcredentials.googleapis.com`, `cloudresourcemanager.googleapis.com`, `storage.googleapis.com`, `sts.googleapis.com`
  - `google_storage_bucket.tfstate`: `${var.project_id}-notion-mcp-tfstate` (asia-northeast1, uniform_bucket_level_access, public_access_prevention = enforced, versioning)
  - `google_iam_workload_identity_pool`: `github-actions-pool-notion-mcp`
  - `google_iam_workload_identity_pool_provider`: `github-actions-provider` (`attribute_condition = "assertion.repository == \"${var.github_repo}\""`)
  - `google_service_account.terraform_ci`: `terraform-ci-notion-mcp`
  - IAM:
    - WIF バインディング (`roles/iam.workloadIdentityUser`)
    - tfstate バケット (`roles/storage.objectAdmin`, `roles/storage.legacyBucketReader`)
    - プロジェクト権限 (`roles/run.admin`, `roles/artifactregistry.admin`, `roles/datastore.owner`, `roles/secretmanager.admin`, `roles/iam.serviceAccountAdmin`, `roles/iam.serviceAccountUser`)
- **Outputs**: `state_bucket`, `workload_identity_provider`, `service_account_email`

## 3. `terraform/main/` (GitHub Actions 管理)
`backend "gcs"` (`prefix = "notion-mcp/main"`) で管理する。
- **Firestore (`firestore.tf`)**:
  - `google_firestore_database.facade`: `name = "notion-mcp-oauth-facade"`, `location_id = var.region` (`asia-northeast1`), `type = "FIRESTORE_NATIVE"`
  - `google_firestore_field`: `codes`, `refresh_tokens`, `revoked_jti`, `events` の各コレクションに対して `field = "expire_at"`, `ttl_config {}` を設定
- **Artifact Registry (`artifact_registry.tf`)**:
  - `google_artifact_registry_repository.facade`: `repository_id = "notion-mcp-oauth-facade"`, `format = "DOCKER"`, `location = var.region`
- **IAM (`iam.tf`)**:
  - `google_service_account.runner`: `notion-mcp-runner`
  - `google_project_iam_member`: `runner` に `roles/datastore.user`
- **Secret Manager (`secrets.tf`)**:
  - `google_secret_manager_secret`: `notion-mcp-jwt-signing-key`, `notion-mcp-owner-password-hash` (値自体は tfstate に残さないため `secret_version` は作らず、手動またはセットアップ手順で投入)
  - `google_secret_manager_secret_iam_member`: `runner` に各シークレットの `roles/secretmanager.secretAccessor`
- **Cloud Run (`cloudrun.tf`)**:
  - `google_cloud_run_v2_service.facade`:
    - `name = "notion-mcp-oauth-facade"`, `location = var.region`
    - `ingress = "INGRESS_TRAFFIC_ALL"`
    - `service_account = google_service_account.runner.email`
    - `scaling`: `min_instance_count = 0`, `max_instance_count = 2`
    - `timeout = "300s"`
    - `containers`:
      - `image = var.initial_image` (既定 `"us-docker.pkg.dev/cloudrun/container/hello"`, `lifecycle { ignore_changes = [template[0].containers[0].image] }` により `deploy.yml` 側の更新と競合しない)
      - `resources.limits`: `cpu = "1"`, `memory = "512Mi"`
      - `env`: `PUBLIC_BASE_URL` (未指定時は `https://${var.service_name}-${data.google_project.current.number}.${var.region}.run.app`), `STORE_BACKEND = "firestore"`, `FIRESTORE_DATABASE_ID = google_firestore_database.facade.name`, `ACCESS_TTL = tostring(var.access_ttl)`, `ROTATE_REFRESH = tostring(var.rotate_refresh)`
      - Secret env: `JWT_SIGNING_KEY`, `OWNER_PASSWORD_HASH` (ともに `version = "latest"`)
  - `google_cloud_run_v2_service_iam_member`: `allUsers` に `roles/run.invoker`

## 4. GitHub Actions (`.github/workflows/`)
- `ci.yml`: PR / `main` push で `npm ci`, `npm run build`, `npm test`
- `terraform-plan.yml`: PR (`terraform/main/**` 変更時) で `terraform fmt -check`, `terraform validate`, `terraform plan`
- `terraform-apply.yml`: `main` push (`terraform/main/**` 変更時) または `workflow_dispatch` で `terraform apply`
- `deploy.yml`: `main` push (`src/**`, `package*.json`, `Dockerfile`, `tsconfig.json` 変更時) または `workflow_dispatch` で Docker イメージをビルドして Artifact Registry へ push し、`gcloud run services update` でイメージをデプロイ

### 必要な GitHub Secrets
- `GCP_PROJECT_ID`: `kuchida-devel`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`: bootstrap の出力値
- `GCP_SERVICE_ACCOUNT_EMAIL`: bootstrap の出力値
- `TF_STATE_BUCKET`: bootstrap の出力値
