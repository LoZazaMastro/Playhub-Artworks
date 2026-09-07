import { call } from '@decky/api';

import getAppOverview from './getAppOverview';
import getAppDetails from './getAppDetails';
import getCustomLogoPosition from './getCustomLogoPosition';
import t from './i18n';
import log from './log';

/**
 * Logo handling goes through Steam's own API.
 *
 * All SteamUI and backend calls are bounded here. A missing or half-initialized internal API
 * must not keep the Perfect Hero save alive forever and block the following artwork search.
 */

export const DEFAULT_LOGO_POSITION: LogoPosition = {
  pinnedPosition: 'BottomLeft',
  nWidthPct: 50,
  nHeightPct: 50,
};

/** Steam draws nothing at this size, which is how the bulk job has always hidden a logo. */
const MIN_LOGO_POSITION: LogoPosition = {
  pinnedPosition: 'BottomLeft',
  nWidthPct: 0.01,
  nHeightPct: 0.01,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const VALID_ANCHORS: LogoPinPositions[] = ['BottomLeft', 'UpperLeft', 'CenterCenter', 'UpperCenter', 'BottomCenter'];

const withTimeout = async <T>(operation: PromiseLike<T> | T, timeout = 3500): Promise<T> => {
  let timer: number | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<T>((_resolve, reject) => {
        timer = window.setTimeout(() => reject(new Error('PA_ERROR_OPERATION_TIMEOUT')), timeout);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
};

export const normalizeLogoPosition = (value?: Partial<LogoPosition> | null): LogoPosition => ({
  pinnedPosition: VALID_ANCHORS.some((anchor) => anchor === value?.pinnedPosition)
    ? value!.pinnedPosition as LogoPinPositions
    : DEFAULT_LOGO_POSITION.pinnedPosition,
  // 0.01 is the "hidden" size Steam accepts, so it has to stay reachable.
  nWidthPct: clamp(Number(value?.nWidthPct ?? DEFAULT_LOGO_POSITION.nWidthPct), 0.01, 100),
  nHeightPct: clamp(Number(value?.nHeightPct ?? DEFAULT_LOGO_POSITION.nHeightPct), 0.01, 100),
});

export const readLogoPosition = async (appId: number): Promise<LogoPosition> => {
  try {
    const stored = await withTimeout(getCustomLogoPosition(appId));
    if (stored) return normalizeLogoPosition(stored);
  } catch (error) {
    log('logo position read timed out or failed', error);
  }
  try {
    const details = await withTimeout(getAppDetails(appId));
    return normalizeLogoPosition((details as any)?.libraryAssets?.logoPosition);
  } catch (_) {
    return { ...DEFAULT_LOGO_POSITION };
  }
};

/** Writes the position Steam itself reads, so the header updates straight away. */
export const writeLogoPosition = async (appId: number, position: LogoPosition): Promise<boolean> => {
  const value = normalizeLogoPosition(position);
  const apps = (window as any).SteamClient?.Apps;
  const direct = apps?.SetCustomLogoPositionForApp;

  if (typeof direct === 'function') {
    try {
      await withTimeout(direct.call(
        apps,
        appId,
        JSON.stringify({ nVersion: 1, logoPosition: value })
      ));
      return true;
    } catch (error) {
      log('direct logo position write failed', error);
    }
  }

  try {
    const app = await withTimeout(getAppOverview(appId));
    const save = (window as any).appDetailsStore?.SaveCustomLogoPosition;
    if (app && typeof save === 'function') {
      await withTimeout(save.call((window as any).appDetailsStore, app, value));
      return true;
    }
  } catch (error) {
    log('fallback logo position write failed', error);
  }

  return false;
};

export const resetLogoPosition = async (appId: number) => {
  try {
    const app = await withTimeout(getAppOverview(appId));
    const store = (window as any).appDetailsStore;
    const clear = store?.ClearCustomLogoPosition;
    if (app && typeof clear === 'function') await withTimeout(clear.call(store, app));
  } catch (error) {
    log('logo position reset failed', error);
  }
};

const safeCall = async <T>(fallback: T, method: string, ...args: any[]): Promise<T> => {
  try {
    return await withTimeout(call<any, T>(method, ...args), 4000);
  } catch (_) {
    return fallback;
  }
};

export const isLogoHidden = async (appId: number): Promise<boolean> =>
  Boolean(await safeCall(false, 'get_setting', `logo_hidden_${appId}`, false));

/**
 * Hiding shrinks the logo to nothing instead of touching the artwork file, so it is
 * fully reversible and matches what the bulk Perfect Hero job already does.
 */
export const hideLogo = async (appId: number): Promise<boolean> => {
  const wasHidden = await isLogoHidden(appId);
  if (!wasHidden) {
    const current = await readLogoPosition(appId);
    await safeCall(false, 'set_setting', `logo_position_backup_${appId}`, current);
  }

  const hidden = await writeLogoPosition(appId, MIN_LOGO_POSITION);
  if (hidden) await safeCall(false, 'set_setting', `logo_hidden_${appId}`, true);
  return hidden;
};

export const showLogo = async (appId: number): Promise<boolean> => {
  const stored = await safeCall<Partial<LogoPosition> | null>(null, 'get_setting', `logo_position_backup_${appId}`, null);
  const shown = await writeLogoPosition(appId, normalizeLogoPosition(stored ?? DEFAULT_LOGO_POSITION));
  if (shown) {
    await safeCall(false, 'delete_setting', `logo_position_backup_${appId}`);
    await safeCall(false, 'set_setting', `logo_hidden_${appId}`, false);
  }
  return shown;
};

/*
  No CSS, no canvas, no measured geometry.

  Free composition lives in the Perfect Hero editor; the separate Steam logo uses Steam's
  own anchor plus width and height percentages.
*/

/** The anchors Steam accepts, in the order the editor cycles through them. */
export const LOGO_ANCHORS: LogoPinPositions[] = [
  'BottomLeft',
  'UpperLeft',
  'UpperCenter',
  'CenterCenter',
  'BottomCenter',
];

export const LOGO_ANCHOR_LABEL: Record<string, string> = {
  BottomLeft: t('PA_ANCHOR_BOTTOM_LEFT', 'Bottom left'),
  UpperLeft: t('PA_ANCHOR_TOP_LEFT', 'Top left'),
  UpperCenter: t('PA_ANCHOR_TOP_CENTER', 'Top center'),
  CenterCenter: t('PA_ANCHOR_CENTER', 'Center'),
  BottomCenter: t('PA_ANCHOR_BOTTOM_CENTER', 'Bottom center'),
};

export const nextLogoAnchor = (current: LogoPinPositions): LogoPinPositions => {
  const index = LOGO_ANCHORS.indexOf(current);
  return LOGO_ANCHORS[(index + 1) % LOGO_ANCHORS.length];
};
