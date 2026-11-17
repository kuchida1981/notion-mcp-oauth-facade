import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { hashPassword } from "../src/crypto.js";
import { normalizeNotionUuid, NotionClient } from "../src/notion/client.js";
import { blocksToMarkdown, markdownToBlocks } from "../src/notion/markdown.js";
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
      arguments: { data_source_id: DB_ID, filter_json: "{\"property\":\"Name\",\"title\":{\"is_not_empty\":true}}" },
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

  it("markdownToBlocks が各種 Markdown 構文を Notion ブロックに変換する", () => {
    const blocks = markdownToBlocks("# タイトル\n\n- 箇条書き\n- [x] 完了\n1. 番号\n> 引用\n---\n```ts\nconst a = 1;\n```\n本文");
    expect(blocks.map((b) => b.type)).toEqual([
      "heading_1",
      "bulleted_list_item",
      "to_do",
      "numbered_list_item",
      "quote",
      "divider",
      "code",
      "paragraph",
    ]);
  });

  it("READ_ONLY=false で notion_create_page / notion_update_page が有効化され動作する", async () => {
    const posted: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchFn: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";
      const parsedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      posted.push({ url, method, body: parsedBody });

      if (url.endsWith(`/data_sources/${DS_ID}`)) {
        return new Response(
          JSON.stringify({ id: DS_ID, properties: { 名前: { type: "title" } } }),
          { status: 200 },
        );
      }
      if (url.endsWith("/pages") && method === "POST") {
        return new Response(
          JSON.stringify({
            object: "page",
            id: PAGE_ID,
            url: `https://www.notion.so/${PAGE_ID}`,
            properties: { 名前: { type: "title", title: [{ plain_text: "新しい記憶" }] } },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/pages/${PAGE_ID}`) && method === "GET") {
        return new Response(
          JSON.stringify({
            object: "page",
            id: PAGE_ID,
            properties: { 名前: { type: "title", title: [{ plain_text: "新しい記憶" }] } },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/pages/${PAGE_ID}`) && method === "PATCH") {
        return new Response(
          JSON.stringify({ object: "page", id: PAGE_ID, url: `https://www.notion.so/${PAGE_ID}` }),
          { status: 200 },
        );
      }
      if (url.endsWith(`/blocks/${PAGE_ID}/children`) && method === "PATCH") {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };

    const client = new NotionClient({ token: "ntn_test", fetchFn });
    const config = loadConfig({
      PUBLIC_BASE_URL: BASE,
      JWT_SIGNING_KEY: "test-signing-key-test-signing-key-0123456789",
      OWNER_PASSWORD_HASH: await hashPassword(PASSWORD),
      STORE_BACKEND: "memory",
      READ_ONLY: "false",
    });
    const app = createApp(config, new InMemoryStore(), client);
    const { tokens: t } = await fullFlow(app);

    const listRes = await mcpCall(app, t.access_token, "tools/list");
    const toolNames = ((await listRes.json()) as any).result.tools.map((x: any) => x.name).sort();
    expect(toolNames).toEqual([
      "notion_create_page",
      "notion_fetch",
      "notion_query_data_source",
      "notion_search",
      "notion_update_page",
      "whoami",
    ]);

    const createRes = await mcpCall(app, t.access_token, "tools/call", {
      name: "notion_create_page",
      arguments: {
        parent_id: DS_ID,
        title: "新しい記憶",
        markdown: "## メモ\nテスト内容",
      },
    });
    const created = JSON.parse(((await createRes.json()) as any).result.content[0].text);
    expect(created).toMatchObject({ id: PAGE_ID, title: "新しい記憶" });

    // タイトルプロパティ名 "名前" を自動検出してセットしていること
    const createReq = posted.find((p) => p.url.endsWith("/pages") && p.method === "POST")?.body as any;
    expect(createReq.properties["名前"].title[0].text.content).toBe("新しい記憶");
    expect(createReq.children).toHaveLength(2);

    const updateRes = await mcpCall(app, t.access_token, "tools/call", {
      name: "notion_update_page",
      arguments: {
        page_id: PAGE_ID,
        title: "更新後の記憶",
        append_markdown: "- 追記項目",
      },
    });
    const updated = JSON.parse(((await updateRes.json()) as any).result.content[0].text);
    expect(updated).toMatchObject({ id: PAGE_ID, updated_properties: true, appended_blocks: 1 });
  });
});

