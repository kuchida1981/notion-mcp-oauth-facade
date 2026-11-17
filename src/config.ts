import * as z from "zod/v4";

const bool = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const int = (def: number) => z.coerce.number().int().positive().default(def);

const schema = z.object({
  PORT: int(8080),
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .transform((v) => v.replace(/\/+$/, "")),
  JWT_SIGNING_KEY: z.string().min(1),
  JWT_KEY_ID: z.string().min(1).default("v1"),
  OWNER_PASSWORD_HASH: z
    .string()
    .regex(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/i, "scrypt$<salt_hex>$<hash_hex> 形式であること"),
  ACCESS_TTL: int(300),
  REFRESH_IDLE_TTL: int(7776000),
  REFRESH_MAX_TTL: int(31536000),
  ROTATE_REFRESH: bool,
  STORE_BACKEND: z.enum(["firestore", "memory"]).default("firestore"),
  FIRESTORE_DATABASE_ID: z.string().min(1).default("(default)"),
  ALLOW_LOCALHOST_REDIRECT: bool,
  NOTION_TOKEN: z.string().min(1).optional(),
  NOTION_API_VERSION: z.string().min(1).default("2025-09-03"),
  MCP_JSON_RESPONSE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  READ_ONLY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export interface Config {
  port: number;
  publicBaseUrl: string;
  jwtSigningKey: string;
  jwtKeyId: string;
  ownerPasswordHash: string;
  accessTtl: number;
  refreshIdleTtl: number;
  refreshMaxTtl: number;
  rotateRefresh: boolean;
  storeBackend: "firestore" | "memory";
  firestoreDatabaseId: string;
  allowLocalhostRedirect: boolean;
  notionToken?: string;
  notionApiVersion: string;
  readOnly: boolean;
  /** true: /mcp の POST に application/json で応答 / false: text/event-stream (SSE) で応答 */
  mcpJsonResponse: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // 空文字は未設定扱いにする
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ""),
  );
  const r = schema.safeParse(cleaned);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`環境変数が不正です: ${msg}`);
  }
  const e = r.data;
  return {
    port: e.PORT,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    jwtSigningKey: e.JWT_SIGNING_KEY,
    jwtKeyId: e.JWT_KEY_ID,
    ownerPasswordHash: e.OWNER_PASSWORD_HASH,
    accessTtl: e.ACCESS_TTL,
    refreshIdleTtl: e.REFRESH_IDLE_TTL,
    refreshMaxTtl: e.REFRESH_MAX_TTL,
    rotateRefresh: e.ROTATE_REFRESH,
    storeBackend: e.STORE_BACKEND,
    firestoreDatabaseId: e.FIRESTORE_DATABASE_ID,
    allowLocalhostRedirect: e.ALLOW_LOCALHOST_REDIRECT,
    notionToken: e.NOTION_TOKEN,
    notionApiVersion: e.NOTION_API_VERSION,
    readOnly: e.READ_ONLY,
    mcpJsonResponse: e.MCP_JSON_RESPONSE,
  };
}
