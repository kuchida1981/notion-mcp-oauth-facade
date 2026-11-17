import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { hashPrefix, randomToken, sha256Hex, verifyPassword, verifyPkceS256 } from "./crypto.js";
import type { AppEnv } from "./events.js";
import type { Store } from "./store/types.js";
import { readVerifiedJti, resourceUrl, signAccessToken } from "./tokens.js";

const SCOPE = "mcp";
const CODE_TTL_MS = 60_000;

const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export function isAllowedRedirectUri(uri: string, allowLocalhost: boolean): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return allowLocalhost && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
}

const normalizeResource = (r: string) => r.replace(/\/+$/, "");

interface AuthParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

const PARAM_KEYS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

function pickParams(src: Record<string, unknown>): AuthParams {
  const out: AuthParams = {};
  for (const k of PARAM_KEYS) out[k] = str(src[k]);
  return out;
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head><body style="font-family:sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem">${body}</body></html>`;
}

function authorizeForm(p: AuthParams, clientName: string | undefined, error?: string): string {
  const hidden = PARAM_KEYS.filter((k) => p[k] !== undefined)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(p[k]!)}">`)
    .join("");
  return page(
    "認可",
    `<h1>アクセスを許可しますか?</h1>
<p>クライアント: <strong>${esc(clientName ?? p.client_id ?? "")}</strong></p>
${error ? `<p style="color:#b00020">${esc(error)}</p>` : ""}
<form method="post" action="/authorize">${hidden}
<label>オーナーパスワード<br><input type="password" name="password" autocomplete="current-password" required autofocus></label>
<p><button type="submit">許可する</button></p></form>`,
  );
}

