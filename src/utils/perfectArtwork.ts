import { artworkPayloadUrl, readArtworkPayload } from './artworkTransfer';
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
    try {
      const payload = await readArtworkPayload('', { perfectSource: { appId, target }, staticOnly: true });
      return payload ? artworkPayloadUrl(payload) : '';
    } catch (_) { return ''; }
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

// Legacy compositions have no withLogo metadata. Keep their separate logo hidden
// until they are removed, so a remaining baked logo is not drawn twice.
const hasPerfectLogoComposition = async (appId: number): Promise<boolean> => {
  for (const target of ['hero', 'grid_l'] as PerfectTarget[]) {
    if (!await safeCall(true, 'get_setting', key(appId, target), false)) continue;
    const info = await safeCall<{ withLogo?: boolean } | null>(null, 'get_setting', `perfect_${target}_info_${appId}`, null);
    if (info?.withLogo !== false) return true;
  }
  return false;
};

/**
 * A Perfect composition already carries the logo, so Steam's separate logo layer is
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
  await safeCall(false, 'set_setting', `perfect_${target}_info_${appId}`, { version: 118, origin: 'manual', withLogo });
  if (withLogo) return logoHidden;
  // Another Perfect artwork may still carry the logo after this one drops it.
  if (await hasPerfectLogoComposition(appId)) return await hideLogo(appId);
  await showLogo(appId);
  return false;
};

/** Back to Steam's own artwork plus the separate logo. */
export const clearPerfectArtwork = async (appId: number, target: PerfectTarget) => {
  sourceReads.delete(key(appId, target));
  sourceWrites.delete(key(appId, target));
  await safeCall(false, 'delete_setting', key(appId, target));
  await safeCall(false, 'clear_perfect_source', appId, target);
  await safeCall(false, 'delete_setting', `perfect_${target}_info_${appId}`);
  if (target === 'hero') {
    await safeCall(false, 'delete_setting', `zazamastro_hero_${appId}`);
  }
  if (!await hasPerfectLogoComposition(appId)) await showLogo(appId);
};
