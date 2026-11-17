# Phase 0 (観察版) 詳細仕様書

## 1. 目的
Gemini (Spark) カスタムアプリと本ファサード間の OAuth 2.1 + Streamable HTTP MCP 通信の実挙動を観察し、設計メモの仮説 H1/H2/H3 を確定させる。Notion API にはまだ接続せず、ダミーツール (`whoami`, `echo`) のみを提供する。

## 2. 技術スタック
- **Runtime**: Node.js 20+ (Dockerfile は `node:22-slim`)
- **Language**: TypeScript (`strict: true`, ESM)
- **Web Framework**: `hono` + `@hono/node-server`
- **MCP SDK**: `@modelcontextprotocol/sdk` (`McpServer`, `WebStandardStreamableHTTPServerTransport`)
- **JWT**: `jose` (HS256, `kid` ヘッダ付き)
- **Validation**: `zod`
- **Persistence**: `@google-cloud/firestore` (名前付き DB 対応) + テスト/ローカル用 `InMemoryStore`
- **Test**: `vitest`

## 3. 環境変数 (`src/config.ts`)
| 変数名 | 必須 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `PORT` | No | `8080` | リスンポート |
| `PUBLIC_BASE_URL` | Yes | - | サービスの公開ベース URL (末尾スラッシュなし, 例: `https://xxx.run.app`) |
| `JWT_SIGNING_KEY` | Yes | - | HS256 署名鍵 (32バイト以上推奨) |
| `JWT_KEY_ID` | No | `v1` | JWT ヘッダの `kid` |
| `OWNER_PASSWORD_HASH` | Yes | - | `/authorize` 用パスワードハッシュ (`scrypt$<salt_hex>$<hash_hex>`) |
| `ACCESS_TTL` | No | `300` | アクセストークン寿命 (秒)。Phase 0 既定は 300秒 (5分) |
| `REFRESH_IDLE_TTL` | No | `7776000` | リフレッシュトークン無通信失効期限 (秒, 既定 90日) |
| `REFRESH_MAX_TTL` | No | `31536000` | リフレッシュトークン絶対上限 (秒, 既定 365日) |
| `ROTATE_REFRESH` | No | `false` | `true` の場合、リフレッシュ時に新しいトークンを発行し旧トークンを無効化 |
| `STORE_BACKEND` | No | `firestore` | `firestore` または `memory` |
| `FIRESTORE_DATABASE_ID` | No | `(default)` | Firestore データベース ID (`kuchida-devel` では名前付き DB を指定) |
| `ALLOW_LOCALHOST_REDIRECT` | No | `false` | `true` の場合 `http://localhost` / `http://127.0.0.1` の `redirect_uri` を許可 |

## 4. エンドポイント仕様

### 4.1 メタデータ & ヘルスチェック
- `GET /healthz`: `200 OK` (`{ "status": "ok" }`)
- `GET /.well-known/oauth-protected-resource` および `GET /.well-known/oauth-protected-resource/mcp`:
  ```json
  {
    "resource": "<PUBLIC_BASE_URL>/mcp",
    "authorization_servers": ["<PUBLIC_BASE_URL>"],
    "bearer_methods_supported": ["header"],
    "scopes_supported": ["mcp"]
  }
  ```
- `GET /.well-known/oauth-authorization-server`:
  ```json
  {
    "issuer": "<PUBLIC_BASE_URL>",
    "authorization_endpoint": "<PUBLIC_BASE_URL>/authorize",
    "token_endpoint": "<PUBLIC_BASE_URL>/token",
    "registration_endpoint": "<PUBLIC_BASE_URL>/register",
    "revocation_endpoint": "<PUBLIC_BASE_URL>/revoke",
    "response_types_supported": ["code"],
    "grant_types_supported": ["authorization_code", "refresh_token"],
    "code_challenge_methods_supported": ["S256"],
    "token_endpoint_auth_methods_supported": ["none"],
    "scopes_supported": ["mcp"]
  }
  ```

### 4.2 `POST /register` (RFC 7591 DCR)
- リクエスト JSON: `redirect_uris` (必須, 配列, 各要素は `https://...`、ただし `ALLOW_LOCALHOST_REDIRECT=true` の場合のみ `http://localhost` / `http://127.0.0.1` 許可), `client_name` (任意), `grant_types` (任意), `response_types` (任意), `token_endpoint_auth_method` (任意)
- ランダムな `client_id` (UUID 等) を発行し、`clients` コレクションに保存して `201 Created` を返す。
- `events` に `redirect_uris` 等を記録する。

