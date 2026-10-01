/** 当前快照的本地资源上限；不是服务端配额声明。 */
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const MAX_ENCODED_BYTES = 8 * 1024 * 1024;

export interface CompressedSnapshot {
  readonly format: 1;
  readonly encoding: 'gzip+base64';
  readonly data: string;
}

async function boundedBytes(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > limit) throw new Error('同步快照超过本地处理上限');
      chunks.push(result.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function compressSnapshot(value: unknown): Promise<CompressedSnapshot> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.length > MAX_SNAPSHOT_BYTES) throw new Error('同步快照超过本地处理上限');
  const zipped = await boundedBytes(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')), MAX_ENCODED_BYTES * 3 / 4);
  let binary = '';
  for (let offset = 0; offset < zipped.length; offset += 8192) binary += String.fromCharCode(...zipped.subarray(offset, offset + 8192));
  return { format: 1, encoding: 'gzip+base64', data: btoa(binary) };
}

export async function decompressSnapshot(value: unknown): Promise<unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('同步压缩格式无效');
  const envelope = value as Partial<CompressedSnapshot>;
  if (envelope.format !== 1 || envelope.encoding !== 'gzip+base64' || typeof envelope.data !== 'string'
    || envelope.data.length > MAX_ENCODED_BYTES || envelope.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(envelope.data)) {
    throw new Error('同步压缩格式不支持或已损坏');
  }
  const bytes = Uint8Array.from(atob(envelope.data), char => char.charCodeAt(0));
  const decoded = await boundedBytes(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')), MAX_SNAPSHOT_BYTES);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded)) as unknown;
}
