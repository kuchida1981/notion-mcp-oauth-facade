export interface ClientRecord {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  created_at: number;
}

export interface CodeRecord {
  code_hash: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  used: boolean;
  /** epoch ms */
  expires_at: number;
}

export interface RefreshRecord {
  token_hash: string;
  client_id: string;
  resource: string;
  scope: string;
  revoked: boolean;
  /** epoch ms */
  created_at: number;
  last_used_at: number;
  expires_at: number;
}

export interface EventRecord {
  timestamp: string;
  endpoint: string;
  method: string;
  grant_type?: string;
  client_id?: string;
  token_hash_prefix?: string;
  redirect_uri?: string | string[];
  resource?: string;
  status_code: number;
  error?: string;
  /** Firestore TTL 用 (作成から30日後) */
  expire_at: Date;
}

export interface Store {
  putClient(c: ClientRecord): Promise<void>;
  getClient(clientId: string): Promise<ClientRecord | null>;

  putCode(c: CodeRecord): Promise<void>;
  /**
   * 認可コードを原子的に消費する。存在し、未使用かつ未期限切れなら used=true にして
   * 更新前のレコードを返す。それ以外は null。
   */
  consumeCode(codeHash: string, now: number): Promise<CodeRecord | null>;

  putRefresh(r: RefreshRecord): Promise<void>;
  getRefresh(tokenHash: string): Promise<RefreshRecord | null>;
  updateRefresh(tokenHash: string, patch: Partial<RefreshRecord>): Promise<void>;

  revokeJti(jti: string, expSec: number): Promise<void>;
  isJtiRevoked(jti: string): Promise<boolean>;

  addEvent(e: EventRecord): Promise<void>;
}
