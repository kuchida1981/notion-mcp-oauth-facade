import { SignJWT, jwtVerify, decodeJwt, type JWTPayload } from "jose";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";

export interface AccessClaims extends JWTPayload {
  sub: string;
  client_id: string;
  jti: string;
  iss: string;
  aud: string;
  exp: number;
}

const keyOf = (config: Config) => new TextEncoder().encode(config.jwtSigningKey);

export const resourceUrl = (config: Config) => `${config.publicBaseUrl}/mcp`;

export async function signAccessToken(
  config: Config,
  params: { clientId: string; resource: string; scope: string },
): Promise<string> {
  return new SignJWT({ client_id: params.clientId, scope: params.scope })
    .setProtectedHeader({ alg: "HS256", kid: config.jwtKeyId, typ: "at+jwt" })
    .setIssuer(config.publicBaseUrl)
    .setAudience(params.resource)
    .setSubject("owner")
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${config.accessTtl}s`)
    .sign(keyOf(config));
}

/** 署名・exp・iss・aud を検証する。失敗時は例外。 */
export async function verifyAccessToken(config: Config, token: string): Promise<AccessClaims> {
  const { payload, protectedHeader } = await jwtVerify(token, keyOf(config), {
    algorithms: ["HS256"],
    issuer: config.publicBaseUrl,
    audience: resourceUrl(config),
  });
  if (protectedHeader.kid !== config.jwtKeyId) throw new Error("kid mismatch");
  if (typeof payload.jti !== "string" || typeof payload.client_id !== "string" || typeof payload.exp !== "number") {
    throw new Error("missing claims");
  }
  return payload as AccessClaims;
}

/** 失効用: 署名を検証したうえで jti / exp / client_id を取り出す。期限切れは検証失敗扱い。 */
export async function readVerifiedJti(
  config: Config,
  token: string,
): Promise<{ jti: string; exp: number; clientId?: string } | null> {
  try {
    await jwtVerify(token, keyOf(config), { algorithms: ["HS256"], issuer: config.publicBaseUrl });
    const p = decodeJwt(token);
    if (typeof p.jti !== "string" || typeof p.exp !== "number") return null;
    return { jti: p.jti, exp: p.exp, clientId: typeof p.client_id === "string" ? p.client_id : undefined };
  } catch {
    return null;
  }
}

const SESSION_TTL = "24h";
const SESSION_AUDIENCE = "mcp-session";

/** ストア不要の署名付き MCP セッション ID (JWT)。アクセストークンとは aud で区別する */
export async function signSessionId(config: Config, clientId: string): Promise<string> {
  return new SignJWT({ client_id: clientId })
    .setProtectedHeader({ alg: "HS256", kid: config.jwtKeyId, typ: "mcp-session+jwt" })
    .setIssuer(config.publicBaseUrl)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(keyOf(config));
}

/** 署名・期限・aud・client_id 一致を検証する。有効なら true */
export async function verifySessionId(config: Config, sessionId: string, clientId: string): Promise<boolean> {
  try {
    const { payload, protectedHeader } = await jwtVerify(sessionId, keyOf(config), {
      algorithms: ["HS256"],
      issuer: config.publicBaseUrl,
      audience: SESSION_AUDIENCE,
    });
    return protectedHeader.kid === config.jwtKeyId && payload.client_id === clientId;
  } catch {
    return false;
  }
}