describe("getAllBlockChildren の並列取得", () => {
  const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

  it("同時実行数を 3 に制限しつつ全子ブロックを取得し、順序を保つ", async () => {
    let active = 0;
    let maxActive = 0;
    const fetchFn: typeof fetch = async (input) => {
      const m = /blocks\/([^/]+)\/children/.exec(String(input))!;
      const id = m[1]!;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      const results =
        id === uuid(0)
          ? Array.from({ length: 8 }, (_, i) => ({ id: uuid(i + 1), type: "paragraph", has_children: true }))
          : [{ id: `leaf-of-${id}`, type: "paragraph", has_children: false }];
      return new Response(JSON.stringify({ results, has_more: false, next_cursor: null }), { status: 200 });
    };
    const client = new NotionClient({ token: "t", fetchFn });
    const blocks = await client.getAllBlockChildren(uuid(0));
    expect(blocks.map((b) => b.id)).toEqual(Array.from({ length: 8 }, (_, i) => uuid(i + 1)));
    expect(blocks.every((b) => b.children?.length === 1)).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxActive).toBeGreaterThan(1);
  });

  it("API 呼び出し総数が上限 (200) を超えたら展開を打ち切る", async () => {
    let calls = 0;
    const fetchFn: typeof fetch = async () => {
      calls++;
      const results = Array.from({ length: 5 }, (_, i) => ({ id: uuid(calls * 10 + i), type: "paragraph", has_children: true }));
      return new Response(JSON.stringify({ results, has_more: false, next_cursor: null }), { status: 200 });
    };
    const client = new NotionClient({ token: "t", fetchFn });
    await client.getAllBlockChildren(uuid(0), 0, 10);
    expect(calls).toBe(200);
  });
});

describe("NotionClient のタイムアウトとリトライ", () => {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });
  const noSleep = async () => undefined;

  it("429 を Retry-After に従ってリトライし成功する (書き込みでも)", async () => {
    const waits: number[] = [];
    let n = 0;
    const client = new NotionClient({
      token: "t",
      sleepFn: async (ms) => void waits.push(ms),
      fetchFn: async () => (++n === 1 ? json(429, { code: "rate_limited", message: "slow" }, { "retry-after": "2" }) : json(200, { id: "x" })),
    });
    await expect(client.appendBlockChildren("11111111-1111-1111-1111-111111111111", [{}])).resolves.toBeUndefined();
    expect(n).toBe(2);
    expect(waits).toEqual([2000]);
  });

  it("503 は GET ならリトライ、書き込み (PATCH) ではリトライしない", async () => {
    let n = 0;
    const get = new NotionClient({
      token: "t",
      sleepFn: noSleep,
      fetchFn: async () => (++n < 3 ? json(503, { message: "down" }) : json(200, { object: "page", id: "p" })),
    });
    await expect(get.getPage("11111111-1111-1111-1111-111111111111")).resolves.toMatchObject({ id: "p" });
    expect(n).toBe(3);

    let m = 0;
    const patch = new NotionClient({
      token: "t",
      sleepFn: noSleep,
      fetchFn: async () => (++m, json(503, { message: "down" })),
    });
    await expect(patch.appendBlockChildren("11111111-1111-1111-1111-111111111111", [{}])).rejects.toThrow("503");
    expect(m).toBe(1);
  });

  it("応答しない Notion はタイムアウトで分かりやすいエラーになる", async () => {
    const hang: typeof fetch = (_i, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
      });
    const client = new NotionClient({ token: "t", fetchFn: hang, timeoutMs: 20, maxRetries: 1, sleepFn: noSleep });
    await expect(client.getPage("11111111-1111-1111-1111-111111111111")).rejects.toThrow("timed out after 20ms");
  });

  it("書き込みはタイムアウトしてもリトライしない", async () => {
    let n = 0;
    const hang: typeof fetch = (_i, init) =>
      new Promise((_res, rej) => {
        n++;
        init?.signal?.addEventListener("abort", () => rej(init.signal!.reason));
      });
    const client = new NotionClient({ token: "t", fetchFn: hang, timeoutMs: 20, sleepFn: noSleep });
    await expect(client.appendBlockChildren("11111111-1111-1111-1111-111111111111", [{}])).rejects.toThrow("timed out");
    expect(n).toBe(1);
  });
});

describe("events: ツール結果の観察情報", () => {
  const PAGE_ID = "11111111-1111-1111-1111-111111111111";

  async function appWith(fetchFn: typeof fetch) {
    const config = loadConfig({
      PUBLIC_BASE_URL: BASE,
      JWT_SIGNING_KEY: "test-signing-key-test-signing-key-0123456789",
      OWNER_PASSWORD_HASH: await hashPassword(PASSWORD),
      STORE_BACKEND: "memory",
    });
    const store = new InMemoryStore();
    const app = createApp(config, store, new NotionClient({ token: "ntn_secret", fetchFn, sleepFn: async () => undefined }));
    const { tokens } = await fullFlow(app);
    const lastMcp = () => store.events.filter((e) => e.endpoint === "/mcp").at(-1)!;
    return { app, tokens, lastMcp };
  }

  it("成功時は result_bytes、失敗時は tool_error を記録する (トークンは含まない)", async () => {
    const ok = await appWith(async () => new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null })));
    await mcpCall(ok.app, ok.tokens.access_token, "tools/call", { name: "notion_search", arguments: {} });
    expect(ok.lastMcp().result_bytes).toBeGreaterThan(0);
    expect(ok.lastMcp().tool_error).toBeUndefined();

    const ng = await appWith(async () => new Response(JSON.stringify({ code: "unauthorized", message: "API token is invalid." }), { status: 401 }));
    await mcpCall(ng.app, ng.tokens.access_token, "tools/call", { name: "notion_fetch", arguments: { page_id: PAGE_ID } });
    expect(ng.lastMcp().tool_error).toContain("401 unauthorized");
    expect(JSON.stringify(ng.lastMcp())).not.toContain("ntn_secret");
  });
});
