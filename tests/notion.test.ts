import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { hashPassword } from "../src/crypto.js";
import { normalizeNotionUuid, NotionClient } from "../src/notion/client.js";
import { blocksToMarkdown } from "../src/notion/markdown.js";
import { InMemoryStore } from "../src/store/memory.js";
import { BASE, fullFlow, mcpCall, PASSWORD, setup } from "./helpers.js";

describe("UUID バリデーション", () => {
  it("ハイフン付き・32桁hexを正規化し、不正文字列を拒否する", () => {
    expect(normalizeNotionUuid("1234567890abcdef1234567890abcdef")).toBe(
      "12345678-90ab-cdef-1234-567890abcdef",
    );
    expect(normalizeNotionUuid("12345678-90AB-CDEF-1234-567890ABCDEF")).toBe(
      "12345678-90ab-cdef-1234-567890abcdef",
    );
    expect(() => normalizeNotionUuid("https://notion.so/123")).toThrow("Invalid Notion ID");
    expect(() => normalizeNotionUuid("not-a-uuid")).toThrow("Invalid Notion ID");
  });
});

describe("Markdown 変換", () => {
  it("基本ブロックとリッチテキスト・ネストを Markdown に変換する", () => {
    const md = blocksToMarkdown([
      { id: "1", type: "heading_1", heading_1: { rich_text: [{ plain_text: "Core Memory" }] } },
      {
        id: "2",
        type: "paragraph",
        paragraph: {
          rich_text: [
            { plain_text: "Hello " },
            { plain_text: "world", annotations: { bold: true } },
            { plain_text: " and " },
            { plain_text: "docs", href: "https://example.com" },
          ],
        },
      },
      {
        id: "3",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ plain_text: "親項目" }] },
        children: [
          { id: "3-1", type: "to_do", to_do: { checked: true, rich_text: [{ plain_text: "完了タスク" }] } },
        ],
      },
      {
        id: "4",
        type: "code",
        code: { language: "typescript", rich_text: [{ plain_text: "const x = 1;" }] },
      },
      { id: "5", type: "quote", quote: { rich_text: [{ plain_text: "引用" }] } },
      { id: "6", type: "divider", divider: {} },
    ]);

    expect(md).toBe(
      [
        "# Core Memory",
        "Hello **world** and [docs](https://example.com)",
        "- 親項目",
        "  - [x] 完了タスク",
        "```typescript",
        "const x = 1;",
        "```",
        "> 引用",
        "---",
      ].join("\n"),
    );
  });
});

