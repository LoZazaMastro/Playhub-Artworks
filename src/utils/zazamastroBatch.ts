import { call, fetchNoCors } from '@decky/api';

import t, { localizeError } from '../utils/i18n';
import { ArtworkProviderId, ASSET_TYPE, DIMENSIONS, MIMES, STYLES } from '../constants';
import { SGDB_API_BASE } from '../hooks/useSGDB';

import getAppOverview from './getAppOverview';
import { artworkSources } from './artworkSources';
import { artworkPayloadUrl, readArtworkPayload, readArtworkSource } from './artworkTransfer';
import getCurrentSteamUserId from './getCurrentSteamUserId';
import { exactTitleMatch, uniqueAssets } from './searchResults';
import {
  canvasToBase64,
  fetchWithCancellation,
  loadSafeImage,
  releaseCanvas,
  releaseImage,
  withCompositionLock,
  MAX_SOURCE_DIMENSION,
  MAX_SOURCE_PIXELS,
} from './imageSafety';
import log from './log';
import { hideLogo, showLogo } from './logoControl';
import { normalizeArtworkPayload } from './normalizeArtworkPayload';
import {
  clearDerivedCoverBackup,
  clearSteamArtworkSafely,
  runSteamArtworkTransaction,
} from './derivedCover';

type CoverBatchKind = 'squareReplace' | 'squareMissing' | 'portraitReplace' | 'portraitMissing';
type HeroBatchKind = 'perfectHeroReplace' | 'perfectHeroMissing';
type ProcessableBatchKind = CoverBatchKind | HeroBatchKind | 'banner920' | 'missingLogos' | 'logoFix' | 'resetArtwork' | 'perfectHeroReset';
type BatchKind = Exclude<ProcessableBatchKind, 'perfectHeroReset'> | 'fixAll';
export type ZazaBatchKind = BatchKind;

export interface ZazaBatchProgress {
  total: number;
  processed: number;
  changed: number;
  skipped: number;
  failed: number;
  /** Old Perfect Heroes removed during an explicit regeneration pass. */
  removed?: number;
  current?: string;
  lastError?: string;
  message: string;
  running: boolean;
}

interface ZazaLibraryApp {
  appid: number;
  display_name?: string;
  is_shortcut?: boolean;
}

interface AssetSearchOptions {
  dimensions?: string;
  pages?: number;
  predicate?: (asset: any) => boolean;
  signal?: AbortSignal;
}

interface LocalAssetInfo {
  exists: boolean;
  width?: number;
  height?: number;
  path?: string;
  source?: 'custom' | 'official';
  sha256?: string;
}

interface HiddenLogoFixInfo {
  logo_exists: boolean;
  position_exists: boolean;
  position?: LogoPosition | null;
}

interface ZazaHeroMarker {
  url?: string;
  sha256?: string;
}

interface DownloadedAssetPayload {
  data: string;
  sha256: string;
  format: string;
  animated?: boolean;
}

interface PreparedHeroArtwork {
  app: ZazaLibraryApp;
  name: string;
  result: 'ready' | 'position-only' | 'skipped';
  isZazaMastro: boolean;
  assetUrl?: string;
  data?: string;
  sha256?: string;
  format?: string;
  animated?: boolean;
  skipReason?: string;
  /** A hero this plugin composed itself: logo already painted in, Steam's layer goes off. */
  perfectComposition?: boolean;
  sourceToken?: string;
}

interface PreparedBulkArtwork {
  app: ZazaLibraryApp;
  name: string;
  result: 'ready' | 'skipped';
  assetType?: SGDBAssetType;
  data?: string;
  format?: string;
  animated?: boolean;
  skipReason?: string;
}

interface ZazaPositionScan {
  appids: number[];
  marked: number;
  skipped: number;
}

type ProcessResult = 'changed' | 'skipped';

const ZAZAMASTRO_STEAM64 = '76561198128354791';
/*
  Both spellings are accepted on purpose. The SteamGridDB account is LoZazaMastro, but
  older uploads are still credited to the shorter name, so matching only the current one
  would stop recognising heroes that are already applied in the library.
*/
const ZAZAMASTRO_NAMES = ['lozazamastro', 'zazamastro'];
const API_TIMEOUT_MS = 12000;
const JSON_TIMEOUT_MS = 6000;
const STEAM_ARTWORK_TIMEOUT_MS = 10000;
const APP_TIMEOUT_MS = 30000;
const ZAZA_PREPARE_CONCURRENCY = 1;
const STANDARD_PREPARE_CONCURRENCY = 2;

const MIN_LOGO_POSITION: LogoPosition = {
  pinnedPosition: 'BottomLeft',
  nWidthPct: 0.01,
  nHeightPct: 0.01,
};

const DEFAULT_HIDDEN_LOGO_POSITION: LogoPosition = {
  pinnedPosition: 'BottomLeft',
  nWidthPct: 50,
  nHeightPct: 50,
};

const endpointForAsset: Record<SGDBAssetType, string> = {
  grid_p: 'grids',
  grid_l: 'grids',
  hero: 'heroes',
  logo: 'logos',
  icon: 'icons',
};

const labelForKind: Record<BatchKind | 'perfectHeroReset', string> = {
  squareReplace: t('PA_BATCH_SQUARE_REPLACE', 'Square covers'),
  squareMissing: t('PA_BATCH_SQUARE_MISSING', 'Missing square covers'),
  portraitReplace: t('PA_BATCH_PORTRAIT_REPLACE', 'Portrait covers'),
  portraitMissing: t('PA_BATCH_PORTRAIT_MISSING', 'Missing portrait covers'),
  perfectHeroReset: t('PA_BATCH_PERFECT_HERO_RESET', 'Removing existing Perfect Heroes'),
  perfectHeroReplace: t('PA_BATCH_PERFECT_HERO', 'Perfect Hero'),
  perfectHeroMissing: t('PA_BATCH_PERFECT_HERO_MISSING', 'Missing Perfect Heroes'),
  banner920: t('PA_BATCH_BANNERS', 'Banners'),
  missingLogos: t('PA_BATCH_LOGOS', 'Missing logos'),
  logoFix: t('PA_BATCH_LOGO_FIX', 'Logo fix'),
  resetArtwork: t('PA_BATCH_RESTORE', 'Restore Steam artwork'),
  fixAll: t('PA_BATCH_ALL', 'Everything'),
};

export type CoverShape = 'square' | 'portrait' | 'hero';

/*
  Source order, tried top to bottom until one has a cover.

  Square covers: IGN and the console stores publish real square art. Vertical covers: only
  the sources that actually have a portrait cover - PlayStation, Nintendo and IGN are
  square-only, so they are not in that list at all.
*/
export const COVER_SOURCES: Record<CoverShape, ArtworkProviderId[]> = {
  square: ['ign', 'playstation', 'steamgriddb', 'xbox', 'nintendo'],
  portrait: ['steamgriddb', 'igdb', 'xbox'],
  /*
    Backgrounds for the composed Perfect Hero. SteamGridDB is also the only place
    ZazaMastro's own heroes live, so it is always consulted for those first,
    whatever this list says.
  */
  hero: ['steamgriddb', 'alphacoders', 'igdb', 'playstation', 'xbox', 'iidb'],
};

export const coverSourceSettingKey = (shape: CoverShape, provider: string) =>
  `bulk_source_${shape}_${provider}`;

export const coverSourceOrderKey = (shape: CoverShape) => `bulk_source_order_${shape}`;

/** The user's order, with any unknown or missing entries reconciled against the default. */
export const normalizeCoverOrder = (shape: CoverShape, stored: unknown): ArtworkProviderId[] => {
  const known = COVER_SOURCES[shape];
  const list = Array.isArray(stored) ? stored.filter((item) => known.includes(item as ArtworkProviderId)) : [];
  const seen = new Set(list);
  return [...list as ArtworkProviderId[], ...known.filter((provider) => !seen.has(provider))];
};

const shapeForKind = (kind: CoverBatchKind | HeroBatchKind): CoverShape => {
  if (kind === 'squareReplace' || kind === 'squareMissing') return 'square';
  if (kind === 'portraitReplace' || kind === 'portraitMissing') return 'portrait';
  return 'hero';
};