export function oauthRoutes(config: Config, store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const oauthError = (c: Context<AppEnv>, status: 400 | 401, error: string, description: string) => {
    c.get("evt").error = error;
    return c.json({ error, error_description: description }, status, noStore);
  };

  // ---------- /register (RFC 7591) ----------
  app.post("/register", async (c) => {
    let body: Record<string, unknown>;
    try {
      const j = await c.req.json();
      if (typeof j !== "object" || j === null || Array.isArray(j)) throw new Error();
      body = j as Record<string, unknown>;
    } catch {
      return oauthError(c, 400, "invalid_client_metadata", "JSON ボディが不正です");
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string")) {
      return oauthError(c, 400, "invalid_redirect_uri", "redirect_uris は必須の文字列配列です");
    }
    c.get("evt").redirect_uri = uris as string[];
    const bad = (uris as string[]).find((u) => !isAllowedRedirectUri(u, config.allowLocalhostRedirect));
    if (bad !== undefined) {
      return oauthError(c, 400, "invalid_redirect_uri", "redirect_uri は https のみ許可されます");
    }
    const strArr = (v: unknown) =>
      Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
    const client = {
      client_id: randomUUID(),
      redirect_uris: uris as string[],
      client_name: str(body.client_name),
      grant_types: strArr(body.grant_types),
      response_types: strArr(body.response_types),
      token_endpoint_auth_method: str(body.token_endpoint_auth_method),
      created_at: Date.now(),
    };
    await store.putClient(client);
    c.get("evt").client_id = client.client_id;
    return c.json(
      {
        client_id: client.client_id,
        client_id_issued_at: Math.floor(client.created_at / 1000),
        redirect_uris: client.redirect_uris,
        client_name: client.client_name,
        grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
        response_types: client.response_types ?? ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
      noStore,
    );
  });

  // ---------- /authorize ----------
  /**
   * クライアント/redirect_uri を検証する。不正ならリダイレクトせず 400 ページを返す。
   * 通過した場合は、その他のパラメータ検証結果 (リダイレクトで返すエラー) も返す。
   */
  async function validateAuthorize(
    c: Context<AppEnv>,
    p: AuthParams,
  ): Promise<
    | { page: Response }
    | { clientName?: string; redirectError?: { error: string; description: string }; resource: string }
  > {
    const evt = c.get("evt");
    evt.client_id = p.client_id;
    evt.redirect_uri = p.redirect_uri;
    evt.resource = p.resource;
    const fail = (msg: string, code: string) => {
      evt.error = code;
      return { page: c.html(page("エラー", `<h1>エラー</h1><p>${esc(msg)}</p>`), 400) };
    };
    if (!p.client_id || !p.redirect_uri) return fail("client_id と redirect_uri は必須です", "invalid_request");
    const client = await store.getClient(p.client_id);
    if (!client) return fail("不明な client_id です", "invalid_client");
    if (!client.redirect_uris.includes(p.redirect_uri)) return fail("redirect_uri が登録値と一致しません", "invalid_redirect_uri");

    const canonical = resourceUrl(config);
    const resource = p.resource ?? canonical;
    let redirectError: { error: string; description: string } | undefined;
    if (p.response_type !== "code") {
      redirectError = { error: "unsupported_response_type", description: "response_type=code のみ対応" };
    } else if (!p.code_challenge || p.code_challenge_method !== "S256") {
      redirectError = { error: "invalid_request", description: "PKCE (code_challenge_method=S256) が必須です" };
    } else if (normalizeResource(resource) !== canonical) {
      redirectError = { error: "invalid_target", description: "resource が不正です" };
    }
    if (redirectError) evt.error = redirectError.error;
    return { clientName: client.client_name, redirectError, resource: canonical };
  }

  const redirectWith = (redirectUri: string, params: Record<string, string | undefined>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  };

  app.get("/authorize", async (c) => {
    const p = pickParams(c.req.query());
    const v = await validateAuthorize(c, p);
    if ("page" in v) return v.page;
    if (v.redirectError) {
      return c.redirect(
        redirectWith(p.redirect_uri!, { error: v.redirectError.error, error_description: v.redirectError.description, state: p.state }),
        302,
      );
    }
    return c.html(authorizeForm(p, v.clientName), 200, noStore);
  });

  app.post("/authorize", async (c) => {
    const form = await c.req.parseBody();
    const p = pickParams(form);
    const v = await validateAuthorize(c, p);
    if ("page" in v) return v.page;
    if (v.redirectError) {
      return c.redirect(
        redirectWith(p.redirect_uri!, { error: v.redirectError.error, error_description: v.redirectError.description, state: p.state }),
        302,
      );
    }
    const password = typeof form.password === "string" ? form.password : "";
    if (!(await verifyPassword(password, config.ownerPasswordHash))) {
      c.get("evt").error = "access_denied";
      return c.html(authorizeForm(p, v.clientName, "パスワードが違います"), 401, noStore);
    }
    const code = randomToken();
    await store.putCode({
      code_hash: sha256Hex(code),
      client_id: p.client_id!,
      redirect_uri: p.redirect_uri!,
      code_challenge: p.code_challenge!,
      resource: v.resource,
      scope: p.scope ?? SCOPE,
      used: false,
      expires_at: Date.now() + CODE_TTL_MS,
    });
    c.get("evt").token_hash_prefix = hashPrefix(code);
    return c.redirect(redirectWith(p.redirect_uri!, { code, state: p.state }), 302);
  });

  // ---------- /token ----------
  const refreshExpiry = (now: number, createdAt: number) =>
    Math.min(now + config.refreshIdleTtl * 1000, createdAt + config.refreshMaxTtl * 1000);

  app.post("/token", async (c) => {
    const evt = c.get("evt");
    const form = await c.req.parseBody();
    const grantType = str(form.grant_type);
    evt.grant_type = grantType;
    evt.client_id = str(form.client_id);
    const now = Date.now();

    const issue = async (clientId: string, resource: string, scope: string, refreshToken: string) => {
      const access = await signAccessToken(config, { clientId, resource, scope });
      return c.json(
        {
          access_token: access,
          token_type: "Bearer",
          expires_in: config.accessTtl,
          refresh_token: refreshToken,
          scope,
        },
        200,
        noStore,
      );
    };

    if (grantType === "authorization_code") {
      const code = str(form.code);
      const redirectUri = str(form.redirect_uri);
      const clientId = str(form.client_id);
      const verifier = str(form.code_verifier);
      if (!code || !redirectUri || !clientId || !verifier) {
        return oauthError(c, 400, "invalid_request", "code, redirect_uri, client_id, code_verifier は必須です");
      }
      evt.token_hash_prefix = hashPrefix(code);
      // 検証の成否にかかわらずコードは消費される (再利用防止)
      const rec = await store.consumeCode(sha256Hex(code), now);
      if (
        !rec ||
        rec.client_id !== clientId ||
        rec.redirect_uri !== redirectUri ||
        !verifyPkceS256(verifier, rec.code_challenge)
      ) {
        return oauthError(c, 400, "invalid_grant", "認可コードが無効です");
      }
      const refresh = randomToken();
      await store.putRefresh({
        token_hash: sha256Hex(refresh),
        client_id: clientId,
        resource: rec.resource,
        scope: rec.scope,
        revoked: false,
        created_at: now,
        last_used_at: now,
        expires_at: refreshExpiry(now, now),
      });
      evt.resource = rec.resource;
      return issue(clientId, rec.resource, rec.scope, refresh);
    }

    if (grantType === "refresh_token") {
      const token = str(form.refresh_token);
      const clientId = str(form.client_id);
      if (!token) return oauthError(c, 400, "invalid_request", "refresh_token は必須です");
      evt.token_hash_prefix = hashPrefix(token);
      const hash = sha256Hex(token);
      const rec = await store.getRefresh(hash);
      if (!rec || rec.revoked || rec.expires_at <= now || (clientId !== undefined && clientId !== rec.client_id)) {
        return oauthError(c, 400, "invalid_grant", "リフレッシュトークンが無効です");
      }
      evt.client_id = rec.client_id;
      evt.resource = rec.resource;
      if (config.rotateRefresh) {
        const next = randomToken();
        await store.updateRefresh(hash, { revoked: true });
        await store.putRefresh({
          ...rec,
          token_hash: sha256Hex(next),
          revoked: false,
          last_used_at: now,
          expires_at: refreshExpiry(now, rec.created_at),
        });
        return issue(rec.client_id, rec.resource, rec.scope, next);
      }
      await store.updateRefresh(hash, { last_used_at: now, expires_at: refreshExpiry(now, rec.created_at) });
      return issue(rec.client_id, rec.resource, rec.scope, token);
    }

    return oauthError(c, 400, "unsupported_grant_type", "grant_type が未対応です");
  });

  // ---------- /revoke (RFC 7009) ----------
  app.post("/revoke", async (c) => {
    const evt = c.get("evt");
    const form = await c.req.parseBody();
    const token = str(form.token);
    if (token) {
      evt.token_hash_prefix = hashPrefix(token);
      const hash = sha256Hex(token);
      const rec = await store.getRefresh(hash);
      if (rec) {
        evt.client_id = rec.client_id;
        await store.updateRefresh(hash, { revoked: true });
      } else {
        const j = await readVerifiedJti(config, token);
        if (j) {
          evt.client_id = j.clientId;
          await store.revokeJti(j.jti, j.exp);
        }
      }
    }
    // RFC 7009: 不明なトークンでも 200
    return c.body(null, 200, noStore);
  });

  return app;
}