### 4.3 `GET /authorize`, `POST /authorize`
- クエリ / フォームパラメータ: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge`, `code_challenge_method=S256` (`plain` や未指定は拒否), `state` (推奨/そのまま返却), `scope` (任意), `resource` (任意、未指定時は `<PUBLIC_BASE_URL>/mcp`)
- クライアント存在確認と `redirect_uri` の完全一致チェック。不正な `client_id` や `redirect_uri` の場合はリダイレクトせず `400` エラーページを返す（オープンリダイレクト防止）。
- `GET /authorize`: オーナー認証用の最小 HTML フォーム（パスワード入力 + hidden フィールドで認可パラメータを保持）を返す。
- `POST /authorize`: パスワードを `OWNER_PASSWORD_HASH` と `crypto.scrypt` + `timingSafeEqual` で検証。失敗時は `401` でフォームを再表示（エラーメッセージ付き）。成功時は 256bit ランダム認可コードを生成し、SHA-256 ハッシュを `codes` コレクションに保存（寿命 60秒）して `${redirect_uri}?code=${code}&state=${state}` へ 302 リダイレクト。

### 4.4 `POST /token`
- `application/x-www-form-urlencoded` を受け付ける。
- `grant_type=authorization_code`:
  - `code`, `redirect_uri`, `client_id`, `code_verifier` を検証。
  - `codes` からハッシュで検索。未使用・未期限切れ・`client_id` 一致・`redirect_uri` 一致を確認し、直ちに `used = true` に更新（再利用防止）。
  - PKCE S256 検証: `BASE64URL(SHA256(code_verifier)) === code_challenge`。
  - JWT アクセストークン (`iss`, `aud` = resource, `sub` = `"owner"`, `client_id`, `jti`, `exp`, `iat`) と 256bit ランダムリフレッシュトークンを発行。
  - リフレッシュトークンはハッシュを `refresh_tokens` に保存。
- `grant_type=refresh_token`:
  - `refresh_token`, `client_id` (指定があれば一致確認) を検証。
  - `refresh_tokens` からハッシュで検索。`revoked === false` かつ期限内であることを確認。
  - 新しい JWT アクセストークンを発行。
  - `ROTATE_REFRESH=false` (既定): 同じ `refresh_token` を返し、`last_used_at` と `expires_at` (`min(now + REFRESH_IDLE_TTL, created_at + REFRESH_MAX_TTL)`) を更新。
  - `ROTATE_REFRESH=true`: 旧レコードを `revoked = true` にし、新しい `refresh_token` を発行・保存して返す。
- エラー時は OAuth 標準 JSON (`{ "error": "invalid_grant", "error_description": "..." }`) を `400` で返す。

### 4.5 `POST /revoke`
- `token` パラメータを受け取る。
- リフレッシュトークンまたは JWT アクセストークンのどちらが渡されても処理する:
  - リフレッシュトークンの場合: `refresh_tokens` の該当レコードを `revoked = true` にする。
  - JWT の場合: `jti` を `revoked_jti` に登録する（さらに紐づくグラント/client_id があれば必要に応じて処理）。
- RFC 7009 に従い `200 OK` を返す。

### 4.6 `/mcp` (Streamable HTTP, ステートレス)
- `GET /mcp`, `DELETE /mcp` 等 `POST` 以外は `405 Method Not Allowed` を返す。
- `POST /mcp`:
  - `Authorization: Bearer <token>` を検証（JWT 署名・`exp`・`iss`・`aud`・`revoked_jti` 非存在確認）。
  - 無効または未指定の場合: `401 Unauthorized` と `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_BASE_URL>/.well-known/oauth-protected-resource"` を返す。
  - 有効な場合: リクエストごとにステートレス `McpServer` + `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })` で処理する。
  - 提供ツール (Phase 0 ダミーツール):
    - `whoami`: `{ sub, client_id, jti, iss, aud, exp, rotated_refresh_mode }` を JSON テキストで返す（`readOnlyHint: true`）。
    - `echo`: `{ message: string }` を受け取り、そのまま返す（`readOnlyHint: true`）。

## 5. `events` 観察ログ仕様
トークン生値やパスワードは一切記録しない。以下を記録する:
- `timestamp`: ISO8601 / Firestore Timestamp
- `endpoint`: 例 `/register`, `/authorize`, `/token`, `/revoke`, `/mcp`
- `method`: `GET` / `POST`
- `grant_type`: 該当時のみ
- `client_id`: 該当時のみ
- `token_hash_prefix`: トークンの SHA-256 hex の先頭 8 文字（該当時のみ）
- `redirect_uri`: `/register`, `/authorize` 時
- `resource`: 該当時のみ
- `status_code`: HTTP ステータスコード
- `error`: エラーコード（該当時のみ）
- `expire_at`: Firestore TTL 用フィールド（作成から 30 日後）

## 6. テスト要件 (`vitest`)
`STORE_BACKEND=memory` を使って Hono アプリ (`app.request(...)`) に対する結合テストを作成する:
1. メタデータ (`/.well-known/*`, `/healthz`) が 200 を返すこと
2. 正常系 E2E: `/register` -> `GET/POST /authorize` -> `/token` (code) -> `/mcp` (`initialize`, `tools/list`, `tools/call` `whoami` / `echo`)
3. リフレッシュ (`ROTATE_REFRESH=false`): 同じ `refresh_token` が返り、2回目も同じトークンで更新できること
4. リフレッシュ (`ROTATE_REFRESH=true`): 新しい `refresh_token` が返り、旧トークン再利用で `invalid_grant` になること
5. `/revoke`: リフレッシュトークン失効後に `/token` が失敗すること、アクセストークン失効後に `/mcp` が `401` + `WWW-Authenticate` になること
6. 異常系:
   - `code_verifier` 不一致 -> `invalid_grant`
   - 認可コード再利用 -> `invalid_grant`
   - `redirect_uri` 不一致 -> 拒否
   - PKCE `plain` -> 拒否
   - Bearer なし / 期限切れ JWT で `/mcp` -> `401` + `WWW-Authenticate`
   - `GET /mcp` -> `405`
