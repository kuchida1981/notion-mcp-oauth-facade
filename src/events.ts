import type { MiddlewareHandler } from "hono";
import type { EventRecord, Store } from "./store/types.js";

/** ハンドラが埋める観察情報 (トークン生値・パスワードは入れない) */
export type EventFields = Partial<
  Pick<
    EventRecord,
    "grant_type" | "client_id" | "token_hash_prefix" | "redirect_uri" | "resource" | "error"
  >
>;

export type AppEnv = { Variables: { evt: EventFields } };

const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

/** 全リクエストを events に記録するミドルウェア (/healthz を除く) */
export function observe(store: Store): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set("evt", {});
    await next();
    const path = new URL(c.req.url).pathname;
    if (path === "/healthz") return;
    const now = Date.now();
    const fields = c.get("evt");
    const rec: EventRecord = {
      timestamp: new Date(now).toISOString(),
      endpoint: path,
      method: c.req.method,
      status_code: c.res.status,
      expire_at: new Date(now + THIRTY_DAYS_MS),
    };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) (rec as unknown as Record<string, unknown>)[k] = v;
    }
    try {
      await store.addEvent(rec);
    } catch (err) {
      // 観察ログの失敗でリクエストを落とさない
      console.error("event log failed:", err instanceof Error ? err.message : "unknown");
    }
  };
}
