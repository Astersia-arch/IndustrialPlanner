/** 自动持久化失败必须显式告知用户；不改变命令式存储 API 的抛错语义。 */
let failed = false;
const listeners = new Set<() => void>();

export function hasStorageFailure(): boolean {
  return failed;
}

export function subscribeToStorageFailures(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function reportStorageFailure(source: string, error: unknown): void {
  console.error(`Local persistence failed (${source}).`, error);
  // 提示保留到重新加载：一次写入成功不能证明其他未保存内容也已恢复。
  if (failed) return;
  failed = true;
  for (const listener of listeners) {
    try { listener(); } catch (listenerError) {
      console.error("Storage failure notification failed.", listenerError);
    }
  }
}

/** 仅供自动保存等无返回值的副作用；需要确认保存成功的操作必须直接 await。 */
export function runStorageEffect(source: string, effect: () => unknown): void {
  try {
    void Promise.resolve(effect()).catch(error => reportStorageFailure(source, error));
  } catch (error) {
    reportStorageFailure(source, error);
  }
}
