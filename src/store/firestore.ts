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
}

/** Firestore は undefined を拒否するため除去する */
function strip<T extends object>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}
