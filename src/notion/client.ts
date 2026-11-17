import { blocksToMarkdown, richTextToMarkdown, type NotionBlock, type NotionRichText } from "./markdown.js";

const UUID_32_RE = /^[0-9a-f]{32}$/i;
const UUID_DASHED_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Notion の ID を検証し、標準 UUID (ハイフン付き小文字) に正規化する */
export function normalizeNotionUuid(id: string): string {
  const trimmed = id.trim();
  if (UUID_DASHED_RE.test(trimmed)) return trimmed.toLowerCase();
  if (UUID_32_RE.test(trimmed)) {
    const h = trimmed.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  throw new Error("Invalid Notion ID: must be a UUID");
}

export class NotionApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(`Notion API error (${status} ${code}): ${message}`);
  }
}

export interface NotionClientOptions {
  token: string;
  apiVersion?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface NotionPage {
  object: "page";
  id: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  properties?: Record<string, Record<string, unknown>>;
}

export interface NotionSearchResult {
  results: Array<Record<string, unknown>>;
  next_cursor: string | null;
  has_more: boolean;
}

export function extractObjectTitle(obj: Record<string, unknown>): string {
  // page の場合は properties 内の type === "title" を探す
  const props = obj.properties as Record<string, Record<string, unknown>> | undefined;
  if (props) {
    for (const val of Object.values(props)) {
      if (val?.type === "title" && Array.isArray(val.title)) {
        const t = richTextToMarkdown(val.title as NotionRichText[]);
        if (t) return t;
      }
    }
  }
  // database / data_source の場合は title 配列がトップレベルにある
  if (Array.isArray(obj.title)) {
    const t = richTextToMarkdown(obj.title as NotionRichText[]);
    if (t) return t;
  }
  return "(untitled)";
}

export function summarizePageProperties(
  properties: Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown> {
  if (!properties) return {};
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(properties)) {
    const t = prop?.type as string | undefined;
    if (!t) continue;
    switch (t) {
      case "title":
        out[key] = richTextToMarkdown(prop.title as NotionRichText[]);
        break;
      case "rich_text":
        out[key] = richTextToMarkdown(prop.rich_text as NotionRichText[]);
        break;
      case "select":
        out[key] = (prop.select as { name?: string } | null)?.name ?? null;
        break;
      case "status":
        out[key] = (prop.status as { name?: string } | null)?.name ?? null;
        break;
      case "multi_select":
        out[key] = Array.isArray(prop.multi_select)
          ? (prop.multi_select as Array<{ name?: string }>).map((s) => s.name)
          : [];
        break;
      case "date":
        out[key] = prop.date ?? null;
        break;
      case "checkbox":
        out[key] = prop.checkbox ?? false;
        break;
      case "number":
        out[key] = prop.number ?? null;
        break;
      case "url":
        out[key] = prop.url ?? null;
        break;
      case "email":
        out[key] = prop.email ?? null;
        break;
      case "relation":
        out[key] = Array.isArray(prop.relation)
          ? (prop.relation as Array<{ id?: string }>).map((r) => r.id)
          : [];
        break;
      default:
        break;
    }
  }
  return out;
}

export class NotionClient {
  private readonly token: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: NotionClientOptions) {
    this.token = opts.token;
    this.apiVersion = opts.apiVersion ?? "2025-09-03";
    this.baseUrl = (opts.baseUrl ?? "https://api.notion.com/v1").replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Notion-Version": this.apiVersion,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }

    if (!res.ok) {
      const code = typeof parsed.code === "string" ? parsed.code : "unknown_error";
      const message = typeof parsed.message === "string" ? parsed.message : res.statusText || "request failed";
      throw new NotionApiError(res.status, code, message);
    }

    return parsed as T;
  }

  async search(params: {
    query?: string;
    objectType?: "page" | "data_source";
    pageSize?: number;
    startCursor?: string;
  }): Promise<NotionSearchResult> {
    const body: Record<string, unknown> = {};
    if (params.query !== undefined) body.query = params.query;
    if (params.objectType) {
      body.filter = { property: "object", value: params.objectType };
    }
    if (params.pageSize !== undefined) body.page_size = params.pageSize;
    if (params.startCursor) body.start_cursor = params.startCursor;
    return this.request<NotionSearchResult>("POST", "/search", body);
  }

  async getPage(pageId: string): Promise<NotionPage> {
    const id = normalizeNotionUuid(pageId);
    return this.request<NotionPage>("GET", `/pages/${id}`);
  }

  async getAllBlockChildren(blockId: string, depth = 0, maxDepth = 3): Promise<NotionBlock[]> {
    const id = normalizeNotionUuid(blockId);
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;

    do {
      const qs = new URLSearchParams({ page_size: "100" });
      if (cursor) qs.set("start_cursor", cursor);
      const res = await this.request<{
        results: NotionBlock[];
        next_cursor: string | null;
        has_more: boolean;
      }>("GET", `/blocks/${id}/children?${qs.toString()}`);

      for (const b of res.results ?? []) {
        if (b.has_children && depth < maxDepth) {
          b.children = await this.getAllBlockChildren(b.id, depth + 1, maxDepth);
        }
        blocks.push(b);
      }
      cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    } while (cursor);

    return blocks;
  }

  async fetchPageMarkdown(pageId: string): Promise<{
    id: string;
    title: string;
    url?: string;
    last_edited_time?: string;
    properties: Record<string, unknown>;
    markdown: string;
  }> {
    const page = await this.getPage(pageId);
    const blocks = await this.getAllBlockChildren(page.id);
    return {
      id: page.id,
      title: extractObjectTitle(page as unknown as Record<string, unknown>),
      url: page.url,
      last_edited_time: page.last_edited_time,
      properties: summarizePageProperties(page.properties),
      markdown: blocksToMarkdown(blocks),
    };
  }

  async queryDataSource(params: {
    dataSourceId: string;
    filter?: Record<string, unknown>;
    sorts?: Array<Record<string, unknown>>;
    pageSize?: number;
    startCursor?: string;
  }): Promise<NotionSearchResult> {
    const id = normalizeNotionUuid(params.dataSourceId);
    const body: Record<string, unknown> = {};
    if (params.filter) body.filter = params.filter;
    if (params.sorts) body.sorts = params.sorts;
    if (params.pageSize !== undefined) body.page_size = params.pageSize;
    if (params.startCursor) body.start_cursor = params.startCursor;

    try {
      return await this.request<NotionSearchResult>("POST", `/data_sources/${id}/query`, body);
    } catch (err) {
      // database_id が渡された場合、GET /databases/{id} から data_sources[0].id を解決してフォールバック
      if (err instanceof NotionApiError && err.status === 404) {
        const db = await this.request<{ data_sources?: Array<{ id?: string }> }>("GET", `/databases/${id}`);
        const resolvedId = db.data_sources?.[0]?.id;
        if (resolvedId) {
          return this.request<NotionSearchResult>("POST", `/data_sources/${resolvedId}/query`, body);
        }
      }
      throw err;
    }
  }
}
