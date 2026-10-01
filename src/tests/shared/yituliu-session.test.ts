// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readYituliuSession, yituliuTargetKey, yituliuRequest, logoutYituliu, resolveYituliuClient, completeYituliuCallback, YITULIU_API } from '@/shared/storage/yituliu-session';
import { requestSyncProvider, readActiveSyncProvider, activateSyncProvider, isSyncProviderTargetActive } from '@/shared/storage/sync-provider-activation';

function save(id = 'session-a', uid = '1') {
  const session = { id, uid, name: 'test', accessToken: 'access-test', refreshToken: 'refresh-test', expiresAt: Date.now() + 3600_000 };
  localStorage.setItem('v3-yituliu-session', JSON.stringify(session));
  return session;
}
beforeEach(() => { vi.stubGlobal('location', new URL('https://endfield.hsyhhssyy.net/')); });
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

describe('一图流会话隔离', () => {
  it('选择后保持pending，必须确认当前账号后激活', () => {
    save();
    requestSyncProvider('yituliu');
    expect(readActiveSyncProvider()).toBeNull();
    const target = yituliuTargetKey()!;
    expect(activateSyncProvider('yituliu', target)).toBe(true);
    expect(isSyncProviderTargetActive('yituliu', target)).toBe(true);
    save('session-b', '2');
    expect(isSyncProviderTargetActive('yituliu', yituliuTargetKey()!)).toBe(false);
  });
  it('请求带Bearer，HTTP200业务失败也拒绝', async () => {
    save();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 10004, data: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(yituliuRequest('session-a', '/oauth2/config/quota')).rejects.toMatchObject({ code: 10004 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${YITULIU_API}/oauth2/config/quota`);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access-test');
  });
  it('请求进行中切换账号，不接收旧账号响应', async () => {
    save();
    vi.stubGlobal('fetch', vi.fn(async () => {
      save('session-b', '2');
      return new Response(JSON.stringify({ code: 200, data: { value: 'old' } }));
    }));
    await expect(yituliuRequest('session-a', '/oauth2/config/quota')).rejects.toThrow('已变更');
    expect(readYituliuSession()?.uid).toBe('2');
  });
  it('退出先清本地会话，吊销失败不会恢复登录', async () => {
    save();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(logoutYituliu()).rejects.toThrow('offline');
    expect(readYituliuSession()).toBeNull();
  });
});

describe('一图流令牌刷新', () => {
  it('刷新响应省略refresh token时保留原值，不发送client_secret', async () => {
    const session = save();
    localStorage.setItem('v3-yituliu-session', JSON.stringify({ ...session, expiresAt: 0 }));
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, task: () => Promise<unknown>) => task() } });
    const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
      if (input.endsWith('/token')) {
        const form = new URLSearchParams(init.body as URLSearchParams);
        expect(form.get('refresh_token')).toBe('refresh-test');
        expect(form.has('client_secret')).toBe(false);
        return new Response(JSON.stringify({ code: 200, data: { access_token: 'new-access', expires_in: 7200 } }));
      }
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer new-access');
      return new Response(JSON.stringify({ code: 200, data: { usedBytes: 0 } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await yituliuRequest(session.id, '/oauth2/config/quota');
    expect(readYituliuSession()?.refreshToken).toBe('refresh-test');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('被吊销的会话不再继续访问配置接口', async () => {
    const session = save();
    localStorage.setItem('v3-yituliu-session', JSON.stringify({ ...session, expiresAt: 0 }));
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, task: () => Promise<unknown>) => task() } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 90009, data: null })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(yituliuRequest(session.id, '/oauth2/config/quota')).rejects.toMatchObject({ code: 90009 });
    expect(readYituliuSession()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe('一图流按登记站点选择客户端', () => {
  const testOrigin = 'https://industrialplanner-refactor-cf01ab.coder-page.hsyhhssyy.net';
  it('精确匹配正式和测试Origin，拒绝未知域名、协议和端口', () => {
    expect(resolveYituliuClient('https://endfield.hsyhhssyy.net')?.clientId).toBe('cl_7ec711c2b0f7a626bd56fdbe');
    expect(resolveYituliuClient(testOrigin)).toEqual({ clientId: 'cl_ee3b24942378a6b3f7d0e117', redirectUri: `${testOrigin}/oauth/callback` });
    for (const origin of ['http://endfield.hsyhhssyy.net', `${testOrigin}:8443`, `${testOrigin}.example.com`, 'http://localhost:5173']) {
      expect(resolveYituliuClient(origin)).toBeNull();
    }
  });
  it('同一用户的同步目标随客户端隔离', () => {
    save();
    const production = yituliuTargetKey();
    vi.stubGlobal('location', new URL(testOrigin));
    expect(yituliuTargetKey()).not.toBe(production);
    expect(yituliuTargetKey()).toContain('cl_ee3b24942378a6b3f7d0e117');
  });
  it('测试站刷新和吊销使用测试clientId', async () => {
    vi.stubGlobal('location', new URL(testOrigin));
    const session = save();
    localStorage.setItem('v3-yituliu-session', JSON.stringify({ ...session, expiresAt: 0 }));
    vi.stubGlobal('navigator', { locks: { request: async (_key: string, task: () => Promise<unknown>) => task() } });
    const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
      if (input.endsWith('/token') || input.endsWith('/revoke')) {
        expect(new URLSearchParams(init.body as URLSearchParams).get('client_id')).toBe('cl_ee3b24942378a6b3f7d0e117');
      }
      return new Response(JSON.stringify({ code: 200, data: input.endsWith('/token') ? { access_token: 'test-access', expires_in: 7200 } : {} }));
    });
    vi.stubGlobal('fetch', fetchMock);
    await yituliuRequest(session.id, '/oauth2/config/quota');
    await logoutYituliu();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it('测试回调只在登记路径处理，并以同一客户端和redirectUri换取令牌', async () => {
    const state = 'yituliu.callback-test';
    localStorage.setItem(`v3-yituliu-login:${state}`, JSON.stringify({ verifier: 'test-verifier', createdAt: Date.now(), priorSessionId: null,
      clientId: 'cl_ee3b24942378a6b3f7d0e117', redirectUri: `${testOrigin}/oauth/callback` }));
    const fetchMock = vi.fn(async (input: string, init: RequestInit) => {
      if (input.endsWith('/token')) {
        const form = new URLSearchParams(init.body as URLSearchParams);
        expect(form.get('client_id')).toBe('cl_ee3b24942378a6b3f7d0e117');
        expect(form.get('redirect_uri')).toBe(`${testOrigin}/oauth/callback`);
        return new Response(JSON.stringify({ code: 200, data: { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 7200 } }));
      }
      return new Response(JSON.stringify({ code: 200, data: { uid: '123', nickname: 'test' } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('history', { state: null, replaceState: vi.fn() });
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    try {
      vi.stubGlobal('location', new URL(`${testOrigin}/?state=${state}&code=test-code`));
      await completeYituliuCallback();
      expect(fetchMock).not.toHaveBeenCalled();
      vi.stubGlobal('location', new URL(`${testOrigin}/oauth/callback?state=${state}&code=test-code`));
      await completeYituliuCallback();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(readYituliuSession()?.uid).toBe('123');
      expect(localStorage.getItem(`v3-yituliu-login:${state}`)).toBeNull();
    } finally { close.mockRestore(); }
  });
});
