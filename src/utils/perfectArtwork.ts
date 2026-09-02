import { call } from '@decky/api';

import { hideLogo, showLogo } from './logoControl';

export type PerfectTarget = 'hero' | 'grid_l';

const key = (appId: number, target: PerfectTarget) => `perfect_${target}_${appId}`;

const safeCall = async <T>(fallback: T, method: string, ...args: any[]): Promise<T> => {
  try {
    return await call<any, T>(method, ...args);
  } catch (_) {
    return fallback;
  }
};

/**
 * The untouched artwork a Perfect composition was built from.
 * Kept once, so re-editing never composes on top of an already composed picture.
 */
export const getPerfectSource = async (appId: number, target: PerfectTarget): Promise<string> =>
  String(await safeCall('', 'get_perfect_source', appId, target) ?? '');

export const savePerfectSource = async (appId: number, target: PerfectTarget, data: string, ext: string) =>
  safeCall({ saved: false }, 'save_perfect_source', appId, target, data, ext);

export const isPerfectArtwork = async (appId: number, target: PerfectTarget): Promise<boolean> =>
  Boolean(await safeCall(false, 'get_setting', key(appId, target), false));

/**
 * A Perfect Hero already carries the logo, so Steam's separate logo layer is
 * switched off to avoid showing it twice.
 */
export const markPerfectArtwork = async (appId: number, target: PerfectTarget, withLogo: boolean) => {
  await safeCall(false, 'set_setting', key(appId, target), true);
  /*
    The composition carries the logo, so Steam's own logo layer goes down to the smallest
    size it accepts. This used to be limited to the hero; a Perfect Banner showed the logo
    twice.
  */
  if (withLogo) await hideLogo(appId);
};

/** Back to Steam's own artwork plus the separate logo. */
export const clearPerfectArtwork = async (appId: number, target: PerfectTarget) => {
  await safeCall(false, 'delete_setting', key(appId, target));
  await safeCall(false, 'clear_perfect_source', appId, target);
  if (target === 'hero') await showLogo(appId);
};
