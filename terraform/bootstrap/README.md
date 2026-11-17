# terraform/bootstrap

tfstate 用 GCS バケットと、GitHub Actions 用の Workload Identity Federation / CI サービスアカウントを作成します。
**ローカルで 1 回だけ実行**します。State はローカル管理です (`terraform.tfstate` は `.gitignore` 済み。紛失しないよう保管すること)。

## 手順

```bash
gcloud auth application-default login
cd terraform/bootstrap
terraform init
terraform apply \
  -var project_id=kuchida-devel \
  -var github_repo=<owner>/notion-mcp-oauth-facade
```

実行ユーザーにはプロジェクトの Owner 相当の権限が必要です。

## 出力 → GitHub Secrets

| 値 | GitHub Secret |
| --- | --- |
| プロジェクト ID | `GCP_PROJECT_ID` |
| `workload_identity_provider` | `GCP_WORKLOAD_IDENTITY_PROVIDER` |
| `service_account_email` | `GCP_SERVICE_ACCOUNT_EMAIL` |
| `state_bucket` | `TF_STATE_BUCKET` |

```bash
terraform output
```
