import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const SCRYPT_KEYLEN = 64;

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export const sha256Base64Url = (s: string): string =>
  createHash("sha256").update(s).digest("base64url");

/** 256bit ランダム値 (base64url) */
export const randomToken = (): string => randomBytes(32).toString("base64url");

/** イベントログ用: トークンの SHA-256 hex 先頭8文字 */
export const hashPrefix = (token: string): string => sha256Hex(token).slice(0, 8);

const scryptAsync = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(password, salt, SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key))),
  );

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  if (expected.length === 0) return false;
  const actual = await scryptAsync(password, salt);
  // 長さが違うと timingSafeEqual が例外を投げるため先に確認
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** PKCE S256: BASE64URL(SHA256(verifier)) === challenge */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  const a = Buffer.from(sha256Base64Url(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}
