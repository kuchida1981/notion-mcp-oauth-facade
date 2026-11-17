import { Firestore, Timestamp } from "@google-cloud/firestore";
import type { ClientRecord, CodeRecord, EventRecord, RefreshRecord, Store } from "./types.js";

/**
 * Firestore 実装。TTL ポリシーは各コレクションの `expire_at` フィールドに設定する。
 * 名前付き DB は databaseId で指定する。
 */
export class FirestoreStore implements Store {
  private db: Firestore;

  constructor(databaseId: string) {
    this.db = new Firestore({ databaseId });
  }

  private col(name: string) {
    return this.db.collection(name);
  }

  async putClient(c: ClientRecord) {
    await this.col("clients").doc(c.client_id).set(strip(c));
  }
  async getClient(id: string) {
    const s = await this.col("clients").doc(id).get();
    return s.exists ? (s.data() as ClientRecord) : null;
  }

  async putCode(c: CodeRecord) {
    await this.col("codes")
      .doc(c.code_hash)
      .set({ ...c, expire_at: Timestamp.fromMillis(c.expires_at) });
  }
  async consumeCode(codeHash: string, now: number) {
    const ref = this.col("codes").doc(codeHash);
    return this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return null;
      const { expire_at: _ignored, ...rec } = s.data() as CodeRecord & { expire_at?: unknown };
      if (rec.used || rec.expires_at <= now) return null;
      tx.update(ref, { used: true });
      return rec as CodeRecord;
    });
  }

  async putRefresh(r: RefreshRecord) {
    await this.col("refresh_tokens")
      .doc(r.token_hash)
      .set({ ...r, expire_at: Timestamp.fromMillis(r.expires_at) });
  }
  async getRefresh(h: string) {
    const s = await this.col("refresh_tokens").doc(h).get();
    if (!s.exists) return null;
    const { expire_at: _ignored, ...rec } = s.data() as RefreshRecord & { expire_at?: unknown };
    return rec as RefreshRecord;
  }
  async updateRefresh(h: string, patch: Partial<RefreshRecord>) {
    const upd: Record<string, unknown> = { ...patch };
    if (patch.expires_at !== undefined) upd.expire_at = Timestamp.fromMillis(patch.expires_at);
    await this.col("refresh_tokens").doc(h).update(upd);
  }

  async revokeJti(jti: string, expSec: number) {
    await this.col("revoked_jti")
      .doc(jti)
      .set({ jti, exp: expSec, expire_at: Timestamp.fromMillis(expSec * 1000) });
  }
  async isJtiRevoked(jti: string) {
    return (await this.col("revoked_jti").doc(jti).get()).exists;
  }

  async addEvent(e: EventRecord) {
    await this.col("events").add({
      ...strip(e),
      timestamp: Timestamp.fromDate(new Date(e.timestamp)),
      expire_at: Timestamp.fromDate(e.expire_at),
    });
  }

  async checkRateLimit(key: string, limit: number, windowMs: number, now: number) {
    const ref = this.col("rate_limits").doc(key);
    return this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const data = s.exists ? (s.data() as { count: number; reset_at: number }) : undefined;
      if (!data || data.reset_at <= now) {
        const resetAt = now + windowMs;
        tx.set(ref, { count: 1, reset_at: resetAt, expire_at: Timestamp.fromMillis(resetAt) });
        return { allowed: true, retryAfterSec: 0 };
      }
      if (data.count >= limit) {
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((data.reset_at - now) / 1000)) };
      }
      tx.update(ref, { count: data.count + 1 });
      return { allowed: true, retryAfterSec: 0 };
    });
  }

  async getAuthLockout(key: string, now: number) {
    const s = await this.col("auth_attempts").doc(key).get();
    if (!s.exists) return { locked: false, retryAfterSec: 0 };
    const data = s.data() as { locked_until?: number };
    if (!data.locked_until || data.locked_until <= now) return { locked: false, retryAfterSec: 0 };
    return { locked: true, retryAfterSec: Math.max(1, Math.ceil((data.locked_until - now) / 1000)) };
  }

  async recordAuthFailure(key: string, maxAttempts: number, lockoutMs: number, now: number) {
    const ref = this.col("auth_attempts").doc(key);
    return this.db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const data = s.exists ? (s.data() as { failures?: number; locked_until?: number }) : undefined;
      const resetPrev = !data || (data.locked_until !== undefined && data.locked_until > 0 && data.locked_until <= now);
      const failures = (resetPrev ? 0 : (data?.failures ?? 0)) + 1;
      if (failures >= maxAttempts) {
        const lockedUntil = now + lockoutMs;
        tx.set(ref, {
          failures,
          locked_until: lockedUntil,
          expire_at: Timestamp.fromMillis(lockedUntil),
        });
        return { locked: true, remainingAttempts: 0, retryAfterSec: Math.ceil(lockoutMs / 1000) };
      }
      tx.set(ref, {
        failures,
        locked_until: 0,
        expire_at: Timestamp.fromMillis(now + lockoutMs),
      });
      return { locked: false, remainingAttempts: maxAttempts - failures, retryAfterSec: 0 };
    });
  }

  async clearAuthFailure(key: string) {
    await this.col("auth_attempts").doc(key).delete();
  }
}

/** Firestore は undefined を拒否するため除去する */
function strip<T extends object>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
