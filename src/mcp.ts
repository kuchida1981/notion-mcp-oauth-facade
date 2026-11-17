import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import * as z from "zod/v4";
import type { Config } from "./config.js";
import { hashPrefix } from "./crypto.js";
import type { AppEnv } from "./events.js";
import {
  extractObjectTitle,
  normalizeNotionUuid,
  NotionClient,
  summarizePageProperties,
} from "./notion/client.js";
import type { Store } from "./store/types.js";
import { verifyAccessToken, type AccessClaims } from "./tokens.js";

function jsonText(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function toolError(err: unknown) {
  const msg = err instanceof Error ? err.message : "Notion tool execution failed";
  return { isError: true, content: [{ type: "text" as const, text: msg }] };
}

/** リクエストごとに生成するステートレスな McpServer */
export function buildMcpServer(
  config: Config,
  claims: AccessClaims,
  notionOverride?: NotionClient,
): McpServer {
  const server = new McpServer({ name: "notion-mcp-oauth-facade", version: "0.1.0" });

  const getNotion = (): NotionClient => {
    if (notionOverride) return notionOverride;
    if (!config.notionToken) {
      throw new Error("NOTION_TOKEN is not configured on the server");
    }
    return new NotionClient({ token: config.notionToken, apiVersion: config.notionApiVersion });
  };

  server.registerTool(
    "whoami",
    {
      description: "現在のアクセストークンとサーバー動作モードを返す (デバッグ用)",
      annotations: { readOnlyHint: true },
    },
    async () =>
      jsonText({
        sub: claims.sub,
        client_id: claims.client_id,
        jti: claims.jti,
        iss: claims.iss,
        aud: claims.aud,
        exp: claims.exp,
        rotated_refresh_mode: config.rotateRefresh,
        read_only: config.readOnly,
        notion_configured: Boolean(notionOverride || config.notionToken),
      }),
  );

  server.registerTool(
    "notion_search",
    {
      description: "Notion のページやデータソース (DB) をタイトル・本文で検索する",
      inputSchema: {
        query: z.string().optional().describe("検索キーワード"),
        object_type: z.enum(["page", "data_source"]).optional().describe("対象種別で絞り込み"),
        page_size: z.number().int().min(1).max(50).optional().describe("取得件数 (既定 20, 最大 50)"),
        start_cursor: z.string().optional().describe("ページネーション用カーソル"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, object_type, page_size, start_cursor }) => {
      try {
        const res = await getNotion().search({
          query,
          objectType: object_type,
          pageSize: page_size ?? 20,
          startCursor: start_cursor,
        });
        const items = (res.results ?? []).map((item) => ({
          id: item.id,
          object: item.object,
          title: extractObjectTitle(item),
          url: item.url,
          last_edited_time: item.last_edited_time,
        }));
        return jsonText({ results: items, has_more: res.has_more, next_cursor: res.next_cursor });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "notion_fetch",
    {
      description: "Notion ページのプロパティと本文を Markdown 形式で取得する",
      inputSchema: {
        page_id: z.string().min(32).describe("Notion ページの UUID"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ page_id }) => {
      try {
        const id = normalizeNotionUuid(page_id);
        const page = await getNotion().fetchPageMarkdown(id);
        return jsonText(page);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.registerTool(
    "notion_query_data_source",
    {
      description: "Notion のデータソース (またはデータベース) をフィルター・ソート条件でクエリする",
      inputSchema: {
        data_source_id: z.string().min(32).describe("データソースまたはデータベースの UUID"),
        filter: z.record(z.string(), z.unknown()).optional().describe("Notion API 形式の filter オブジェクト"),
        sorts: z.array(z.record(z.string(), z.unknown())).optional().describe("Notion API 形式の sorts 配列"),
        page_size: z.number().int().min(1).max(50).optional().describe("取得件数 (既定 20, 最大 50)"),
        start_cursor: z.string().optional().describe("ページネーション用カーソル"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ data_source_id, filter, sorts, page_size, start_cursor }) => {
      try {
        const id = normalizeNotionUuid(data_source_id);
        const res = await getNotion().queryDataSource({
          dataSourceId: id,
          filter,
          sorts,
          pageSize: page_size ?? 20,
          startCursor: start_cursor,
        });
        const rows = (res.results ?? []).map((item) => ({
          id: item.id,
          title: extractObjectTitle(item),
          url: item.url,
          last_edited_time: item.last_edited_time,
          properties: summarizePageProperties(
            item.properties as Record<string, Record<string, unknown>> | undefined,
          ),
        }));
        return jsonText({ results: rows, has_more: res.has_more, next_cursor: res.next_cursor });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  return server;
}

export function mcpRoutes(config: Config, store: Store, notionOverride?: NotionClient): Hono<AppEnv> {
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

    const server = buildMcpServer(config, claims, notionOverride);
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
