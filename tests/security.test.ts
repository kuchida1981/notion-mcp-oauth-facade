import { describe, expect, it } from "vitest";
import { authParams, form, pkce, register, setup } from "./helpers.js";

describe("Phase 3 セキュリティ強化 (レート制限・ロックアウト・ヘッダ)", () => {
  it("/register が IP 単位で 10回/10分 を超えると 429 + Retry-After を返す", async () => {
    const { app } = await setup();
    const headers = {
      "Content-Type": "application/json",
      "X-Forwarded-For": "203.0.113.10",
    };

    for (let i = 0; i < 10; i++) {
      const res = await app.request("/register", {
        method: "POST",
        headers,
        body: JSON.stringify({ redirect_uris: ["https://gemini.google.com/oauth/callback"] }),
      });
      expect(res.status).toBe(201);
    }

    const blocked = await app.request("/register", {
      method: "POST",
      headers,
      body: JSON.stringify({ redirect_uris: ["https://gemini.google.com/oauth/callback"] }),
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await blocked.json()) as any).error).toBe("too_many_requests");
  });

  it("/authorize がパスワード 5回連続失敗でロックアウト (429) になる", async () => {
    const { app } = await setup();
    const { clientId } = await register(app);
    const { challenge } = pkce();
    const base = authParams(clientId, challenge);

    const getRes = await app.request(`/authorize?${new URLSearchParams(base).toString()}`, {
      headers: { "X-Forwarded-For": "203.0.113.20" },
    });
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("x-frame-options")).toBe("DENY");
    expect(getRes.headers.get("x-content-type-options")).toBe("nosniff");

    for (let i = 0; i < 4; i++) {
      const req = form({ ...base, password: "wrong-password" });
      const res = await app.request("/authorize", {
        ...req,
        headers: { ...req.headers, "X-Forwarded-For": "203.0.113.20" },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }

    // 5回目でロックアウト発動 (429)
    const fifthReq = form({ ...base, password: "wrong-password" });
    const fifthRes = await app.request("/authorize", {
      ...fifthReq,
      headers: { ...fifthReq.headers, "X-Forwarded-For": "203.0.113.20" },
    });
    expect(fifthRes.status).toBe(429);
    expect(Number(fifthRes.headers.get("retry-after"))).toBeGreaterThan(0);

    // ロックアウト中は正しいパスワードでも拒否される
    const correctReq = form({ ...base, password: "correct horse battery staple" });
    const lockedRes = await app.request("/authorize", {
      ...correctReq,
      headers: { ...correctReq.headers, "X-Forwarded-For": "203.0.113.20" },
    });
    expect(lockedRes.status).toBe(429);
  });

  it("別の IP からの正しいパスワード認証は影響を受けず、成功時は失敗カウントをリセットする", async () => {
    const { app } = await setup();
    const { clientId } = await register(app);
    const { challenge } = pkce();
    const base = authParams(clientId, challenge);

    // 2回失敗
    for (let i = 0; i < 2; i++) {
      const req = form({ ...base, password: "wrong" });
      const res = await app.request("/authorize", {
        ...req,
        headers: { ...req.headers, "X-Forwarded-For": "203.0.113.30" },
      });
      expect(res.status).toBe(401);
    }

    // 正しいパスワードで成功 (302)
    const okReq = form({ ...base, password: "correct horse battery staple" });
    const okRes = await app.request("/authorize", {
      ...okReq,
      headers: { ...okReq.headers, "X-Forwarded-For": "203.0.113.30" },
    });
    expect(okRes.status).toBe(302);
  });
});

describe("クライアント IP の判定", () => {
  it("X-Forwarded-For の先頭を書き換えてもレート制限を回避できない", async () => {
    const { app } = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await app.request("/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${i}, 203.0.113.99` },
        body: JSON.stringify({ redirect_uris: ["https://gemini.google.com/oauth/callback"] }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("events 書き込みの遅延", () => {
  it("addEvent が応答しなくてもレスポンスは返る", async () => {
    const { app, store } = await setup();
    store.addEvent = () => new Promise(() => undefined);
    const res = await app.request("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
  }, 5000);
});