describe("NotionClient & /mcp Notion ツール", () => {
  const PAGE_ID = "11111111-1111-1111-1111-111111111111";
  const DB_ID = "22222222-2222-2222-2222-222222222222";
  const DS_ID = "33333333-3333-3333-3333-333333333333";

  function createMockNotion(secret = "ntn_super_secret_token") {
    const calls: Array<{ url: string; method: string; version: string | null }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method ?? "GET", version: headers.get("Notion-Version") });

      if (url.endsWith("/search")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                object: "page",
                id: PAGE_ID,
                url: `https://www.notion.so/${PAGE_ID}`,
                last_edited_time: "2026-11-17T00:00:00.000Z",
                properties: { Name: { type: "title", title: [{ plain_text: "Memory Rule" }] } },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200 },
        );
      }

      if (url.endsWith(`/pages/${PAGE_ID}`)) {
        return new Response(
          JSON.stringify({
            object: "page",
            id: PAGE_ID,
            url: `https://www.notion.so/${PAGE_ID}`,
            last_edited_time: "2026-11-17T00:00:00.000Z",
            properties: {
              Name: { type: "title", title: [{ plain_text: "Memory Rule" }] },
              Category: { type: "select", select: { name: "Core" } },
            },
          }),
          { status: 200 },
        );
      }

      if (url.includes(`/blocks/${PAGE_ID}/children`)) {
        return new Response(
          JSON.stringify({
            results: [{ id: "b1", type: "paragraph", paragraph: { rich_text: [{ plain_text: "ルール本文" }] } }],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200 },
        );
      }

      // database_id で 404 -> GET /databases/{id} -> data_sources[0].id で再クエリ
      if (url.endsWith(`/data_sources/${DB_ID}/query`)) {
        return new Response(JSON.stringify({ code: "object_not_found", message: "Not found" }), { status: 404 });
      }
      if (url.endsWith(`/databases/${DB_ID}`)) {
        return new Response(JSON.stringify({ object: "database", id: DB_ID, data_sources: [{ id: DS_ID }] }), {
          status: 200,
        });
      }
      if (url.endsWith(`/data_sources/${DS_ID}/query`)) {
        return new Response(
          JSON.stringify({
            results: [
              {
                object: "page",
                id: PAGE_ID,
                properties: { Name: { type: "title", title: [{ plain_text: "Memory Entry" }] } },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200 },
        );
      }

      return new Response(JSON.stringify({ code: "unauthorized", message: "Invalid token" }), { status: 401 });
    };

    return { client: new NotionClient({ token: secret, fetchFn }), calls, secret };
  }

  it("search / fetch / query_data_source が /mcp 経由で動作しトークンを漏らさない", async () => {
    const { client, calls, secret } = createMockNotion();
    const config = loadConfig({
      PUBLIC_BASE_URL: BASE,
      JWT_SIGNING_KEY: "test-signing-key-test-signing-key-0123456789",
      OWNER_PASSWORD_HASH: await hashPassword(PASSWORD),
      STORE_BACKEND: "memory",
    });
    const store = new InMemoryStore();
    const app = createApp(config, store, client);

    const { tokens: t } = await fullFlow(app);

    const searchRes = await mcpCall(app, t.access_token, "tools/call", {
      name: "notion_search",
      arguments: { query: "Memory" },
    });
    const searchData = JSON.parse(((await searchRes.json()) as any).result.content[0].text);
    expect(searchData.results[0]).toMatchObject({ id: PAGE_ID, title: "Memory Rule" });
    expect(calls[0]?.version).toBe("2025-09-03");

    const fetchRes = await mcpCall(app, t.access_token, "tools/call", {
      name: "notion_fetch",
      arguments: { page_id: PAGE_ID.replace(/-/g, "") },
    });
    const fetchData = JSON.parse(((await fetchRes.json()) as any).result.content[0].text);
    expect(fetchData.title).toBe("Memory Rule");
    expect(fetchData.properties.Category).toBe("Core");
    expect(fetchData.markdown).toBe("ルール本文");

    // database_id を渡しても data_source_id 解決フォールバックで取得できる
    const queryRes = await mcpCall(app, t.access_token, "tools/call", {
      name: "notion_query_data_source",
      arguments: { data_source_id: DB_ID },
    });
    const queryData = JSON.parse(((await queryRes.json()) as any).result.content[0].text);
    expect(queryData.results[0].title).toBe("Memory Entry");

    // 不正な UUID はエラーとして返る
    const badIdRes = await mcpCall(app, t.access_token, "tools/call", {
      name: "notion_fetch",
      arguments: { page_id: "invalid-id-000000000000000000000000" },
    });
    const badBody = (await badIdRes.json()) as any;
    expect(badBody.result.isError).toBe(true);
    expect(badBody.result.content[0].text).toContain("Invalid Notion ID");
    expect(JSON.stringify(badBody)).not.toContain(secret);
  });

  it("NOTION_TOKEN 未設定時は安全なエラーメッセージを返す", async () => {
    const { app } = await setup();
    const { tokens: t } = await fullFlow(app);
    const res = await mcpCall(app, t.access_token, "tools/call", {
      name: "notion_search",
      arguments: { query: "test" },
    });
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("NOTION_TOKEN");
  });
});
