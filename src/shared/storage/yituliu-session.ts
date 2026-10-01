/** 一图流公共客户端参数，不含客户端密钥。 */
export const YITULIU_API = 'https://auth.yituliu.cn';
export const YITULIU_CLIENT_ID = 'cl_7ec711c2b0f7a626bd56fdbe';
export const YITULIU_REDIRECT_URI = 'https://endfield.hsyhhssyy.net/';
export interface YituliuClientConfig {
  readonly clientId: string;
  readonly redirectUri: string;
}

/** 只允许明确登记的 HTTPS Origin；不对未知 host 回退到正式客户端。 */
export function resolveYituliuClient(origin = location.origin): YituliuClientConfig | null {
  switch (origin) {
    case 'https://endfield.hsyhhssyy.net':
      return { clientId: YITULIU_CLIENT_ID, redirectUri: YITULIU_REDIRECT_URI };
    case 'https://industrialplanner-refactor-cf01ab.coder-page.hsyhhssyy.net':
      return { clientId: 'cl_ee3b24942378a6b3f7d0e117',
        redirectUri: 'https://industrialplanner-refactor-cf01ab.coder-page.hsyhhssyy.net/oauth/callback' };
    default: return null;
  }
}

function requireYituliuClient(): YituliuClientConfig {
  const client = resolveYituliuClient();
  if (client === null) throw new Error('当前站点未登记一图流 OAuth 客户端');
  return client;
}

const SESSION_KEY = 'v3-yituliu-session';
const TRANSACTION_PREFIX = 'v3-yituliu-login:';
const listeners = new Set<() => void>();

export interface YituliuSession {
  readonly id: string;
  readonly uid: string;
  readonly name: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

export class YituliuApiError extends Error {
  constructor(public readonly status: number, public readonly code: number) {
    super(code === 10004
      ? "一图流账号共享存储空间不足，本地数据已保留，请释放空间或申请提额。"
      : [80001, 90009].includes(code)
        ? "一图流登录已失效，请重新登录。"
        : `一图流请求失败（HTTP ${status}，code ${code}）`);
    this.name = 'YituliuApiError';
  }
}

export function readYituliuSession(): YituliuSession | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    if (!isRecord(value) || !['id', 'uid', 'name', 'accessToken', 'refreshToken'].every(key => typeof value[key] === 'string' && value[key] !== '')
      || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return null;
    return value as unknown as YituliuSession;
  } catch { return null; }
}

export function yituliuTargetKey(session = readYituliuSession()): string | null {
  const client = resolveYituliuClient();
  return session === null || client === null ? null : JSON.stringify(['yituliu', YITULIU_API, client.clientId, session.uid]);
}

export function subscribeToYituliuSession(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => { if (event.key === SESSION_KEY || event.key === null) listener(); };
  globalThis.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); globalThis.removeEventListener('storage', onStorage); };
}

function saveSession(session: YituliuSession | null): void {
  if (session === null) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  for (const listener of listeners) listener();
}

