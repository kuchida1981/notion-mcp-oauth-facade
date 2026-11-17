import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/crypto.js";
import {
  BASE,
  REDIRECT,
  authParams,
  form,
  fullFlow,
  getCode,
  mcpCall,
  pkce,
  refreshReq,
  register,
  setup,
} from "./helpers.js";

const WWW_AUTH = `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`;
const WWW_AUTH_INVALID = `Bearer error="invalid_token", resource_metadata="${BASE}/.well-known/oauth-protected-resource"`;

describe("メタデータ / ヘルスチェック", () => {
  it("全て 200 で期待値を返す", async () => {
    const { app } = await setup();
    expect(await (await app.request("/healthz")).json()).toEqual({ status: "ok" });

    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        resource: `${BASE}/mcp`,
        authorization_servers: [BASE],
        bearer_methods_supported: ["header"],
        scopes_supported: ["mcp"],
      });
    }

    const res = await app.request("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    const md = (await res.json()) as Record<string, unknown>;
    expect(md).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/authorize`,
      token_endpoint: `${BASE}/token`,
      registration_endpoint: `${BASE}/register`,
      revocation_endpoint: `${BASE}/revoke`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });
});

describe("crypto", () => {
  it("scrypt ハッシュの検証", async () => {
    const h = await hashPassword("pw");
    expect(h).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    expect(await verifyPassword("pw", h)).toBe(true);
    expect(await verifyPassword("other", h)).toBe(false);
    expect(await verifyPassword("pw", "garbage")).toBe(false);
  });
});

describe("/register", () => {
  it("201 でクライアントを発行し events に redirect_uri を記録する", async () => {
    const { app, store } = await setup();
    const { res, clientId } = await register(app);
    expect(res.status).toBe(201);
    expect(clientId).toBeTruthy();
    expect(store.events.find((e) => e.endpoint === "/register")?.redirect_uri).toEqual([REDIRECT]);
  });

  it("http や不正な redirect_uri は拒否 (localhost は設定時のみ許可)", async () => {
    const { app } = await setup();
    expect((await register(app, "http://example.com/cb")).res.status).toBe(400);
    expect((await register(app, "http://localhost:3000/cb")).res.status).toBe(400);
    const { app: app2 } = await setup({ ALLOW_LOCALHOST_REDIRECT: "true" });
    expect((await register(app2, "http://localhost:3000/cb")).res.status).toBe(201);
    expect((await register(app2, "http://127.0.0.1:3000/cb")).res.status).toBe(201);
  });
});

describe("正常系 E2E", () => {
  it("register -> authorize -> token -> /mcp", async () => {
    const { app, store } = await setup();
    const { clientId } = await register(app);
    const { challenge, verifier } = pkce();

    const get = await app.request("/authorize?" + new URLSearchParams(authParams(clientId, challenge)));
    expect(get.status).toBe(200);
    const html = await get.text();
    expect(html).toContain('type="password"');
    expect(html).toContain(`value="${clientId}"`);

    const { res, code, state } = await getCode(app, clientId, challenge);
    expect(res.status).toBe(302);
    expect(code).toBeTruthy();
    expect(state).toBe("st-123");

    const tokenRes = await app.request(
      "/token",
      form({ grant_type: "authorization_code", code: code!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
    );
    expect(tokenRes.status).toBe(200);
    const t = (await tokenRes.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number };
    expect(t.token_type).toBe("Bearer");
    expect(t.expires_in).toBe(300);

    const init = await mcpCall(app, t.access_token, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(((await init.json()) as any).result.serverInfo.name).toBe("notion");

    const list = await mcpCall(app, t.access_token, "tools/list");
    const names = ((await list.json()) as any).result.tools.map((x: any) => x.name).sort();
    expect(names).toEqual(["notion_fetch", "notion_query_data_source", "notion_search", "whoami"]);

    const who = await mcpCall(app, t.access_token, "tools/call", { name: "whoami", arguments: {} });
    const claims = JSON.parse(((await who.json()) as any).result.content[0].text);
    expect(claims).toMatchObject({ sub: "owner", client_id: clientId, iss: BASE, aud: `${BASE}/mcp`, rotated_refresh_mode: false, read_only: true });
    expect(claims.jti).toBeTruthy();
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);

    // events: トークン生値は記録されない
    const dump = JSON.stringify(store.events);
    expect(dump).not.toContain(t.access_token);
    expect(dump).not.toContain(t.refresh_token);
    expect(dump).not.toContain(code!);
    const tokenEvt = store.events.find((e) => e.endpoint === "/token");
    expect(tokenEvt).toMatchObject({ grant_type: "authorization_code", client_id: clientId, status_code: 200 });
    expect(tokenEvt?.token_hash_prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(store.events.some((e) => e.endpoint === "/mcp" && e.status_code === 200)).toBe(true);
  });

  it("パスワード誤りは 401 でフォーム再表示", async () => {
    const { app } = await setup();
    const { clientId } = await register(app);
    const res = await app.request("/authorize", form({ ...authParams(clientId, pkce().challenge), password: "wrong" }));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("パスワードが違います");
  });
});

describe("リフレッシュ", () => {
  it("ROTATE_REFRESH=false: 同じ refresh_token が返り繰り返し使える", async () => {
    const { app } = await setup();
    const { clientId, tokens } = await fullFlow(app);
    for (let i = 0; i < 2; i++) {
      const res = await app.request("/token", refreshReq(clientId, tokens.refresh_token));
      expect(res.status).toBe(200);
      const t = (await res.json()) as typeof tokens;
      expect(t.refresh_token).toBe(tokens.refresh_token);
      expect((await mcpCall(app, t.access_token, "tools/list")).status).toBe(200);
    }
  });

  it("ROTATE_REFRESH=true: 新トークンが返り、旧トークンは invalid_grant", async () => {
    const { app } = await setup({ ROTATE_REFRESH: "true" });
    const { clientId, tokens } = await fullFlow(app);
    const res = await app.request("/token", refreshReq(clientId, tokens.refresh_token));
    expect(res.status).toBe(200);
    const t = (await res.json()) as typeof tokens;
    expect(t.refresh_token).not.toBe(tokens.refresh_token);

    const reuse = await app.request("/token", refreshReq(clientId, tokens.refresh_token));
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as any).error).toBe("invalid_grant");

    expect((await app.request("/token", refreshReq(clientId, t.refresh_token))).status).toBe(200);
  });

  it("client_id 不一致は invalid_grant", async () => {
    const { app } = await setup();
    const { tokens } = await fullFlow(app);
    const res = await app.request("/token", refreshReq("someone-else", tokens.refresh_token));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_grant");
  });

  it("refresh の events に grant_type が残る", async () => {
    const { app, store } = await setup();
    const { clientId, tokens } = await fullFlow(app);
    await app.request("/token", refreshReq(clientId, tokens.refresh_token));
    const evts = store.events.filter((e) => e.endpoint === "/token" && e.grant_type === "refresh_token");
    expect(evts).toHaveLength(1);
    expect(evts[0]!.token_hash_prefix).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("/revoke", () => {
  it("リフレッシュトークン失効後は /token が失敗する", async () => {
    const { app } = await setup();
    const { clientId, tokens } = await fullFlow(app);
    const rev = await app.request("/revoke", form({ token: tokens.refresh_token }));
    expect(rev.status).toBe(200);
    const res = await app.request("/token", refreshReq(clientId, tokens.refresh_token));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_grant");
  });

  it("アクセストークン失効後は /mcp が 401 + WWW-Authenticate", async () => {
    const { app } = await setup();
    const { tokens } = await fullFlow(app);
    expect((await mcpCall(app, tokens.access_token, "tools/list")).status).toBe(200);
    expect((await app.request("/revoke", form({ token: tokens.access_token }))).status).toBe(200);
    const res = await mcpCall(app, tokens.access_token, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(WWW_AUTH_INVALID);
  });

  it("未知のトークンでも 200", async () => {
    const { app } = await setup();
    expect((await app.request("/revoke", form({ token: "nope" }))).status).toBe(200);
  });
});

describe("異常系", () => {
  it("code_verifier 不一致 -> invalid_grant", async () => {
    const { app } = await setup();
    const { clientId } = await register(app);
    const { challenge } = pkce();
    const { code } = await getCode(app, clientId, challenge);
    const res = await app.request(
      "/token",
      form({ grant_type: "authorization_code", code: code!, redirect_uri: REDIRECT, client_id: clientId, code_verifier: pkce().verifier }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_grant");
  });

  it("認可コード再利用 -> invalid_grant", async () => {
    const { app } = await setup();
    const { clientId, verifier, code } = await fullFlow(app);
    const res = await app.request(
      "/token",
      form({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_grant");
  });

  it("redirect_uri 不一致 -> /authorize は 400 (リダイレクトしない)", async () => {
    const { app } = await setup();
    const { clientId } = await register(app);
    const q = new URLSearchParams(authParams(clientId, pkce().challenge, { redirect_uri: "https://evil.example.com/cb" }));
    const get = await app.request("/authorize?" + q);
    expect(get.status).toBe(400);
    expect(get.headers.get("location")).toBeNull();
    const post = await app.request("/authorize", form({ ...Object.fromEntries(q), password: "x" }));
    expect(post.status).toBe(400);
    expect(post.headers.get("location")).toBeNull();
  });

  it("redirect_uri 不一致 -> /token は invalid_grant", async () => {
    const { app } = await setup();
    const { clientId } = await register(app);
    const { verifier, challenge } = pkce();
    const { code } = await getCode(app, clientId, challenge);
    const res = await app.request(
      "/token",
      form({ grant_type: "authorization_code", code: code!, redirect_uri: "https://evil.example.com/cb", client_id: clientId, code_verifier: verifier }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("invalid_grant");
  });

  it("不明な client_id -> 400 ページ", async () => {
    const { app } = await setup();
    const q = new URLSearchParams(authParams("unknown", pkce().challenge));
    expect((await app.request("/authorize?" + q)).status).toBe(400);
  });

  it("PKCE plain / 未指定は拒否 (redirect で error を返す)", async () => {
    const { app } = await setup();
    const { clientId } = await register(app);
    for (const extra of [{ code_challenge_method: "plain" }, { code_challenge_method: "" }]) {
      const q = new URLSearchParams(authParams(clientId, pkce().challenge, extra));
      if (!extra.code_challenge_method) q.delete("code_challenge_method");
      const res = await app.request("/authorize?" + q);
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.searchParams.get("error")).toBe("invalid_request");
      expect(loc.searchParams.get("code")).toBeNull();
      expect(loc.searchParams.get("state")).toBe("st-123");

      const post = await app.request("/authorize", form({ ...Object.fromEntries(q), password: "x" }));
      expect(new URL(post.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    }
  });

  it("resource が /mcp と異なる場合は invalid_target", async () => {
    const { app } = await setup();
    const { clientId } = await register(app);
    const q = new URLSearchParams(authParams(clientId, pkce().challenge, { resource: "https://other.example.com/mcp" }));
    const res = await app.request("/authorize?" + q);
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("未対応の grant_type", async () => {
    const { app } = await setup();
    const res = await app.request("/token", form({ grant_type: "password" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("unsupported_grant_type");
  });

  it("Bearer なしで /mcp -> 401 + WWW-Authenticate", async () => {
    const { app } = await setup();
    const res = await mcpCall(app, undefined, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(WWW_AUTH);
  });

  it("無効トークンの 401 は error=invalid_token を含み、未提示では含まない", async () => {
    const { app } = await setup();
    const bad = await mcpCall(app, "garbage", "tools/list");
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(bad.headers.get("www-authenticate")).toContain("resource_metadata=");
    const none = await mcpCall(app, undefined, "tools/list");
    expect(none.headers.get("www-authenticate")).not.toContain("invalid_token");
  });

  it("/mcp の内部エラーは JSON-RPC 形式の 500 になる", async () => {
    const { app, store } = await setup();
    const { tokens } = await fullFlow(app);
    store.isJtiRevoked = async () => {
      throw new Error("firestore down");
    };
    const res = await mcpCall(app, tokens.access_token, "tools/list");
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32603 } });
  });

  it("不正な署名のトークン -> 401", async () => {
    const { app } = await setup();
    const res = await mcpCall(app, "not.a.jwt", "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(WWW_AUTH_INVALID);
  });

  it("期限切れ JWT で /mcp -> 401 + WWW-Authenticate", async () => {
    const { app, config } = await setup();
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ client_id: "c" })
      .setProtectedHeader({ alg: "HS256", kid: config.jwtKeyId })
      .setIssuer(BASE)
      .setAudience(`${BASE}/mcp`)
      .setSubject("owner")
      .setJti("expired-jti")
      .setIssuedAt(now - 600)
      .setExpirationTime(now - 300)
      .sign(new TextEncoder().encode(config.jwtSigningKey));
    const res = await mcpCall(app, expired, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(WWW_AUTH_INVALID);
  });

  it("aud 違いの JWT は 401", async () => {
    const { app, config } = await setup();
    const bad = await new SignJWT({ client_id: "c" })
      .setProtectedHeader({ alg: "HS256", kid: config.jwtKeyId })
      .setIssuer(BASE)
      .setAudience("https://other.example.com/mcp")
      .setSubject("owner")
      .setJti("j")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(config.jwtSigningKey));
    expect((await mcpCall(app, bad, "tools/list")).status).toBe(401);
  });

  it("GET /mcp, DELETE /mcp -> 405", async () => {
    const { app } = await setup();
    const { tokens } = await fullFlow(app);
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request("/mcp", { method, headers: { Authorization: `Bearer ${tokens.access_token}` } });
      expect(res.status).toBe(405);
    }
  });
});

describe("events: /mcp の観察情報", () => {
  it("rpc_method・tool_name・duration_ms を記録し、引数は記録しない", async () => {
    const { app, store } = await setup();
    const { tokens } = await fullFlow(app);
    await mcpCall(app, tokens.access_token, "tools/call", { name: "whoami", arguments: { secret: "x" } });
    const events = (store as unknown as { events: Array<Record<string, unknown>> }).events;
    const evt = events.filter((e) => e.endpoint === "/mcp").at(-1)!;
    expect(evt).toMatchObject({ rpc_method: "tools/call", tool_name: "whoami", status_code: 200 });
    expect(typeof evt.duration_ms).toBe("number");
    expect(JSON.stringify(evt)).not.toContain("secret");
  });
});

describe("MCP_JSON_RESPONSE=false (SSE 応答)", () => {
  it("text/event-stream で JSON-RPC 応答を返す", async () => {
    const { app } = await setup({ MCP_JSON_RESPONSE: "false" });
    const { tokens } = await fullFlow(app);
    const res = await mcpCall(app, tokens.access_token, "tools/list");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data:"))!;
    expect(JSON.parse(data.slice(5)).result.tools.length).toBeGreaterThan(0);
  });

  it("既定 (true) は application/json", async () => {
    const { app } = await setup();
    const { tokens } = await fullFlow(app);
    const res = await mcpCall(app, tokens.access_token, "tools/list");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("events: リクエストヘッダの要約", () => {
  it("req_info を記録し、Authorization は含めない", async () => {
    const { app, store } = await setup();
    const { tokens } = await fullFlow(app);
    await app.request("/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${tokens.access_token}`,
        "Mcp-Protocol-Version": "2025-06-18",
        "User-Agent": "test-agent",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const evt = store.events.filter((e) => e.endpoint === "/mcp").at(-1)!;
    expect(evt.req_info).toMatchObject({ has_session_id: false, protocol_version: "2025-06-18", ua: "test-agent" });
    expect(JSON.stringify(evt)).not.toContain(tokens.access_token);
  });
});
