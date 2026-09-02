import { call } from '@decky/api';

import getAppOverview from './getAppOverview';
import getAppDetails from './getAppDetails';
import getCustomLogoPosition from './getCustomLogoPosition';

/**
 * Logo handling goes through Steam's own API.
 *
 * An earlier version injected CSS over `appDetailsHeaderClasses.TitleImageContainer`.
 * Those class names are not exposed on every Steam build, and even when they are, Steam
 * re-renders the header from its own stored position and wins. The result was a logo that
 * neither moved nor hid. Steam already stores a logo position per app (anchor plus width and
 * height percentages), so that is what the editor edits now, and Steam repaints itself.
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
    const stored = await getCustomLogoPosition(appId);
    if (stored) return normalizeLogoPosition(stored);
    const details = await getAppDetails(appId);
    const fallback = (details as any)?.libraryAssets?.logoPosition;
    return normalizeLogoPosition(fallback);
  } catch (_) {
    return { ...DEFAULT_LOGO_POSITION };
  }
};

/** Writes the position Steam itself reads, so the header updates straight away. */
export const writeLogoPosition = async (appId: number, position: LogoPosition) => {
  const value = normalizeLogoPosition(position);
  try {
    await Promise.resolve(SteamClient.Apps.SetCustomLogoPositionForApp(
      appId,
      JSON.stringify({ nVersion: 1, logoPosition: value })
    ));
    return;
  } catch (_) {
    // Older builds only expose the store method.
  }
  const app = await getAppOverview(appId);
  if (app) await window.appDetailsStore.SaveCustomLogoPosition(app, value);
};

export const resetLogoPosition = async (appId: number) => {
  const app = await getAppOverview(appId);
  if (!app) return;
  await (window.appDetailsStore as unknown as {
    ClearCustomLogoPosition: (app: AppStoreAppOverview) => any;
  }).ClearCustomLogoPosition(app);
};

const safeCall = async <T>(fallback: T, method: string, ...args: any[]): Promise<T> => {
  try {
    return await call<any, T>(method, ...args);
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
export const hideLogo = async (appId: number) => {
  const current = await readLogoPosition(appId);
  await safeCall(false, 'set_setting', `logo_position_backup_${appId}`, current);
  await writeLogoPosition(appId, MIN_LOGO_POSITION);
  await safeCall(false, 'set_setting', `logo_hidden_${appId}`, true);
};

export const showLogo = async (appId: number) => {
  const stored = await safeCall<Partial<LogoPosition> | null>(null, 'get_setting', `logo_position_backup_${appId}`, null);
  await writeLogoPosition(appId, normalizeLogoPosition(stored ?? DEFAULT_LOGO_POSITION));
  await safeCall(false, 'delete_setting', `logo_position_backup_${appId}`);
  await safeCall(false, 'set_setting', `logo_hidden_${appId}`, false);
};

/*
  No CSS, no canvas, no measured geometry.

  Free logo placement was baked into a canvas cut to the header capsule's aspect and
  Steam was told to draw it full-size. It never landed where the editor showed it, and
  the layout CSS it needed fought Steam's own header. All of that is gone: the logo is
  positioned the way Steam positions it - an anchor plus a width and height percentage -
  and Steam repaints itself. Free composition lives in the Perfect Hero editor, which is
  the right place for it.
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
  BottomLeft: 'In basso a sinistra',
  UpperLeft: 'In alto a sinistra',
  UpperCenter: 'In alto al centro',
  CenterCenter: 'Al centro',
  BottomCenter: 'In basso al centro',
};

export const nextLogoAnchor = (current: LogoPinPositions): LogoPinPositions => {
  const index = LOGO_ANCHORS.indexOf(current);
  return LOGO_ANCHORS[(index + 1) % LOGO_ANCHORS.length];
};
