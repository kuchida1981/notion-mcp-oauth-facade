# 運用・緊急対応手順書 (Runbook)

対象サービス: `notion-mcp-oauth-facade` (GCP プロジェクト: `kuchida-devel`, リージョン: `asia-northeast1`)

## 1. 個別トークンの失効 (`/revoke`)

特定の接続（Gemini 等）のアクセスまたはリフレッシュトークンだけを無効化する場合：

```fish
curl -sS -X POST "https://notion-mcp-oauth-facade-316021756456.asia-northeast1.run.app/revoke" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "token=<ACCESS_OR_REFRESH_TOKEN>"
```

- アクセストークンを渡した場合は `jti` が `revoked_jti` に登録され即座に `/mcp` で `401` になります。
- リフレッシュトークンを渡した場合は `refresh_tokens` の `revoked` が `true` になり更新不可になります。

## 2. 全アクセストークンの緊急一括失効 (`JWT_SIGNING_KEY` 切り替え)

トークン漏洩が疑われる場合、署名鍵を更新して発行済みの全アクセストークンを即座に無効化します。

```fish
# 1. 新しい署名鍵を Secret Manager に登録 (:latest が更新される)
openssl rand -base64 48 | tr -d "\n" | gcloud secrets versions add notion-mcp-jwt-signing-key --project=kuchida-devel --data-file=-

# 2. Cloud Run の新しいリビジョンを強制デプロイして新鍵を読み込ませる
gcloud run services update notion-mcp-oauth-facade \
  --project=kuchida-devel \
  --region=asia-northeast1 \
  --update-env-vars="JWT_KEY_ID=v"(date +%Y%m%d%H%M)
```

※ リフレッシュトークンも全失効させたい場合は、Firestore の `refresh_tokens` コレクションのドキュメントを削除してください。

## 3. オーナーパスワードの変更 (`OWNER_PASSWORD_HASH`)

```fish
node scripts/hash-password.mjs | gcloud secrets versions add notion-mcp-owner-password-hash --project=kuchida-devel --data-file=-

# 新リビジョン反映 (直ちに反映したい場合)
gcloud run services update notion-mcp-oauth-facade \
  --project=kuchida-devel \
  --region=asia-northeast1 \
  --update-env-vars="ROTATE_REFRESH=false"
```

## 4. Notion トークンの更新 (`NOTION_TOKEN`)

内部インテグレーショントークンの再発行や PAT 更新時：

```fish
printf '%s' 'ntn_新しいトークン' | gcloud secrets versions add notion-mcp-notion-token --project=kuchida-devel --data-file=-
```

## 5. 観察ログ (`events`) の確認

```fish
node -e '
import("@google-cloud/firestore").then(async ({ Firestore }) => {
  const db = new Firestore({ projectId: "kuchida-devel", databaseId: "notion-mcp-oauth-facade" });
  const snap = await db.collection("events").orderBy("timestamp", "desc").limit(20).get();
  snap.docs.reverse().forEach(d => {
    const x = d.data();
    console.log(x.timestamp.toDate().toISOString(), x.method, x.endpoint, x.status_code, x.grant_type || "", x.error || "", x.token_hash_prefix || "", x.rpc_method || "", x.tool_name || "", (x.duration_ms ?? "") + "ms");
  });
});
'
```

## 6. GCP 予算アラートの設定

Cloud Run / Firestore の予期せぬ課金を防ぐため、GCP コンソール（[お支払い → 予算とアラート](https://console.cloud.google.com/billing)）または `gcloud billing budgets create` で `kuchida-devel` に対して月額予算（例: 500円、50%/90%/100% 通知）を設定してください。
