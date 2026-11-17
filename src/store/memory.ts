import type { ClientRecord, CodeRecord, EventRecord, RefreshRecord, Store } from "./types.js";

export class InMemoryStore implements Store {
  clients = new Map<string, ClientRecord>();
  codes = new Map<string, CodeRecord>();
  refresh = new Map<string, RefreshRecord>();
  revokedJti = new Map<string, number>();
  events: EventRecord[] = [];
  rateLimits = new Map<string, { count: number; resetAt: number }>();
  authAttempts = new Map<string, { failures: number; lockedUntil: number }>();

  async putClient(c: ClientRecord) {
    this.clients.set(c.client_id, { ...c });
  }
  async getClient(id: string) {
    const c = this.clients.get(id);
    return c ? { ...c } : null;
  }

  async putCode(c: CodeRecord) {
    this.codes.set(c.code_hash, { ...c });
  }
  async consumeCode(codeHash: string, now: number) {
    const c = this.codes.get(codeHash);
    if (!c || c.used || c.expires_at <= now) return null;
    const before = { ...c };
    c.used = true;
    return before;
  }

  async putRefresh(r: RefreshRecord) {
    this.refresh.set(r.token_hash, { ...r });
  }
  async getRefresh(h: string) {
    const r = this.refresh.get(h);
    return r ? { ...r } : null;
  }
  async updateRefresh(h: string, patch: Partial<RefreshRecord>) {
    const r = this.refresh.get(h);
    if (r) Object.assign(r, patch);
  }

  async revokeJti(jti: string, expSec: number) {
    this.revokedJti.set(jti, expSec);
  }
  async isJtiRevoked(jti: string) {
    return this.revokedJti.has(jti);
  }

  async addEvent(e: EventRecord) {
    this.events.push(e);
  }

  async checkRateLimit(key: string, limit: number, windowMs: number, now: number) {
    const cur = this.rateLimits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.rateLimits.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, retryAfterSec: 0 };
    }
    if (cur.count >= limit) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) };
    }
    cur.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  async getAuthLockout(key: string, now: number) {
    const cur = this.authAttempts.get(key);
    if (!cur || cur.lockedUntil <= now) return { locked: false, retryAfterSec: 0 };
    return { locked: true, retryAfterSec: Math.max(1, Math.ceil((cur.lockedUntil - now) / 1000)) };
  }

  async recordAuthFailure(key: string, maxAttempts: number, lockoutMs: number, now: number) {
    const cur = this.authAttempts.get(key);
    const failures = (!cur || (cur.lockedUntil > 0 && cur.lockedUntil <= now) ? 0 : cur.failures) + 1;
    if (failures >= maxAttempts) {
      const lockedUntil = now + lockoutMs;
      this.authAttempts.set(key, { failures, lockedUntil });
      return { locked: true, remainingAttempts: 0, retryAfterSec: Math.ceil(lockoutMs / 1000) };
    }
    this.authAttempts.set(key, { failures, lockedUntil: 0 });
    return { locked: false, remainingAttempts: maxAttempts - failures, retryAfterSec: 0 };
  }

  async clearAuthFailure(key: string) {
    this.authAttempts.delete(key);
  }
}
