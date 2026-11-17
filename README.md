# notion-mcp-oauth-facade (Phase 0: 観察版)

Gemini (Spark) カスタムアプリと本サービスの間の OAuth 2.1 + Streamable HTTP MCP 通信を観察し、設計メモの仮説 H1/H2/H3 を確定させるための最小実装です。Notion には接続せず、ダミーツール `whoami` / `echo` のみ提供します。

- 設計メモ: `Gemini向け Notion MCP OAuthファサード 設計メモ.md`
- 詳細仕様: `docs/phase0-spec.md`

## 構成

| パス | 内容 |
| --- | --- |
| `src/config.ts` | 環境変数の読み込み・検証 (zod) |
| `src/app.ts` | Hono アプリ組み立て (メタデータ, `/healthz`) |
| `src/oauth.ts` | `/register` `/authorize` `/token` `/revoke` |
| `src/mcp.ts` | `/mcp` (ステートレス, `WebStandardStreamableHTTPServerTransport`) |
| `src/tokens.ts` | JWT (HS256, `kid` 付き) の発行・検証 (jose) |
| `src/crypto.ts` | scrypt, PKCE S256, SHA-256 ヘルパー |
| `src/events.ts` | 全リクエストの観察ログ (events) ミドルウェア |
| `src/store/` | `Store` インターフェース, `InMemoryStore`, `FirestoreStore` |
| `scripts/hash-password.mjs` | `OWNER_PASSWORD_HASH` 生成ヘルパー |
| `tests/` | vitest 結合テスト (`STORE_BACKEND=memory`) |

## セットアップ

Node.js 20 以上が必要です。

```bash
npm install
cp .env.example .env   # 値を編集 (.env はコミットしない)
```

### 1. OWNER_PASSWORD_HASH を生成する

`/authorize` で入力するオーナーパスワードの scrypt ハッシュを作ります。パスワード自体は保存しません。

```bash
npm run hash-password
# パスワード: (入力は表示されません)
# 確認のためもう一度:
# scrypt$<salt_hex>$<hash_hex>
```

他の指定方法:

```bash
node scripts/hash-password.mjs 'my-password'            # 引数 (シェル履歴に残るので注意)
printf '%s' 'my-password' | node scripts/hash-password.mjs   # 標準入力
```

出力された `scrypt$...` の文字列全体を `OWNER_PASSWORD_HASH` に設定します。`$` を含むため、シェルや `.env` では**シングルクォートで囲む**か、Cloud Run では Secret Manager 経由で渡してください。

```bash
OWNER_PASSWORD_HASH='scrypt$0123...$abcd...'
```

### 2. JWT 署名鍵を作る

```bash
openssl rand -base64 48   # JWT_SIGNING_KEY に設定
```

鍵を変えると発行済みのアクセストークンはすべて無効になります (緊急全失効の手段)。

## 環境変数

| 変数名 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `PORT` | No | `8080` | リスンポート |
| `PUBLIC_BASE_URL` | Yes | - | 公開ベース URL (末尾スラッシュなし) |
| `JWT_SIGNING_KEY` | Yes | - | HS256 署名鍵 (32 バイト以上推奨) |
| `JWT_KEY_ID` | No | `v1` | JWT ヘッダの `kid` |
| `OWNER_PASSWORD_HASH` | Yes | - | `scrypt$<salt_hex>$<hash_hex>` |
| `ACCESS_TTL` | No | `300` | アクセストークン寿命 (秒) |
| `REFRESH_IDLE_TTL` | No | `7776000` | リフレッシュ無通信失効 (90 日) |
| `REFRESH_MAX_TTL` | No | `31536000` | リフレッシュ絶対上限 (365 日) |
| `ROTATE_REFRESH` | No | `false` | `true` でリフレッシュ時にトークンをローテーション |
| `STORE_BACKEND` | No | `firestore` | `firestore` / `memory` |
| `FIRESTORE_DATABASE_ID` | No | `(default)` | 名前付き DB を使う場合に指定 |
| `MCP_JSON_RESPONSE` | No | `true` | `/mcp` の応答形式。`false` で SSE (`text/event-stream`) |
| `MCP_SANITIZE_SCHEMA` | No | `false` | `true` で `tools/list` から `$schema` / `execution` を除く (Gemini 互換性の実験用) |
| `MCP_REQUIRE_SESSION` | No | `false` | `true` で署名付き `Mcp-Session-Id` を発行・要求 (Gemini 互換性の実験用) |
| `ALLOW_LOCALHOST_REDIRECT` | No | `false` | `http://localhost` / `127.0.0.1` の redirect_uri を許可 |

## 開発・ビルド・テスト

```bash
npm run dev      # tsx watch (STORE_BACKEND=memory で手元確認)
npm run build    # tsc -> dist/
npm start        # node dist/index.js
npm test         # vitest (メモリストア)
```

ローカル確認例 (`.env` を読み込んで起動):

```bash
set -a; source .env; set +a; npm run dev
curl localhost:8080/healthz
```

## Firestore

`STORE_BACKEND=firestore` のとき、Application Default Credentials で接続します。コレクションは `clients`, `codes`, `refresh_tokens`, `revoked_jti`, `events` です。TTL ポリシーは `codes` / `refresh_tokens` / `revoked_jti` / `events` の `expire_at` フィールドに設定してください。

```bash
gcloud firestore fields ttls update expire_at --collection-group=events \
  --enable-ttl --database=<FIRESTORE_DATABASE_ID>
# codes, refresh_tokens, revoked_jti も同様
```

## Cloud Run へのデプロイ例

```bash
gcloud run deploy notion-mcp-oauth-facade --source . --region asia-northeast1 \
  --allow-unauthenticated --max-instances 2 --timeout 300 \
  --set-env-vars PUBLIC_BASE_URL=https://<service-url>,STORE_BACKEND=firestore,FIRESTORE_DATABASE_ID=<db> \
  --set-secrets JWT_SIGNING_KEY=<secret>:latest,OWNER_PASSWORD_HASH=<secret>:latest
```

`PUBLIC_BASE_URL` は issuer と JWT の `iss`/`aud` に使われるため、変更すると発行済みトークンは無効になります。

## 観察のしかた (events)

全リクエスト (`/healthz` 除く) が `events` に記録されます。トークン生値・パスワードは記録せず、トークンは SHA-256 の先頭 8 文字 (`token_hash_prefix`) のみです。30 日後に TTL で削除されます。

- (1) `/register` の `redirect_uri`: `endpoint=/register` のイベント
- (2) 期限後に refresh が届くか: `endpoint=/token` かつ `grant_type=refresh_token`
- (3) ローテーション ON (`ROTATE_REFRESH=true`) 時に使われるトークン: `refresh_token` イベントの `token_hash_prefix` を時系列で比較 (新トークンを保存しているか)

## 設計上の補足

- `/mcp` は `enableJsonResponse: true` のステートレス動作で、リクエストごとに `McpServer` を生成します。
- `/authorize` で `resource` を指定する場合は `<PUBLIC_BASE_URL>/mcp` (末尾スラッシュ可) のみ受け付けます。不一致は `invalid_target` で、`resource` はイベントに記録されます。
- 認可コードは検証の成否にかかわらず 1 回の `/token` 呼び出しで消費されます。
- `redirect_uri` や PKCE 方式の不備は、クライアントと `redirect_uri` が有効な場合のみ `error` 付きリダイレクトで返し、クライアント/`redirect_uri` が不正な場合は 400 ページを表示します。
- レート制限・ロックアウトは Phase 3 の対象で、Phase 0 には含みません。
