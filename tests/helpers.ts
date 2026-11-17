import { createHash, randomBytes } from "node:crypto";
import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { hashPassword } from "../src/crypto.js";
import { InMemoryStore } from "../src/store/memory.js";

export const BASE = "https://facade.example.com";
export const PASSWORD = "correct horse battery staple";
export const REDIRECT = "https://gemini.google.com/oauth/callback";

let cachedHash: string | undefined;

export async function setup(overrides: Record<string, string> = {}) {
  cachedHash ??= await hashPassword(PASSWORD);
  const config: Config = loadConfig({
    PUBLIC_BASE_URL: BASE,
    JWT_SIGNING_KEY: "test-signing-key-test-signing-key-0123456789",
    OWNER_PASSWORD_HASH: cachedHash,
    STORE_BACKEND: "memory",
    ...overrides,
  });
  const store = new InMemoryStore();
  const app = createApp(config, store);
  return { app, config, store };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

export const form = (data: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(data).toString(),
});

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function register(app: App, redirectUri = REDIRECT) {
  const res = await app.request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "test" }),
  });
  const body = (await res.json()) as { client_id: string };
  return { res, clientId: body.client_id };
}

export function authParams(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-123",
    ...extra,
  };
}

/** /authorize (POST) で認可コードを取得する */
export async function getCode(app: App, clientId: string, challenge: string) {
  const res = await app.request("/authorize", form({ ...authParams(clientId, challenge), password: PASSWORD }));
  const loc = res.headers.get("location");
  const url = loc ? new URL(loc) : undefined;
  return { res, code: url?.searchParams.get("code") ?? undefined, state: url?.searchParams.get("state") };
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/** register -> authorize -> token まで一気に実行 */
export async function fullFlow(app: App) {
  const { clientId } = await register(app);
  const { verifier, challenge } = pkce();
  const { code } = await getCode(app, clientId, challenge);
  const res = await app.request(
    "/token",
    form({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }),
  );
  const tokens = (await res.json()) as TokenResponse;
  return { clientId, verifier, challenge, code: code!, tokens, res };
}

export const refreshReq = (clientId: string, refreshToken: string) =>
  form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });

let rpcId = 0;
export function mcpCall(app: App, token: string | undefined, method: string, params: unknown = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.request("/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
}
