import { call } from '@decky/api';

import { hideLogo, showLogo } from './logoControl';

export type PerfectTarget = 'hero' | 'grid_l';

const key = (appId: number, target: PerfectTarget) => `perfect_${target}_${appId}`;

const withTimeout = async <T>(operation: Promise<T>, timeout = 4000): Promise<T> => {
  let timer: number | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error('PA_ERROR_OPERATION_TIMEOUT')), timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
};

const safeCall = async <T>(fallback: T, method: string, ...args: any[]): Promise<T> => {
  try {
    return await withTimeout(call<any, T>(method, ...args));
  } catch (_) {
    return fallback;
  }
};

type PerfectSourceInfo = {
  exists?: boolean;
  size?: number;
  mime?: string;
  chunk_size?: number;
};

type PerfectSourceSave = {
  saved?: boolean;
  existing?: boolean;
  source?: string;
};

const sourceReads = new Map<string, Promise<string>>();
const sourceWrites = new Map<string, Promise<PerfectSourceSave>>();

/**
 * The untouched artwork a Perfect composition was built from.
 * Kept once, so re-editing never composes on top of an already composed picture.
 */
export const getPerfectSource = async (appId: number, target: PerfectTarget): Promise<string> => {
  const id = key(appId, target);
  const pending = sourceReads.get(id);
  if (pending) return pending;

  const read = (async () => {
    const info = await safeCall<PerfectSourceInfo>({ exists: false }, 'get_perfect_source_info', appId, target);
    if (!info.exists || !info.size) return '';
    const chunkSize = Math.max(3, Number(info.chunk_size || 384 * 1024));
    const parts: string[] = [];
    for (let offset = 0; offset < Number(info.size); offset += chunkSize) {
      const part = await safeCall('', 'read_perfect_source_chunk', appId, target, offset);
      if (!part) return '';
      parts.push(String(part));
    }
    return `data:${info.mime || 'image/jpeg'};base64,${parts.join('')}`;
  })();

  sourceReads.set(id, read);
  try {
    return await read;
  } finally {
    if (sourceReads.get(id) === read) sourceReads.delete(id);
  }
};

export const savePerfectSource = async (appId: number, target: PerfectTarget, data: string, ext: string) =>
  safeCall({ saved: false }, 'save_perfect_source', appId, target, data, ext);

export const preservePerfectSource = async (
  appId: number,
  target: PerfectTarget,
  candidates: string[],
  allowCustom: boolean
): Promise<PerfectSourceSave> => {
  const id = key(appId, target);
  const pending = sourceWrites.get(id);
  if (pending) return pending;

  const write = withTimeout(
    call<[number, PerfectTarget, string[], boolean], PerfectSourceSave>(
      'preserve_perfect_source',
      appId,
      target,
      candidates,
      allowCustom
    ),
    25_000
  ).catch(() => ({ saved: false }));

  sourceWrites.set(id, write);
  try {
    return await write;
  } finally {
    if (sourceWrites.get(id) === write) sourceWrites.delete(id);
  }
};

export const isPerfectArtwork = async (appId: number, target: PerfectTarget): Promise<boolean> =>
  Boolean(await safeCall(false, 'get_setting', key(appId, target), false));

/**
 * A Perfect Hero already carries the logo, so Steam's separate logo layer is
 * switched off to avoid showing it twice.
 */
export const markPerfectArtwork = async (appId: number, target: PerfectTarget, withLogo: boolean) => {
  /*
    Hide Steam's separate layer before marking the operation complete. The old order could
    remain forever on a stalled settings write and never reach `hideLogo`, even though the
    composed hero had already been applied.
  */
  const logoHidden = withLogo ? await hideLogo(appId) : false;
  await safeCall(false, 'set_setting', key(appId, target), true);
  return logoHidden;
};

/** Back to Steam's own artwork plus the separate logo. */
export const clearPerfectArtwork = async (appId: number, target: PerfectTarget) => {
  sourceReads.delete(key(appId, target));
  sourceWrites.delete(key(appId, target));
  await safeCall(false, 'delete_setting', key(appId, target));
  await safeCall(false, 'clear_perfect_source', appId, target);
  if (target === 'hero') await showLogo(appId);
};
