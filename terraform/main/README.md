# terraform/main

Firestore / Artifact Registry / Secret Manager / Cloud Run などアプリ本体のインフラ。
通常は GitHub Actions (`terraform-plan.yml` / `terraform-apply.yml`) から適用します。
前提: `terraform/bootstrap` を適用済みであること。

## ローカルでの実行

```bash
cd terraform/main
terraform init -backend-config="bucket=<TF_STATE_BUCKET>"
terraform plan -var project_id=kuchida-devel
```

## 初回構築手順 (重要)

Cloud Run は Secret Manager の `version = "latest"` を参照します。シークレットに **バージョンが 1 つも無い状態で
Cloud Run を作成すると失敗** します。初回のみ次の順で実行してください。

1. secrets (と依存する IAM / SA) だけを先に apply

   ```bash
   terraform apply -var project_id=kuchida-devel \
     -target=google_service_account.runner \
     -target=google_secret_manager_secret.this \
     -target=google_secret_manager_secret_iam_member.runner_accessor
   ```

2. シークレットの値を登録

   ```bash
   # JWT 署名鍵
   openssl rand -base64 48 | tr -d '\n' | \
     gcloud secrets versions add notion-mcp-jwt-signing-key --data-file=- --project=kuchida-devel

   # オーナーパスワードのハッシュ (形式: scrypt$<salt_hex>$<hash_hex>)
   npm run hash-password   # 出力されたハッシュを下へ
   printf '%s' '<hash>' | \
     gcloud secrets versions add notion-mcp-owner-password-hash --data-file=- --project=kuchida-devel
   ```

3. 全体を apply (手動、または GitHub Actions の `terraform-apply` を `workflow_dispatch` で実行)

   ```bash
   terraform apply -var project_id=kuchida-devel
   ```

4. `deploy.yml` を実行して実イメージをデプロイ (初回は `us-docker.pkg.dev/cloudrun/container/hello` が動いています)。

## 補足

- `initial_image` は初回作成時のみ使用。`lifecycle.ignore_changes` により以降のイメージ更新は `deploy.yml` が担当します。
- `PUBLIC_BASE_URL` 未指定時は `https://<service>-<project number>.<region>.run.app` を使用します。カスタムドメインを使う場合は `public_base_url` 変数で上書きしてください。
- `deletion_protection = false` のため、`terraform destroy` でサービスも削除できます。
- GitHub Actions では `TF_VAR_project_id` を `GCP_PROJECT_ID` secret から渡しています。