const replacesExisting = (kind: CoverBatchKind | HeroBatchKind) =>
  kind === 'squareReplace' || kind === 'portraitReplace' || kind === 'perfectHeroReplace';

const isCoverKind = (kind: ProcessableBatchKind): kind is CoverBatchKind =>
  kind === 'squareReplace' || kind === 'squareMissing'
  || kind === 'portraitReplace' || kind === 'portraitMissing';

const isHeroKind = (kind: ProcessableBatchKind): kind is HeroBatchKind =>
  kind === 'perfectHeroReplace' || kind === 'perfectHeroMissing';

/** Sources the user has left switched on, in priority order. */
const enabledCoverSources = async (shape: CoverShape): Promise<ArtworkProviderId[]> => {
  let order = COVER_SOURCES[shape];
  try {
    order = normalizeCoverOrder(shape, await call<[string, unknown], unknown>('get_setting', coverSourceOrderKey(shape), null));
  } catch (_) {
    // Default order.
  }
  const flags = await Promise.all(order.map(async (provider) => {
    try {
      return await call<[string, boolean], boolean>('get_setting', coverSourceSettingKey(shape, provider), true);
    } catch (_) {
      return true;
    }
  }));
  return order.filter((_provider, index) => flags[index] !== false);
};

const phasesForKind = (kind: BatchKind, preferredCoverShape: 'square' | 'portrait' = 'portrait'): ProcessableBatchKind[] => (
  kind === 'fixAll'
    ? [preferredCoverShape === 'square' ? 'squareMissing' : 'portraitMissing', 'perfectHeroMissing', 'banner920', 'missingLogos', 'logoFix']
    : kind === 'perfectHeroReplace' ? ['perfectHeroReset', 'perfectHeroReplace'] : [kind]
);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const throwIfCancelled = (signal?: AbortSignal) => {
  if (!signal?.aborted) return;
  const error = new Error('PA_OPERATION_CANCELLED');
  error.name = 'AbortError';
  throw error;
};

const errorMessage = (error: unknown) => {
  return localizeError(error, 'PA_FAILED');
};

const withTimeout = <T,>(request: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    }, timeoutMs);

    request
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
  });
};

const assetRequestCache = new Map<string, Promise<any[]>>();
const gameIdCache = new Map<number, Promise<number | null>>();

const apiRequest = async (url: string, signal?: AbortSignal): Promise<any[]> => {
  throwIfCancelled(signal);
  const apiKey = String(await call<[string, string], string>('get_setting', 'steamgriddb_api_key', '')).trim();
  if (!apiKey) throw new Error('PA_ERROR_API_KEY_AUTOMATION');
  const cacheKey = `${apiKey}:${url}`;
  const cached = assetRequestCache.get(cacheKey);
  if (cached) return cached;
  const request = (async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      throwIfCancelled(signal);
      const response = await fetchWithCancellation(fetchNoCors as any, `${SGDB_API_BASE}${url}`, {
        method: 'GET', signal, headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      }, API_TIMEOUT_MS);
      if (response?.status === 404) return [];
      if (attempt === 0 && [429, 500, 502, 503, 504].includes(response?.status)) {
        await delay(1000);
        continue;
      }
      if (!response || response.status === 401 || response.status === 403) throw new Error('PA_ERROR_SGDB_REQUEST');
      const body = await withTimeout(response.json(), JSON_TIMEOUT_MS, 'PA_ERROR_OPERATION_TIMEOUT');
      throwIfCancelled(signal);
      if (!body?.success) throw new Error('PA_ERROR_SGDB_REQUEST');
      return Array.isArray(body.data) ? body.data : [];
    }
    return [];
  })();
  assetRequestCache.set(cacheKey, request);
  if (assetRequestCache.size > 64) assetRequestCache.delete(assetRequestCache.keys().next().value!);
  try { return await request; }
  catch (error) { assetRequestCache.delete(cacheKey); throw error; }
};

const getApiParams = (assetType: SGDBAssetType, page: number, options: AssetSearchOptions) => {
  const params = new URLSearchParams({
    page: page.toString(),
    styles: STYLES[assetType].default.join(','),
    mimes: MIMES[assetType].default.join(','),
    nsfw: 'false',
    humor: 'any',
    epilepsy: 'any',
    oneoftag: '',
    types: 'static',
  });

  if (options.dimensions) {
    params.set('dimensions', options.dimensions);
  } else if (assetType !== 'hero' && DIMENSIONS[assetType].default.length > 0) {
    params.set('dimensions', DIMENSIONS[assetType].default.join(','));
  }

  return params.toString();
};

const searchGames = async (term: string, signal?: AbortSignal) => {
  if (!term.trim()) return [];
  return await apiRequest(`/search/autocomplete/${encodeURIComponent(encodeURIComponent(term))}`, signal);
};

/** A saved manual association wins; autocomplete must not silently pick a sequel. */
const sgdbGameIdForApp = async (app: ZazaLibraryApp, signal?: AbortSignal): Promise<number | null> => {
  const cached = gameIdCache.get(app.appid);
  if (cached) return cached;
  const lookup = (async () => {
    const saved = await call<[string, any], any>('get_setting', `nonsteam_${app.appid}`, null).catch(() => null);
    if (saved?.id && (!saved.provider || saved.provider === 'steamgriddb')) return Number(saved.id);
    const name = app.display_name?.trim() || '';
    if (!name) return null;
    const clean = name.replace(/[™®©]/g, '').replace(/[’‘]/g, "'").replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
    // Strip only clearly decorative trailing platform/region/year tags, never sequel numbers.
    const untagged = clean.replace(/\s*[[(](?:PC|Steam|GOG|Epic|Windows|USA|EU|Europe|Japan|19\d{2}|20\d{2})[\])](?=\s*$)/i, '').trim();
    for (const term of [...new Set([name, clean, untagged])].filter(Boolean)) {
      throwIfCancelled(signal);
      const games = await searchGames(term, signal);
      const match = exactTitleMatch(term, games);
      if (match?.id) return Number(match.id);
    }
    log('bulk game association not found', { appid: app.appid, name });
    return null;
  })();
  gameIdCache.set(app.appid, lookup);
  if (gameIdCache.size > 64) gameIdCache.delete(gameIdCache.keys().next().value!);
  try { return await lookup; }
  catch (error) { gameIdCache.delete(app.appid); throw error; }
};

