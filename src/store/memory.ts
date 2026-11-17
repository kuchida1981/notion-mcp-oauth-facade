import type { ClientRecord, CodeRecord, EventRecord, RefreshRecord, Store } from "./types.js";

export class InMemoryStore implements Store {
  clients = new Map<string, ClientRecord>();
  codes = new Map<string, CodeRecord>();
  refresh = new Map<string, RefreshRecord>();
  revokedJti = new Map<string, number>();
  events: EventRecord[] = [];

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
}
