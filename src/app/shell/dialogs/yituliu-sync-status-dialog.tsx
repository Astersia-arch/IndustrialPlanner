import { useEffect, useMemo, useState } from 'react';
import { makeAutoObservable, runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import type { AppHost } from '@/app/host/app-host';
import type { DialogStateReadWrite } from '@/app/state/state-impl';
import type { SyncContract } from '@/domain/sync';
import { activateSyncProvider, isSyncProviderTargetActive, requestSyncProvider } from '@/shared/storage/sync-provider-activation';
import { readYituliuSession, yituliuTargetKey, startYituliuLogin, logoutYituliu, subscribeToYituliuSession, yituliuRequest } from '@/shared/storage/yituliu-session';
import { DialogShell } from '@/app/shell/shared/dialog-shell';
import { cm } from '@/app/shell/shared/css-module-class';
import styles from './settings-dialog.module.scss';

export const YituliuSyncStatusDialog = observer(function YituliuSyncStatusDialog({ sync, compactMobileLayout, onClose, t }: {
  sync: SyncContract;
  compactMobileLayout: boolean;
  onClose: () => void;
  t: AppHost['actions']['translate'];
}) {
  const dialog = useMemo(() => makeAutoObservable<DialogStateReadWrite>({ visible: true, maximized: false,
    offsetX: 0, offsetY: 0, width: 620, height: 460, activeTab: null }), []);
  const [session, setSession] = useState(readYituliuSession);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<{ usedBytes: number; limitBytes: number } | null>(null);
  useEffect(() => subscribeToYituliuSession(() => setSession(readYituliuSession())), []);
  const sessionId = session?.id;
  useEffect(() => {
    setQuota(null);
    if (sessionId === undefined) return;
    let active = true;
    const controller = new AbortController();
    void yituliuRequest(sessionId, '/oauth2/config/quota', { signal: controller.signal }).then(value => {
      if (!active) return;
      if (typeof value !== 'object' || value === null || !('usedBytes' in value) || !('limitBytes' in value)
        || typeof value.usedBytes !== 'number' || typeof value.limitBytes !== 'number') throw new Error(t('yituliu.quotaFailed'));
      setQuota({ usedBytes: value.usedBytes, limitBytes: value.limitBytes });
    }).catch(() => { if (active) setError(t('yituliu.quotaFailed')); });
    return () => { active = false; controller.abort(); };
  }, [sessionId, sync.state.status.lastUploadAt, t]);
  const target = yituliuTargetKey(session);
  const enabled = target !== null && isSyncProviderTargetActive('yituliu', target) && sync.state.settings.enabled;
  const run = async (task: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await task(); } catch (cause) { setError(cause instanceof Error ? cause.message : t('yituliu.failed')); }
    finally { setBusy(false); setSession(readYituliuSession()); }
  };
  return <DialogShell dialogState={dialog} dialogKey="yituliu-sync-status" titleId="yituliu-sync-title"
    title={t('settingsOption.syncProvider.yituliu')} closeTitle={t('action.close')}
    maximizeTitle={t('dialog.maximize')} restoreTitle={t('dialog.restore')} compactMobileLayout={compactMobileLayout}
    onClose={onClose} onToggleMaximized={() => runInAction(() => { dialog.maximized = !dialog.maximized; })}
    onOffsetChange={(x, y) => runInAction(() => { dialog.offsetX = x; dialog.offsetY = y; })}
    onResize={(width, height) => runInAction(() => { dialog.width = width; dialog.height = height; })}
    bodyClassName={cm(styles, 'sync-status-dialog-body')}>
    <div className={cm(styles, 'sync-status-content', 'yituliu-status-content')} data-yituliu-sync-status-dialog>
      <section className={cm(styles, 'sync-status-section')}>
        <p>{t('yituliu.scope')}</p>
        {session === null ? <button disabled={busy} onClick={() => void run(startYituliuLogin)}>{t(busy ? 'cloudflareStatus.loginInProgress' : 'yituliu.login')}</button> : <>
          <p>{t('cloudflareStatus.loggedInAs')} <strong>{session.name}</strong></p>
          <div className={cm(styles, 'sync-status-actions')}>
            <button disabled={busy || enabled} onClick={() => void run(async () => {
              const currentTarget = yituliuTargetKey();
              if (currentTarget === null || !activateSyncProvider('yituliu', currentTarget)) throw new Error(t('yituliu.failed'));
            })}>{t(enabled ? 'yituliu.enabled' : 'cloudflareStatus.useAccountAndEnable')}</button>
            <button disabled={busy} onClick={() => void run(async () => {
              if (!requestSyncProvider('yituliu')) throw new Error(t('yituliu.failed'));
              await logoutYituliu();
            })}>{t('cloudflareStatus.logout')}</button>
          </div>
        </>}
      </section>
      {quota !== null ? <section className={cm(styles, 'sync-status-section')}>
        <h3>{t('yituliu.quota')}</h3><p>{(quota.usedBytes / 1024).toFixed(2)} / {(quota.limitBytes / 1024).toFixed(2)} KiB</p>
      </section> : null}
      <section className={cm(styles, 'sync-status-section')}>
        <p>{t(enabled ? `yituliu.phase.${sync.state.status.phase}` : 'yituliu.disabled')}</p>
        <button disabled={busy || !enabled || sync.state.status.phase === 'uploading' || sync.state.status.phase === 'downloading'}
          onClick={() => void run(() => sync.actions.syncNow())}>{t('yituliu.syncNow')}</button>
        {enabled ? <button disabled={busy} onClick={() => void run(async () => {
          if (!requestSyncProvider('yituliu')) throw new Error(t('yituliu.failed'));
        })}>{t('yituliu.stop')}</button> : null}
      </section>
      {error || (enabled && sync.state.status.lastError) ? <p role="alert">{error || sync.state.status.lastError}</p> : null}
    </div>
  </DialogShell>;
});