/** Skip animation and impossible dimensions before choosing a candidate. */
const allUsefulAssets = (assets: any[]) => uniqueAssets(assets)
  .filter(asset => {
    if (!asset?.url || /\.(?:webm|gif)(?:[?#]|$)/i.test(String(asset.url)) || asset.animated || asset.type === 'animated') return false;
    const width = Number(asset.width || 0), height = Number(asset.height || 0);
    return width <= MAX_SOURCE_DIMENSION && height <= MAX_SOURCE_DIMENSION && width * height <= MAX_SOURCE_PIXELS;
  })
  .sort((a, b) => (Number(b.width) * Number(b.height)) - (Number(a.width) * Number(a.height)));

const assetsForApp = async (app: ZazaLibraryApp, assetType: SGDBAssetType, options: AssetSearchOptions = {}): Promise<any[]> => {
  const endpoint = endpointForAsset[assetType];
  const found: any[] = [];
  const collect = async (path: string) => {
    for (let page = 0; page < (options.pages ?? 2); page += 1) {
      throwIfCancelled(options.signal);
      const assets = await apiRequest(`${path}?${getApiParams(assetType, page, options)}`, options.signal);
      found.push(...allUsefulAssets(assets));
      if (!assets.length || (options.predicate && found.some(options.predicate))) break;
    }
  };
  const saved = await call<[string, any], any>('get_setting', `nonsteam_${app.appid}`, null).catch(() => null);
  if (saved?.id && (!saved.provider || saved.provider === 'steamgriddb')) {
    await collect(`/${endpoint}/game/${Number(saved.id)}`);
  } else if (!app.is_shortcut) {
    await collect(`/${endpoint}/steam/${app.appid}`);
  }
  if (!found.length) {
    const gameId = await sgdbGameIdForApp(app, options.signal);
    if (gameId && gameId !== Number(saved?.id)) await collect(`/${endpoint}/game/${gameId}`);
  }
  return allUsefulAssets(found).filter(asset => !options.predicate || options.predicate(asset));
};

const findAssetForApp = async (app: ZazaLibraryApp, assetType: SGDBAssetType, options: AssetSearchOptions = {}) =>
  (await assetsForApp(app, assetType, options))[0] ?? null;

export const isZazaMastroAsset = (asset: any) => {
  const author = asset?.author;
  const values = [
    author?.name,
    author?.steam64,
    author?.steamid,
    author?.steam_id,
    typeof author === 'string' ? author : '',
  ].filter(Boolean).map((value) => String(value).toLowerCase());

  return values.some((value) => (
    ZAZAMASTRO_NAMES.includes(value) ||
    value === ZAZAMASTRO_STEAM64
  ));
};

const normalizeApp = async (libraryApp: ZazaLibraryApp): Promise<ZazaLibraryApp> => {
  let displayName = libraryApp.display_name ?? '';
  let isShortcut = libraryApp.is_shortcut;

  // The backend already supplies this data for almost every app. Avoid waking
  // Steam's app-details store unless information is genuinely missing.
  if (displayName.trim() && typeof isShortcut === 'boolean') {
    return libraryApp;
  }

  try {
    const overview = await withTimeout(getAppOverview(libraryApp.appid), 1500, 'Steam overview timeout');
    if (overview) {
      displayName = overviewName(overview) || displayName;
      if (typeof overview.BIsShortcut === 'function') {
        isShortcut = overview.BIsShortcut();
      }
    }
  } catch (error) {
    log('ZazaMastro overview timeout', libraryApp.appid, error);
  }

  // Last resort before giving up on a name: Steam's own overview store, read directly.
  if (!displayName.trim()) {
    try {
      const direct = (window as any).appStore?.GetAppOverviewByAppID?.(libraryApp.appid);
      const resolved = overviewName(direct);
      if (resolved) displayName = resolved;
      if (typeof direct?.BIsShortcut === 'function' && typeof isShortcut !== 'boolean') {
        isShortcut = direct.BIsShortcut();
      }
    } catch (_) {
      // Store not ready; the app is skipped rather than searched by number.
    }
  }

  /*
    NEVER fabricate a name from the app id.

    This used to fall back to `String(appid)`, and the search below then asked
    SteamGridDB for "1245620" - a number matches nothing, so the bulk job trawled the
    whole library and came back empty. An app with no known name is simply left without
    one; the callers already skip the name search when it is missing, and the progress
    line falls back to the id only for display.
  */
  return {
    appid: libraryApp.appid,
    display_name: displayName.trim(),
    is_shortcut: isShortcut ?? false,
  };
};

/*
  Reading the Steam library, the way the other Playhub plugins do it.

  Three things were wrong here and together they produced a bulk run that processed 2346
  entries, showed app ids instead of titles for the first 1360 of them, and matched almost
  nothing:

    1. the wrong stores. `m_rgApps`, `m_mapApps` and `m_mapAppOverviews` do not exist. The
       real ones are `appStore.allApps` (an array) and `appStore.m_mapAppOverview`
       (singular), on `globalThis` and on `window` - Launch Curtain reads all four;
    2. the wrong name. The raw entry often has none; the name lives on the overview from
       `GetAppOverviewByAppID`, under `display_name` OR `localized_name` OR `name`;
    3. reading too early. Steam hydrates the overviews after the client starts, so a run
       started right after boot sees mostly empty entries. ThemeDeck solves this by
       re-reading until the placeholders disappear, which is what happens below.

  On top of that the list is now filtered the way ThemeDeck filters it, so DLC,
  soundtracks, tools and Steam's own helper apps never enter the job at all.
*/

const APP_TYPE_APPLICATION = 1 << 2;
const APP_TYPE_TOOL = 1 << 3;
const APP_TYPE_DLC = 1 << 5;
const APP_TYPE_MUSIC = 1 << 13;
const APP_TYPE_SHORTCUT = 1 << 30;

/** Steam's own components, never games. */
const EXCLUDED_APP_IDS = new Set<number>([7, 760, 12210, 12211, 12212, 12213, 12218, 228980]);

const appStores = (): any[] => {
  const stores = [(globalThis as any)?.appStore, (globalThis as any)?.window?.appStore];
  return stores.filter((store, index) => store && stores.indexOf(store) === index);
};

const overviewFor = (appId: number): any => {
  for (const store of appStores()) {
    try {
      const overview = store?.GetAppOverviewByAppID?.(appId) ?? store?.GetAppOverviewByGameID?.(appId);
      if (overview) return overview;
    } catch (_) {
      // Store not ready yet.
    }
  }
  return null;
};

const overviewName = (source: any): string => String(
  source?.display_name || source?.localized_name || source?.name || source?.strTitle || source?.title || ''
)
  .replace(/[™®©]/g, '')
  .replace(/\s+/g, ' ')
  .trim();

const isShortcutOverview = (overview: any, appId: number): boolean => {
  try {
    if (overview?.BIsShortcut?.() || overview?.BIsModOrShortcut?.()) return true;
  } catch (_) {
    // fall through to the numeric tests
  }
  return Number(overview?.app_type) === APP_TYPE_SHORTCUT || appId >= 2147483648;
};

/** DLC, soundtracks, tools and hidden entries are not artwork targets. */
const isArtworkTarget = (overview: any, appId: number, shortcut: boolean): boolean => {
  if (EXCLUDED_APP_IDS.has(appId)) return false;
  if (overview?.visible_in_game_list === false) return false;
  if (shortcut) return true; // app_type is unreliable for shortcuts
  const appType = Number(overview?.app_type ?? NaN);
  if (!Number.isFinite(appType)) return true;
  if (appType & APP_TYPE_DLC) return false;
  if (appType & APP_TYPE_MUSIC) return false;
  if (appType & (APP_TYPE_APPLICATION | APP_TYPE_TOOL)) return false;
  return true;
};

/** One pass over every store Steam exposes. */
const collectLibraryApps = (): ZazaLibraryApp[] => {
  const byId = new Map<number, ZazaLibraryApp>();

  const add = (entry: any, key?: any) => {
    const appId = Number(
      entry?.appid ?? entry?.app_id ?? entry?.unAppID ?? entry?.nAppID ?? entry?.id ?? key ?? entry
    );
    if (!Number.isFinite(appId) || appId <= 0) return;

    const overview = overviewFor(appId) ?? entry;
    const name = overviewName(overview) || overviewName(entry);
    const shortcut = isShortcutOverview(overview, appId);
    if (!isArtworkTarget(overview, appId, shortcut)) return;

    const existing = byId.get(appId);
    // A real title always wins over a missing one, whichever store produced it.
    if (!existing || (!existing.display_name && name)) {
      byId.set(appId, { appid: appId, display_name: name, is_shortcut: shortcut });
    }
  };

  appStores().forEach((store) => {
    try {
      store?.allApps?.forEach?.(add);
      store?.m_mapAppOverview?.forEach?.((value: any, mapKey: any) => add(value, mapKey));
    } catch (error) {
      log('ZazaMastro app store read failed', error);
    }
  });

  return [...byId.values()];
};

/**
 * Waits for Steam to finish hydrating before the job starts.
 *
 * Reads repeatedly until the share of apps that still have no title stops improving, or
 * until the budget runs out. Without this, a run started shortly after boot enumerates
 * thousands of nameless entries and searches SteamGridDB for app ids.
 */
const getLibraryApps = async (): Promise<ZazaLibraryApp[]> => {
  let best: ZazaLibraryApp[] = [];
  let bestNamed = -1;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const apps = collectLibraryApps();
    const named = apps.filter((app) => Boolean(app.display_name)).length;

    if (named > bestNamed) {
      best = apps;
      bestNamed = named;
    }
    // Everything Steam knows about has a title: nothing left to wait for.
    if (apps.length > 0 && named === apps.length) break;
    await new Promise((resolve) => window.setTimeout(resolve, 1200));
  }

  const named = best.filter((app) => Boolean(app.display_name));
  const skipped = best.length - named.length;
  log('ZazaMastro library read', { total: best.length, named: named.length, unnamed: skipped });

  /*
    Apps Steam never named are dropped rather than searched by number. They are counted in
    the log so a library that really is missing titles is visible instead of silent.
  */
  return named.sort((a, b) => (a.display_name ?? '').localeCompare(b.display_name ?? ''));
};

const getLocalAssetInfo = async (appId: number, assetType: SGDBAssetType) => {
  try {
    let steamUser = '';
    try { steamUser = getCurrentSteamUserId(); } catch (_) { /* Steam is still hydrating. */ }
    return await call<[number, string, string], LocalAssetInfo>('get_local_asset_info', appId, assetType, steamUser);
  } catch (error) {
    log('ZazaMastro local asset info failed', appId, assetType, error);
    return { exists: false };
  }
};

const zazaMarkerKey = (appId: number) => `zazamastro_hero_${appId}`;

const getZazaHeroMarker = async (appId: number): Promise<ZazaHeroMarker> => {
  try {
    return await withTimeout(
      call<[key: string, fallback: ZazaHeroMarker], ZazaHeroMarker>('get_setting', zazaMarkerKey(appId), {}),
      3000,
      t('PA_ERROR_OPERATION_TIMEOUT', 'The operation took too long.')
    ) ?? {};
  } catch (error) {
    log('ZazaMastro marker read failed', appId, error);
    return {};
  }
};

const saveZazaHeroMarker = async (appId: number, marker: ZazaHeroMarker) => {
  try {
    await withTimeout(
      call<[key: string, value: ZazaHeroMarker], void>('set_setting', zazaMarkerKey(appId), marker),
      3000,
      t('PA_ERROR_OPERATION_TIMEOUT', 'The operation took too long.')
    );
  } catch (error) {
    log('ZazaMastro marker save failed', appId, error);
  }
};

const downloadAssetPayload = async (url: string, signal?: AbortSignal): Promise<DownloadedAssetPayload> => {
  const payload = await readArtworkPayload(url, { signal });
  if (!payload) throw new Error('PA_ERROR_RETRIEVE_ASSET');
  return { ...payload, sha256: payload.sha256 || '' };
};

const applyDownloadedAsset = async (appId: number, assetType: SGDBAssetType, payload: { data: string; format: string; animated?: boolean }) => {
  const normalized = await normalizeArtworkPayload(payload);
  await runSteamArtworkTransaction(async (mutate) => {
    await mutate(
      'Clear artwork timeout',
      () => SteamClient.Apps.ClearCustomArtworkForApp(appId, ASSET_TYPE[assetType]),
    );
    // Steam resolves ClearCustomArtworkForApp before the cache write is fully visible.
    await delay(180);
    await mutate(
      'Set artwork timeout',
      () => SteamClient.Apps.SetCustomArtworkForApp(
        appId,
        normalized.data,
        normalized.format,
        ASSET_TYPE[assetType],
      ),
    );
  });
};

const setLogoPosition = async (appId: number, logoPosition: LogoPosition, timeoutMessage: string) => {
  await withTimeout(
    Promise.resolve(SteamClient.Apps.SetCustomLogoPositionForApp(appId, JSON.stringify({
      nVersion: 1,
      logoPosition,
    }))),
    STEAM_ARTWORK_TIMEOUT_MS,
    timeoutMessage
  );
};

/* ------------------------------------------------------------------ *
 * Automatic Perfect Hero
 *
 * For every game that does NOT already carry a ZazaMastro hero: take the highest
 * resolution hero SteamGridDB has, paint the game's logo onto it in the standard
 * position, and hand Steam one finished 3840 x 1240 picture. Steam's separate logo
 * layer is switched off afterwards, exactly as it is for a hand-made Perfect Hero,
 * so the logo is never drawn twice.
 * ------------------------------------------------------------------ */

const PERFECT_WIDTH = 3840;
const PERFECT_HEIGHT = 1240;

/** The composer's own defaults, so an automatic hero matches a hand-made one. */
const STANDARD_LOGO = { x: 25, y: 50, scale: 28 };

/** Validate a real logo, reject transparent placeholders, trim empty padding. */
const usableLogo = async (source: string, signal?: AbortSignal): Promise<string> => {
  return await withCompositionLock(async () => {
    throwIfCancelled(signal);
    let image: HTMLImageElement | null = null;
    let sample: HTMLCanvasElement | null = null;
    let output: HTMLCanvasElement | null = null;
    try {
      image = await loadSafeImage(source, signal);
      if (image.naturalWidth <= 1 || image.naturalHeight <= 1) return '';
      sample = document.createElement('canvas');
      const ratio = Math.min(1, 512 / Math.max(image.naturalWidth, image.naturalHeight));
      sample.width = Math.max(1, Math.round(image.naturalWidth * ratio));
      sample.height = Math.max(1, Math.round(image.naturalHeight * ratio));
      const context = sample.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('PA_ERROR_COMPOSITING_UNAVAILABLE');
      context.drawImage(image, 0, 0, sample.width, sample.height);
      const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
      let left = sample.width, right = -1, top = sample.height, bottom = -1;
      for (let y = 0; y < sample.height; y += 1) for (let x = 0; x < sample.width; x += 1) {
        if (pixels[(y * sample.width + x) * 4 + 3] > 8) {
          left = Math.min(left, x); right = Math.max(right, x);
          top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
      }
      if (right < left || bottom < top) return '';
      // Leave a small border so antialiased/shadow pixels are not clipped.
      const sx = Math.max(0, Math.floor((left - 2) * image.naturalWidth / sample.width));
      const sy = Math.max(0, Math.floor((top - 2) * image.naturalHeight / sample.height));
      const ex = Math.min(image.naturalWidth, Math.ceil((right + 3) * image.naturalWidth / sample.width));
      const ey = Math.min(image.naturalHeight, Math.ceil((bottom + 3) * image.naturalHeight / sample.height));
      const scale = Math.min(1, 2560 / (ex - sx), 1600 / (ey - sy));
      output = document.createElement('canvas');
      output.width = Math.max(1, Math.round((ex - sx) * scale));
      output.height = Math.max(1, Math.round((ey - sy) * scale));
      const target = output.getContext('2d');
      if (!target) throw new Error('PA_ERROR_COMPOSITING_UNAVAILABLE');
      target.imageSmoothingEnabled = true;
      target.imageSmoothingQuality = 'high';
      target.drawImage(image, sx, sy, ex - sx, ey - sy, 0, 0, output.width, output.height);
      return `data:image/png;base64,${await canvasToBase64(output, 'png')}`;
    } finally {
      releaseImage(image); releaseCanvas(sample); releaseCanvas(output);
    }
  });
};

const resolveLogoForApp = async (app: ZazaLibraryApp, sources: ArtworkProviderId[], signal?: AbortSignal): Promise<string> => {
  const trySource = async (source: string, path = false): Promise<string> => {
    throwIfCancelled(signal);
    try {
      const payload = path ? await readArtworkPayload(source, { path: true, signal, staticOnly: true })
        : await readArtworkSource(source, { signal, staticOnly: true });
      const logo = payload ? await usableLogo(artworkPayloadUrl(payload), signal) : '';
      if (logo) log('bulk logo resolved', { appid: app.appid, source: path ? 'local file' : source });
      return logo;
    } catch (error: any) {
      throwIfCancelled(signal);
      log('bulk logo candidate failed', { appid: app.appid, source, error: error?.message });
      return '';
    }
  };
  // Read custom AND official cache, irrespective of whether Steam currently hides the layer.
  try {
    const local = await getLocalAssetInfo(app.appid, 'logo');
    if (local.path) {
      const logo = await trySource(local.path, true);
      if (logo) return logo;
    }
  } catch (error) { throwIfCancelled(signal); log('bulk local logo lookup failed', app.appid, error); }
  const overview = await getAppOverview(app.appid);
  if (overview) for (const source of artworkSources(overview, 'logo')) {
    const logo = await trySource(source);
    if (logo) return logo;
  }
  try {
    const logos = await assetsForApp(app, 'logo', { pages: 2, signal });
    for (const asset of logos.slice(0, 8)) {
      const logo = await trySource(String(asset.url));
      if (logo) return logo;
    }
  } catch (error) { throwIfCancelled(signal); log('bulk SteamGridDB logo search failed', app.appid, error); }
  for (const provider of sources.filter(item => item === 'iidb' || item === 'playstation')) {
    if (!app.display_name) continue;
    try {
      const logos = await call<any, any[]>('search_provider_assets', provider, app.display_name, 'logo', false, 8, 'any', [], 'all', '', '');
      for (const asset of allUsefulAssets(logos || []).slice(0, 4)) {
        const logo = await trySource(String(asset.url));
        if (logo) return logo;
      }
    } catch (error) { throwIfCancelled(signal); log('bulk provider logo search failed', provider, app.appid, error); }
  }
  return '';
};

const composePerfectHero = async (heroSource: string, logoSource: string, signal?: AbortSignal): Promise<{ data: string; format: 'jpg' }> => {
  if (!logoSource) throw new Error('PA_ERROR_LOGO_NOT_FOUND');
  throwIfCancelled(signal);
  return await withCompositionLock(async () => {
    let hero: HTMLImageElement | null = null;
    let logo: HTMLImageElement | null = null;
    let canvas: HTMLCanvasElement | null = null;
    try {
      hero = await loadSafeImage(heroSource, signal);
      canvas = document.createElement('canvas');
      canvas.width = PERFECT_WIDTH;
      canvas.height = PERFECT_HEIGHT;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(t('PA_ERROR_COMPOSITING_UNAVAILABLE', 'Image compositing is unavailable.'));

      context.fillStyle = '#000';
      context.fillRect(0, 0, PERFECT_WIDTH, PERFECT_HEIGHT);
      const ratio = Math.max(PERFECT_WIDTH / hero.naturalWidth, PERFECT_HEIGHT / hero.naturalHeight);
      const drawWidth = hero.naturalWidth * ratio;
      const drawHeight = hero.naturalHeight * ratio;
      context.drawImage(hero, (PERFECT_WIDTH - drawWidth) / 2, (PERFECT_HEIGHT - drawHeight) / 2, drawWidth, drawHeight);

      // No catch-and-continue: a failed logo must NEVER become a completed Perfect Hero.
      logo = await loadSafeImage(logoSource, signal);
      const logoRatio = Math.min(PERFECT_WIDTH * STANDARD_LOGO.scale / 100 / logo.naturalWidth,
        PERFECT_HEIGHT * .72 / logo.naturalHeight);
      const width = logo.naturalWidth * logoRatio;
      const height = logo.naturalHeight * logoRatio;
      const left = PERFECT_WIDTH * STANDARD_LOGO.x / 100 - width / 2;
      const top = PERFECT_HEIGHT * STANDARD_LOGO.y / 100 - height / 2;
      context.save();
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.shadowColor = 'rgba(0, 0, 0, 0.55)';
      context.shadowBlur = Math.round(PERFECT_WIDTH * 0.006);
      context.shadowOffsetY = Math.round(PERFECT_WIDTH * 0.003);
      context.drawImage(logo, left, top, width, height);
      context.restore();
      throwIfCancelled(signal);

      const data = await canvasToBase64(canvas, 'jpg', 0.92);
      return { data, format: 'jpg' };
    } finally {
      releaseImage(hero);
      releaseImage(logo);
      releaseCanvas(canvas);
    }
  });
};

/** Try multiple actual files per enabled source; one broken upload is not the whole game. */
async function* heroCandidatesFromSources(app: ZazaLibraryApp, sources: ArtworkProviderId[], signal?: AbortSignal): AsyncGenerator<any> {
  for (const provider of sources) {
    throwIfCancelled(signal);
    try {
      const assets = provider === 'steamgriddb'
        ? await assetsForApp(app, 'hero', { pages: 3, signal })
        : app.display_name ? await call<any, any[]>('search_provider_assets', provider, app.display_name, 'hero', false, 12, 'any', [], 'all', '', '') : [];
      for (const asset of allUsefulAssets(assets || []).slice(0, 8)) yield asset;
    } catch (error) { throwIfCancelled(signal); log('bulk hero provider search failed', provider, app.appid, error); }
  }
}

/**
 * Destructive, explicitly confirmed regeneration starts here for the WHOLE batch.
 * Clear the previous composition and all saved sources before any new download.
 * Unmarked ordinary heroes are not erased merely because a source is unavailable.
 */
const resetPerfectHeroForRegeneration = async (app: ZazaLibraryApp, signal?: AbortSignal): Promise<boolean> => {
  throwIfCancelled(signal);
  const [marked, info, marker, bannerMarked, bannerInfo] = await withTimeout(Promise.all([
    call<[string, boolean], boolean>('get_setting', `perfect_hero_${app.appid}`, false),
    call<[string, any], any>('get_setting', `perfect_hero_info_${app.appid}`, null),
    call<[string, ZazaHeroMarker | null], ZazaHeroMarker | null>('get_setting', zazaMarkerKey(app.appid), null),
    call<[string, boolean], boolean>('get_setting', `perfect_grid_l_${app.appid}`, false),
    call<[string, any], any>('get_setting', `perfect_grid_l_info_${app.appid}`, null),
  ]), STEAM_ARTWORK_TIMEOUT_MS, 'PA_ERROR_PERFECT_HERO_RESET');
  let hasPerfect = Boolean(marked || info);
  if (!hasPerfect && marker?.sha256) {
    // A stale Zaza marker alone is not proof that today's custom hero is that file.
    let steamUser = '';
    try { steamUser = getCurrentSteamUserId(); } catch (_) { /* Let the backend choose the active user. */ }
    const current = await withTimeout(call<[number, string, string], LocalAssetInfo>(
      'get_local_asset_info', app.appid, 'hero', steamUser), STEAM_ARTWORK_TIMEOUT_MS, 'PA_ERROR_PERFECT_HERO_RESET');
    hasPerfect = Boolean(current?.exists && current.source === 'custom' && current.sha256 === marker.sha256);
  }
  throwIfCancelled(signal);
  // Hero regeneration leaves Banner intact. Legacy marked banners may already
  // carry a logo despite lacking metadata, so preserve their hidden layer.
  const restoreLogo = hasPerfect && !(bannerMarked && bannerInfo?.withLogo !== false);
  if (hasPerfect) {
    await clearSteamArtworkSafely(app.appid, ASSET_TYPE.hero);
    // Finish restoring the logo/state even if cancellation arrived during Steam's
    // clear. The next app/download observes it; never leave a half-reset hidden logo.
    if (restoreLogo && !await showLogo(app.appid)) throw new Error('PA_ERROR_PERFECT_HERO_RESET');
  }
  // Also remove orphaned source snapshots and old markers. A plain hero's logo
  // visibility is unchanged when there was no identifiable Perfect composition.
  const cleared = await withTimeout(call<[number, boolean], boolean>(
    'clear_perfect_hero_state', app.appid, restoreLogo), STEAM_ARTWORK_TIMEOUT_MS, 'PA_ERROR_PERFECT_HERO_RESET');
  if (cleared !== true) throw new Error('PA_ERROR_PERFECT_HERO_RESET');
  log('bulk Perfect Hero reset', { appid: app.appid, removed: hasPerfect });
  return hasPerfect;
};

const prepareAutoPerfectHero = async (rawApp: ZazaLibraryApp, sources: ArtworkProviderId[], replace: boolean, signal?: AbortSignal): Promise<PreparedHeroArtwork> => {
  throwIfCancelled(signal);
  const name = rawApp.display_name || String(rawApp.appid);
  const [currentHero, marker, alreadyPerfect, info] = await Promise.all([
    getLocalAssetInfo(rawApp.appid, 'hero'), getZazaHeroMarker(rawApp.appid),
    call<[string, boolean], boolean>('get_setting', `perfect_hero_${rawApp.appid}`, false).catch(() => false),
    call<[string, any], any>('get_setting', `perfect_hero_info_${rawApp.appid}`, null).catch(() => null),
  ]);
  const hasZazaHero = currentHero.source === 'custom' && currentHero.sha256 && marker.sha256 === currentHero.sha256;
  if (!replace && hasZazaHero) return { app: rawApp, name, result: 'skipped', isZazaMastro: true, skipReason: 'LoZazaMastro hero already applied' };
  // Preserve old/manual compositions. A marker alone is not proof when the file is gone/changed.
  const intact = currentHero.source === 'custom' && currentHero.exists && (!info?.sha256 || info.sha256 === currentHero.sha256);
  if (!replace && alreadyPerfect && intact && (info?.origin === 'manual' || info?.withLogo !== false)) {
    return { app: rawApp, name, result: 'skipped', isZazaMastro: false, skipReason: 'Perfect Hero already present' };
  }
  const app = await normalizeApp(rawApp);
  try {
    const assets = await assetsForApp(app, 'hero', { pages: 4, predicate: isZazaMastroAsset, signal });
    for (const zazaAsset of assets.slice(0, 8)) {
      try {
        const payload = await downloadAssetPayload(zazaAsset.url, signal);
        return { app, name: app.display_name || name, result: 'ready', isZazaMastro: true,
          assetUrl: zazaAsset.url, data: payload.data, sha256: payload.sha256, format: payload.format, animated: payload.animated };
      } catch (error) { throwIfCancelled(signal); log('bulk priority hero download failed', app.appid, error); }
    }
  } catch (error) { throwIfCancelled(signal); log('bulk priority hero lookup failed', app.appid, error); }
  if (!sources.length) return { app, name, result: 'skipped', isZazaMastro: false, skipReason: 'no source enabled' };

  const logoData = await resolveLogoForApp(app, sources, signal);
  // Do not hide Steam's logo, write any artwork, or mark this app done if none resolved.
  if (!logoData) throw new Error('PA_ERROR_LOGO_NOT_FOUND');
  let lastError: unknown;
  for await (const hero of heroCandidatesFromSources(app, sources, signal)) {
    let sourceToken = '';
    try {
      const payload = await readArtworkSource(String(hero.url), {
        signal, staticOnly: true, retainSource: true,
      });
      if (!payload) continue;
      sourceToken = payload.transferToken || '';
      const composed = await composePerfectHero(artworkPayloadUrl(payload), logoData, signal);
      throwIfCancelled(signal);
      return { app, name: app.display_name || name, result: 'ready', isZazaMastro: false,
        perfectComposition: true, sourceToken, assetUrl: String(hero.url), data: composed.data, format: composed.format, animated: false };
    } catch (error) {
      if (sourceToken) await call('release_artwork_transfer', sourceToken).catch(() => undefined);
      throwIfCancelled(signal);
      lastError = error;
      log('bulk background candidate failed', app.appid, String(hero.url), error);
    }
  }
  if (lastError) throw lastError;
  return { app, name: app.display_name || name, result: 'skipped', isZazaMastro: false, skipReason: 'no background available' };
};

const applyPreparedHero3840 = async (prepared: PreparedHeroArtwork): Promise<ProcessResult> => {
  if (prepared.result === 'skipped') return 'skipped';

  if (prepared.result === 'ready') {
    if (!prepared.data) throw new Error(t('PA_ERROR_INTERNAL_ARTWORK', 'The artwork operation could not be completed.'));
    await applyDownloadedAsset(prepared.app.appid, 'hero', { data: prepared.data, format: prepared.format || 'png', animated: prepared.animated });
  }

  // Keep the pristine bytes only after Steam accepted the replacement. Failed writes
  // must not destroy the source belonging to the previous composition.
  if (prepared.sourceToken) {
    const saved = await call<[number, string, string, boolean], { saved?: boolean }>(
      'preserve_perfect_source_from_transfer', prepared.app.appid, 'hero', prepared.sourceToken, true);
    if (!saved?.saved) throw new Error('PA_ERROR_SOURCE_NOT_PRESERVED');
  }

  if (prepared.isZazaMastro || prepared.perfectComposition) {
    /*
      Both a ZazaMastro hero and one composed here already carry the logo, so Steam's
      separate logo layer is switched off. A plain 3840x1240 fallback does not, and
      leaves the user's logo position untouched.
    */
    if (!await hideLogo(prepared.app.appid)) throw new Error('PA_ERROR_INTERNAL_ARTWORK');
    await withTimeout(
      call('set_setting', `logo_visible_${prepared.app.appid}`, false),
      3000,
      t('PA_ERROR_OPERATION_TIMEOUT', 'The operation took too long.')
    );
    // Flagged as a Perfect Hero so the game page offers to undo it.
    await withTimeout(
      call('set_setting', `perfect_hero_${prepared.app.appid}`, true),
      3000,
      t('PA_ERROR_OPERATION_TIMEOUT', 'The operation took too long.')
    ).catch(() => undefined);
    const completedHero = await getLocalAssetInfo(prepared.app.appid, 'hero');
    await call('set_setting', `perfect_hero_info_${prepared.app.appid}`, {
      version: 116, origin: prepared.isZazaMastro ? 'zazamastro' : 'automatic', withLogo: true,
      sha256: completedHero.sha256 || '', source: prepared.assetUrl || '',
    });
    if (prepared.isZazaMastro) {
      const appliedHero = await getLocalAssetInfo(prepared.app.appid, 'hero');
      await saveZazaHeroMarker(prepared.app.appid, {
        url: prepared.assetUrl,
        sha256: appliedHero.sha256 || prepared.sha256,
      });
    }
  }

  return 'changed';
};

/**
 * A cover from one source, in the requested shape.
 *
 * SteamGridDB is asked through its own API (it is the only source with exact-dimension
 * filters); every other source goes through the shared provider scrapers.
 */
const coverFromSource = async (
  app: ZazaLibraryApp,
  provider: ArtworkProviderId,
  shape: CoverShape
): Promise<any> => {
  if (provider === 'steamgriddb') {
    return findAssetForApp(app, 'grid_p', {
      dimensions: shape === 'square' ? '1024x1024,512x512' : '600x900',
    });
  }

  const name = app.display_name?.trim();
  if (!name) return null;
  try {
    const results = await call<[
      provider: string, title: string, assetType: string, squareOnly: boolean, limit: number,
      minimumQuality: string, mimes: string[], contentType: string, query: string, exactSize: string,
    ], any[]>(
      'search_provider_assets', provider, name, 'grid_p', shape === 'square', 8, 'any', [], 'all', '', ''
    );
    return allUsefulAssets(results ?? [])[0] ?? null;
  } catch (error) {
    log('bulk provider search failed', provider, app.appid, error);
    return null;
  }
};

/** Walks the enabled sources in order and stops at the first one that has a cover. */
const findCoverForApp = async (
  app: ZazaLibraryApp,
  shape: CoverShape,
  sources: ArtworkProviderId[]
): Promise<{ asset: any; provider: ArtworkProviderId } | null> => {
  for (const provider of sources) {
    const asset = await coverFromSource(app, provider, shape);
    if (asset?.url) return { asset, provider };
  }
  return null;
};

/** True when the installed cover is already the shape being asked for. */
const coverMatchesShape = (local: LocalAssetInfo, shape: CoverShape): boolean => {
  const width = Number(local.width ?? 0);
  const height = Number(local.height ?? 0);
  // Unknown dimensions: treat it as a match so nothing is replaced on a guess.
  if (!width || !height) return true;
  const ratio = width / height;
  return shape === 'square' ? ratio >= 0.8 && ratio <= 1.25 : ratio < 0.8;
};

const prepareBulkArtwork = async (
  kind: ProcessableBatchKind,
  rawApp: ZazaLibraryApp,
  sources: ArtworkProviderId[],
  signal?: AbortSignal
): Promise<PreparedBulkArtwork> => {
  throwIfCancelled(signal);
  const label = rawApp.display_name || String(rawApp.appid);
  const cover = isCoverKind(kind);
  const assetType: SGDBAssetType = cover
    ? 'grid_p'
    : kind === 'banner920'
      ? 'grid_l'
      : 'logo';

  // The cheapest test first: a game that already satisfies the request never
  // wakes Steam's details store and never contacts a source.
  const local = await getLocalAssetInfo(rawApp.appid, assetType);

  /*
    "Only the missing ones" stops here when a cover already exists. "Apply and replace"
    goes on and overwrites - but the current cover is only cleared once a replacement has
    actually been found and downloaded, so a game no source covers keeps what it had.
  */
  /*
    "Missing" is judged per SHAPE, not per artwork.

    A game with a vertical cover is missing a square one, so the square job replaces it -
    and the other way round. Only a cover already in the requested shape counts as done.
    "Apply and replace" ignores all of this and redoes every game of that shape.
  */
  if (cover && !replacesExisting(kind) && local.exists && coverMatchesShape(local, shapeForKind(kind))) {
    return { app: rawApp, name: label, result: 'skipped', skipReason: 'cover already has this shape' };
  }
  if (kind === 'banner920' && local.exists && local.width && local.height && local.width >= 920 && local.height >= 430) {
    return { app: rawApp, name: label, result: 'skipped', skipReason: 'banner already present' };
  }
  if (kind === 'missingLogos' && local.exists && (!local.width || local.width > 1) && (!local.height || local.height > 1)) {
    return { app: rawApp, name: label, result: 'skipped', skipReason: 'logo already present' };
  }

  const app = await normalizeApp(rawApp);
  const name = app.display_name || label;

  let asset: any = null;
  if (cover) {
    if (sources.length === 0) {
      return { app, name, result: 'skipped', skipReason: 'no source enabled' };
    }
    const found = await findCoverForApp(app, shapeForKind(kind), sources);
    asset = found?.asset ?? null;
  } else {
    asset = await findAssetForApp(app, assetType, kind === 'banner920' ? { dimensions: '920x430' } : {});
  }

  if (!asset?.url) {
    return { app, name, result: 'skipped', skipReason: 'no artwork found' };
  }

  const payload = await downloadAssetPayload(asset.url);
  return {
    app,
    name,
    result: 'ready',
    assetType,
    data: payload.data,
    format: payload.format,
    animated: payload.animated,
  };
};

const applyPreparedBulkArtwork = async (prepared: PreparedBulkArtwork): Promise<ProcessResult> => {
  if (prepared.result === 'skipped') return 'skipped';
  if (!prepared.assetType || !prepared.data) {
    throw new Error(t('PA_ERROR_INTERNAL_ARTWORK', 'The artwork operation could not be completed.'));
  }

  const apply = () => applyDownloadedAsset(
    prepared.app.appid,
    prepared.assetType as SGDBAssetType,
    { data: prepared.data as string, format: prepared.format || 'png', animated: prepared.animated }
  );
  await apply();
  return 'changed';
};

const applyLogoFix = async (appId: number, isVerifiedZazaMastro: boolean): Promise<ProcessResult> => {
  const info = await call<[appid: number], HiddenLogoFixInfo>('get_hidden_logo_fix_info', appId);
  if (!info?.logo_exists) return 'skipped';

  const logoPosition = isVerifiedZazaMastro
    ? MIN_LOGO_POSITION
    : info.position_exists && info.position
      ? info.position
      : DEFAULT_HIDDEN_LOGO_POSITION;

  // One persistence call performs both jobs: normal logos are re-registered so
  // Steam displays them; verified ZazaMastro games are registered at minimum size.
  await setLogoPosition(appId, logoPosition, 'Logo fix timeout');
  return 'changed';
};

export const runZazaMastroBatch = async (
  kind: BatchKind,
  onProgress: (progress: ZazaBatchProgress) => void,
  requestedSteamWrites = 2,
  signal?: AbortSignal
) => {
  throwIfCancelled(signal);
  let preferredCoverShape: 'square' | 'portrait' = 'portrait';
  try {
    const storedShape = await call<[string, string], string>('get_setting', 'library_cover_format', 'portrait');
    preferredCoverShape = storedShape === 'square' ? 'square' : 'portrait';
  } catch (_) {
    // The cover format defaults to portrait.
  }
  const steamWriteConcurrency = Math.max(1, Math.min(STANDARD_PREPARE_CONCURRENCY, Math.round(requestedSteamWrites || 1)));
  assetRequestCache.clear();
  gameIdCache.clear();
  const apps = await getLibraryApps();
  throwIfCancelled(signal);
  const phases = phasesForKind(kind, preferredCoverShape);
  const totalSteps = apps.length * phases.length;
  const counters = { changed: 0, skipped: 0, failed: 0, removed: 0 };
  const heroResetFailures = new Map<number, unknown>();
  let lastError: string | undefined;
  log('bulk enumeration', { kind, apps: apps.length, phases, totalSteps, steamWriteConcurrency });
  let verifiedZazaAppids: Set<number> | null = null;

  const getVerifiedZazaAppids = async () => {
    if (verifiedZazaAppids) return verifiedZazaAppids;
    const scan = await call<[], ZazaPositionScan>('get_zazamastro_position_candidates');
    verifiedZazaAppids = new Set(scan?.appids ?? []);
    return verifiedZazaAppids;
  };

  const emit = (processed: number, current?: string, phase?: ProcessableBatchKind, running = true) => {
    const phaseLabel = phase && phases.length > 1 ? `${labelForKind[phase]} · ` : '';
    onProgress({
      total: totalSteps,
      processed,
      changed: counters.changed,
      skipped: counters.skipped,
      failed: counters.failed,
      removed: counters.removed,
      current,
      lastError,
      message: running
        ? `${phaseLabel}${current ?? t('PA_READING_LIBRARY', 'Reading the library')}`
        : t('PA_BATCH_PHASE_DONE', '{operation}: done').replace('{operation}', labelForKind[kind]),
      running,
    });
  };

  /* Read once per run: the user's source order, minus whatever they switched off. */
  const coverPhase = phases.find(isCoverKind);
  const coverSources = coverPhase ? await enabledCoverSources(shapeForKind(coverPhase)) : [];
  if (coverPhase) log('bulk cover sources', shapeForKind(coverPhase), coverSources);
  const heroSources = phases.some(isHeroKind) ? await enabledCoverSources('hero') : [];
  if (heroSources.length) log('bulk hero sources', heroSources);

  emit(0, apps.length ? undefined : t('PA_NO_GAMES_FOUND', 'No games found'), phases[0]);

  let processed = 0;
  for (const phase of phases) {
    throwIfCancelled(signal);
    if (phase === 'perfectHeroReset') {
      // All removals finish before any hero is searched, downloaded or composed.
      for (const app of apps) {
        throwIfCancelled(signal);
        const current = app.display_name || String(app.appid);
        emit(processed, current, phase);
        try {
          if (await resetPerfectHeroForRegeneration(app, signal)) counters.removed += 1;
        } catch (error) {
          if ((error as Error)?.name === 'AbortError') throw error;
          heroResetFailures.set(app.appid, error);
          counters.failed += 1;
          lastError = `${current}: ${errorMessage(error)}`;
          log('Artwork Perfect Hero reset failed', app.appid, error);
        }
        processed += 1;
        emit(processed, current, phase);
      }
      continue;
    }
    if (isHeroKind(phase)) {
      // ZazaMastro discovery has priority; a regular 3840x1240 hero is prepared
      // only as fallback. Network work stays ahead of the Steam writer pool.
      const preparing = new Map<number, Promise<{ prepared?: PreparedHeroArtwork; error?: unknown }>>();
      const preparationWindow = ZAZA_PREPARE_CONCURRENCY;
      let nextToPrepare = 0;
      let nextToProcess = 0;

      const fillPreparationWindow = () => {
        throwIfCancelled(signal);
        while (nextToPrepare < apps.length && preparing.size < preparationWindow) {
          const prepareIndex = nextToPrepare;
          const app = apps[prepareIndex];
          preparing.set(
            prepareIndex,
            heroResetFailures.has(app.appid)
              ? Promise.resolve({ error: heroResetFailures.get(app.appid) })
              : prepareAutoPerfectHero(app, heroSources, replacesExisting(phase), signal)
                .then((prepared) => ({ prepared }))
                .catch((error) => ({ error }))
          );
          nextToPrepare += 1;
        }
      };

      fillPreparationWindow();

      const worker = async () => {
        while (true) {
          throwIfCancelled(signal);
          const index = nextToProcess;
          nextToProcess += 1;
          if (index >= apps.length) return;

          const app = apps[index];
          const current = app.display_name || String(app.appid);
          emit(processed, current, phase);
          let preparedForRelease: PreparedHeroArtwork | undefined;

          try {
            const task = preparing.get(index);
            if (!task) throw new Error(t('PA_ERROR_INTERNAL_ARTWORK', 'The artwork operation could not be completed.'));
            const outcome = await task;
            preparedForRelease = outcome.prepared;
            throwIfCancelled(signal);
            preparing.delete(index);
            fillPreparationWindow();
            if (outcome.error) throw outcome.error;
            if (!outcome.prepared) throw new Error(t('PA_ERROR_INTERNAL_ARTWORK', 'The artwork operation could not be completed.'));
            preparedForRelease = outcome.prepared;

            if (outcome.prepared.result === 'skipped') {
              log('bulk skipped', { phase, appid: app.appid, reason: outcome.prepared.skipReason });
            }

            const result = await withTimeout(
              applyPreparedHero3840(outcome.prepared),
              APP_TIMEOUT_MS,
              t('PA_ERROR_OPERATION_TIMEOUT', 'The operation took too long.')
            );
            counters[result] += 1;
          } catch (error) {
            if ((error as Error)?.name === 'AbortError') throw error;
            preparing.delete(index);
            fillPreparationWindow();
            // Reset failures already count once and must never launch regeneration.
            if (!heroResetFailures.has(app.appid)) counters.failed += 1;
            lastError = `${current}: ${errorMessage(error)}`;
            log('Artwork hero batch error', app.appid, current, error);
          } finally {
            if (preparedForRelease) {
              preparedForRelease.data = undefined;
              if (preparedForRelease.sourceToken) await call('release_artwork_transfer', preparedForRelease.sourceToken).catch(() => undefined);
            }
          }

          processed += 1;
          emit(processed, current, phase);
          await delay(16);
        }
      };

      try {
        await Promise.all(Array.from(
          { length: Math.min(ZAZA_PREPARE_CONCURRENCY, Math.max(1, apps.length)) }, () => worker()
        ));
      } finally {
        // Cancellation can arrive after preparation but before a worker adopts its result.
        await Promise.all([...preparing.values()].map(async task => {
          const { prepared } = await task;
          if (prepared?.sourceToken) await call('release_artwork_transfer', prepared.sourceToken).catch(() => undefined);
          if (prepared) prepared.data = undefined;
        }));
        preparing.clear();
      }
      continue;
    }

    if (phase === 'resetArtwork') {
      /*
        Everything custom goes, for every artwork type, and Steam re-downloads its own.
        Nothing is searched and nothing is downloaded, so this only needs the writer pool.
      */
      const types: SGDBAssetType[] = ['grid_p', 'grid_l', 'hero', 'logo', 'icon'];
      for (const app of apps) {
        throwIfCancelled(signal);
        const name = app.display_name || String(app.appid);
        emit(processed, name, phase);
        let cleared = false;
        let coverResetSucceeded = true;
        for (const assetType of types) {
          try {
            const local = await getLocalAssetInfo(app.appid, assetType);
            if (!local.exists) continue;
            await clearSteamArtworkSafely(app.appid, ASSET_TYPE[assetType], 0);
            cleared = true;
          } catch (error) {
            if (assetType === 'grid_p') coverResetSucceeded = false;
            log('reset artwork failed', app.appid, assetType, error);
            counters.failed += 1;
            lastError = `${name} (${assetType}): ${errorMessage(error)}`;
          }
        }
        if (coverResetSucceeded) {
          try {
            await clearDerivedCoverBackup(app.appid);
          } catch (error) {
            log('derived cover backup reset failed', app.appid, error);
            counters.failed += 1;
            lastError = `${name} (grid_p backup): ${errorMessage(error)}`;
          }
        }
        if (cleared) {
          // Perfect Hero bookkeeping and the hidden logo go with it.
          await Promise.all([
            call('delete_setting', `perfect_hero_${app.appid}`).catch(() => undefined),
            call('delete_setting', `perfect_hero_info_${app.appid}`).catch(() => undefined),
            call('delete_setting', `perfect_grid_l_${app.appid}`).catch(() => undefined),
            call('clear_perfect_source', app.appid, 'hero').catch(() => undefined),
            call('clear_perfect_source', app.appid, 'grid_l').catch(() => undefined),
            call('delete_setting', `logo_hidden_${app.appid}`).catch(() => undefined),
            call('delete_setting', `logo_position_backup_${app.appid}`).catch(() => undefined),
          ]);
          counters.changed += 1;
        } else {
          counters.skipped += 1;
        }
        processed += 1;
        emit(processed, name, phase);
      }
      continue;
    }

    if (isCoverKind(phase) || phase === 'banner920' || phase === 'missingLogos') {
      const preparing = new Map<number, Promise<{ prepared?: PreparedBulkArtwork; error?: unknown }>>();
      const preparationWindow = STANDARD_PREPARE_CONCURRENCY;
      let nextToPrepare = 0;
      let nextToProcess = 0;

      const fillPreparationWindow = () => {
        throwIfCancelled(signal);
        while (nextToPrepare < apps.length && preparing.size < preparationWindow) {
          const prepareIndex = nextToPrepare;
          const app = apps[prepareIndex];
          preparing.set(
            prepareIndex,
            prepareBulkArtwork(phase, app, coverSources, signal)
              .then((prepared) => ({ prepared }))
              .catch((error) => ({ error }))
          );
          nextToPrepare += 1;
        }
      };

      fillPreparationWindow();

      const worker = async () => {
        while (true) {
          throwIfCancelled(signal);
          const index = nextToProcess;
          nextToProcess += 1;
          if (index >= apps.length) return;

          const app = apps[index];
          const current = app.display_name || String(app.appid);
          emit(processed, current, phase);
          let preparedForRelease: PreparedBulkArtwork | undefined;

          try {
            const task = preparing.get(index);
            if (!task) throw new Error(t('PA_ERROR_INTERNAL_ARTWORK', 'The artwork operation could not be completed.'));
            const outcome = await task;
            throwIfCancelled(signal);
            preparing.delete(index);
            fillPreparationWindow();
            if (outcome.error) throw outcome.error;
            if (!outcome.prepared) throw new Error(t('PA_ERROR_INTERNAL_ARTWORK', 'The artwork operation could not be completed.'));
            preparedForRelease = outcome.prepared;

            if (outcome.prepared.result === 'skipped') {
              log('bulk skipped', { phase, appid: app.appid, reason: outcome.prepared.skipReason });
            }

            const result = await withTimeout(
              applyPreparedBulkArtwork(outcome.prepared),
              APP_TIMEOUT_MS,
              t('PA_ERROR_OPERATION_TIMEOUT', 'The operation took too long.')
            );
            counters[result] += 1;
          } catch (error) {
            if ((error as Error)?.name === 'AbortError') throw error;
            preparing.delete(index);
            fillPreparationWindow();
            counters.failed += 1;
            lastError = `${current}: ${errorMessage(error)}`;
            log('Artwork bulk error', phase, app.appid, current, error);
          } finally {
            if (preparedForRelease) {
              preparedForRelease.data = undefined;
            }
          }

          processed += 1;
          emit(processed, current, phase);
          await delay(16);
        }
      };

      await Promise.all(
        Array.from(
          { length: Math.min(STANDARD_PREPARE_CONCURRENCY, Math.max(1, apps.length)) },
          () => worker()
        )
      );
      continue;
    }

    // Fix combines hidden-logo registration and ZazaMastro positioning in one
    // Steam call per logo. The marker scan is local and performed only once.
    const zazaAppids = await getVerifiedZazaAppids();
    let nextToProcess = 0;
    const worker = async () => {
      while (true) {
        throwIfCancelled(signal);
        const index = nextToProcess;
        nextToProcess += 1;
        if (index >= apps.length) return;

        const app = apps[index];
        const current = app.display_name || String(app.appid);
        emit(processed, current, phase);

        try {
          const result = await withTimeout(
            applyLogoFix(app.appid, zazaAppids.has(app.appid)),
            APP_TIMEOUT_MS,
            'Fix logo timeout'
          );
          counters[result] += 1;
        } catch (error) {
          if ((error as Error)?.name === 'AbortError') throw error;
          counters.failed += 1;
          lastError = `${current}: ${errorMessage(error)}`;
          log('Artwork logo fix error', app.appid, current, error);
        }

        processed += 1;
        emit(processed, current, phase);
        await delay(0);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(steamWriteConcurrency, Math.max(1, apps.length)) },
        () => worker()
      )
    );
  }

  const finalProgress: ZazaBatchProgress = {
    total: totalSteps,
    processed,
    changed: counters.changed,
    skipped: counters.skipped,
    failed: counters.failed,
    removed: counters.removed,
    lastError,
    message: t('PA_BATCH_COMPLETED', '{operation} completed').replace('{operation}', labelForKind[kind]),
    running: false,
  };
  onProgress(finalProgress);
  return finalProgress;
};