export function assertYituliuSession(id: string): YituliuSession {
  const session = readYituliuSession();
  if (session === null || session.id !== id) throw new Error('一图流登录已变更，请重新同步');
  return session;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${YITULIU_API}${path}`, {
    ...init, credentials: 'omit', referrerPolicy: 'no-referrer',
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  const body: unknown = await response.json().catch(() => { throw new YituliuApiError(response.status, -1); });
  if (!response.ok || !isRecord(body) || body.code !== 200) {
    throw new YituliuApiError(response.status, isRecord(body) && typeof body.code === 'number' ? body.code : -1);
  }
  return body.data;
}

async function formRequest(path: string, fields: Record<string, string>): Promise<unknown> {
  return request(path, { method: 'POST', body: new URLSearchParams(fields) });
}

function tokenData(value: unknown): { access: string; expires: number; refresh: string | null } {
  if (!isRecord(value) || typeof value.access_token !== 'string' || value.access_token === ''
    || typeof value.expires_in !== 'number' || !Number.isFinite(value.expires_in) || value.expires_in <= 0) {
    throw new Error('一图流令牌响应无效');
  }
  return { access: value.access_token, expires: Date.now() + value.expires_in * 1000,
    refresh: typeof value.refresh_token === 'string' && value.refresh_token !== '' ? value.refresh_token : null };
}

async function accessToken(id: string): Promise<string> {
  const client = requireYituliuClient();
  const current = assertYituliuSession(id);
  if (current.expiresAt > Date.now() + 60_000) return current.accessToken;
  if (!navigator.locks) throw new Error('浏览器不支持安全协调登录刷新');
  return navigator.locks.request('yituliu-token-refresh', async () => {
    const session = assertYituliuSession(id);
    if (session.expiresAt > Date.now() + 60_000) return session.accessToken;
    try {
      const token = tokenData(await formRequest('/oauth2/token', {
        grant_type: 'refresh_token', client_id: client.clientId, refresh_token: session.refreshToken,
      }));
      assertYituliuSession(id);
      saveSession({ ...session, accessToken: token.access, expiresAt: token.expires });
      return token.access;
    } catch (error) {
      if (error instanceof YituliuApiError && [80001, 90009].includes(error.code) && readYituliuSession()?.id === id) saveSession(null);
      throw error;
    }
  });
}

export async function yituliuRequest(id: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const token = await accessToken(id);
  assertYituliuSession(id);
  try {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const data = await request(path, { ...init, headers });
    assertYituliuSession(id);
    return data;
  } catch (error) {
    if (error instanceof YituliuApiError && [80001, 90009].includes(error.code) && readYituliuSession()?.id === id) saveSession(null);
    throw error;
  }
}

export async function logoutYituliu(): Promise<void> {
  const session = readYituliuSession();
  saveSession(null);
  if (session !== null) await formRequest('/oauth2/revoke', { client_id: requireYituliuClient().clientId, token: session.refreshToken });
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/** 先同步打开窗口，避免 PKCE 异步计算后触发弹窗拦截。 */
export async function startYituliuLogin(): Promise<void> {
  const client = requireYituliuClient();
  if (location.pathname !== '/' && location.pathname !== new URL(client.redirectUri).pathname) {
    throw new Error('请从当前站点首页发起一图流登录');
  }
  if (!navigator.locks) throw new Error('浏览器不支持安全协调登录');
  const popup = window.open('about:blank', '_blank', 'popup,width=520,height=720');
  if (popup === null) throw new Error('登录窗口被拦截，请允许弹出窗口');
  const state = `yituliu.${base64url(crypto.getRandomValues(new Uint8Array(32)))}`;
  const key = TRANSACTION_PREFIX + state;
  try {
    popup.opener = null;
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(64)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const priorSessionId = readYituliuSession()?.id ?? null;
    localStorage.setItem(key, JSON.stringify({ verifier, createdAt: Date.now(), priorSessionId, clientId: client.clientId, redirectUri: client.redirectUri }));
    const url = new URL('/oauth2/authorize', YITULIU_API);
    url.search = new URLSearchParams({ response_type: 'code', client_id: client.clientId,
      redirect_uri: client.redirectUri, scope: 'user.read', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    popup.location.href = url.href;
    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const interval = window.setInterval(() => {
        const session = readYituliuSession();
        if (session !== null && session.id === state) { clearInterval(interval); resolve(); }
        else if (popup.closed || Date.now() - started > 600_000) { clearInterval(interval); reject(new Error('登录已取消或超时')); }
      }, 300);
    });
  } finally {
    localStorage.removeItem(key);
    popup.close();
  }
}

let callbackCompletion: Promise<void> | null = null;
/** 只消费本工具发起且仍有效的一图流回调；不接管其他 URL 参数。 */
export function completeYituliuCallback(): Promise<void> {
  if (callbackCompletion !== null) return callbackCompletion;
  const url = new URL(location.href);
  const state = url.searchParams.get('state');
  const client = resolveYituliuClient(url.origin);
  if (!state?.startsWith('yituliu.') || client === null || url.pathname !== new URL(client.redirectUri).pathname) return Promise.resolve();
  const key = TRANSACTION_PREFIX + state;
  const stored = localStorage.getItem(key);
  if (stored === null) return Promise.resolve();
  const code = url.searchParams.get('code');
  const denied = url.searchParams.has('error');
  for (const name of ['code', 'state', 'error', 'error_description']) url.searchParams.delete(name);
  history.replaceState(history.state, '', url.href);
  callbackCompletion = (async () => {
    try {
      const transaction: unknown = JSON.parse(stored);
      if (!isRecord(transaction) || transaction.clientId !== client.clientId || transaction.redirectUri !== client.redirectUri
        || typeof transaction.verifier !== 'string' || typeof transaction.createdAt !== 'number'
        || Date.now() - transaction.createdAt > 600_000 || denied || !code || code.length > 4096) throw new Error('一图流授权已取消或过期');
      const token = tokenData(await formRequest('/oauth2/token', { grant_type: 'authorization_code', client_id: client.clientId,
        code, redirect_uri: client.redirectUri, code_verifier: transaction.verifier }));
      if (token.refresh === null) throw new Error('一图流未返回刷新令牌');
      const user = await request('/oauth2/userinfo', { headers: { Authorization: `Bearer ${token.access}` } });
      if (!isRecord(user) || !['string', 'number'].includes(typeof user.uid)) throw new Error('一图流用户信息无效');
      if (localStorage.getItem(key) !== stored || (readYituliuSession()?.id ?? null) !== transaction.priorSessionId) throw new Error('登录会话已变更');
      saveSession({ id: state, uid: String(user.uid), name: String(user.nickname || user.userName || user.uid),
        accessToken: token.access, refreshToken: token.refresh, expiresAt: token.expires });
    } finally { localStorage.removeItem(key); window.close(); }
  })();
  return callbackCompletion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
