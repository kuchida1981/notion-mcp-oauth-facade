import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import * as z from "zod/v4";
import type { Config } from "./config.js";
import { hashPrefix } from "./crypto.js";
import type { AppEnv } from "./events.js";
import type { Store } from "./store/types.js";
import { verifyAccessToken, type AccessClaims } from "./tokens.js";

/** リクエストごとに生成するステートレスな McpServer (Phase 0: ダミーツールのみ) */
export function buildMcpServer(config: Config, claims: AccessClaims): McpServer {
  const server = new McpServer({ name: "notion-mcp-oauth-facade", version: "0.0.1" });

  server.registerTool(
    "whoami",
    {
      description: "現在のアクセストークンのクレーム情報を返す (観察用ダミーツール)",
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            sub: claims.sub,
            client_id: claims.client_id,
            jti: claims.jti,
            iss: claims.iss,
            aud: claims.aud,
            exp: claims.exp,
            rotated_refresh_mode: config.rotateRefresh,
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "echo",
    {
      description: "受け取った message をそのまま返す (観察用ダミーツール)",
      inputSchema: { message: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => ({ content: [{ type: "text" as const, text: message }] }),
  );

  return server;
}

export function mcpRoutes(config: Config, store: Store): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const metadataUrl = `${config.publicBaseUrl}/.well-known/oauth-protected-resource`;

  const unauthorized = () => {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${metadataUrl}"`,
        "Cache-Control": "no-store",
      },
    });
  };

  app.post("/mcp", async (c) => {
    const evt = c.get("evt");
    const header = c.req.header("authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(header);
    if (!m) {
      evt.error = "missing_token";
      return unauthorized();
    }
    const token = m[1]!;
    evt.token_hash_prefix = hashPrefix(token);
    let claims: AccessClaims;
    try {
      claims = await verifyAccessToken(config, token);
    } catch {
      evt.error = "invalid_token";
      return unauthorized();
    }
    evt.client_id = claims.client_id;
    evt.resource = claims.aud;
    if (await store.isJtiRevoked(claims.jti)) {
      evt.error = "revoked_token";
      return unauthorized();
    }

    const server = buildMcpServer(config, claims);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      // レスポンス生成後に後始末 (ステートレス)
      void server.close().catch(() => undefined);
    }
  });

  // POST 以外 (GET/DELETE ほか) は 405
  app.all("/mcp", (c) => {
    c.get("evt").error = "method_not_allowed";
    return c.json({ error: "method_not_allowed" }, 405, { Allow: "POST" });
  });

  return app;
}
