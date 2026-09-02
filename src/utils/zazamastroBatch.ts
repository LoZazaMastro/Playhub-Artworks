import { call, fetchNoCors } from '@decky/api';

import { ArtworkProviderId, ASSET_TYPE, DIMENSIONS, MIMES, STYLES } from '../constants';
import { SGDB_API_BASE } from '../hooks/useSGDB';

import getAppOverview from './getAppOverview';
import log from './log';
import { normalizeArtworkPayload } from './normalizeArtworkPayload';

type CoverBatchKind = 'squareReplace' | 'squareMissing' | 'portraitReplace' | 'portraitMissing';
type HeroBatchKind = 'perfectHeroReplace' | 'perfectHeroMissing';
type ProcessableBatchKind = CoverBatchKind | HeroBatchKind | 'banner920' | 'missingLogos' | 'logoFix' | 'resetArtwork';
type BatchKind = ProcessableBatchKind | 'fixAll';
export type ZazaBatchKind = BatchKind;

export interface ZazaBatchProgress {
  total: number;
  processed: number;
  changed: number;
  skipped: number;
  failed: number;
  current?: string;
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
const DOWNLOAD_TIMEOUT_MS = 22000;
const STEAM_ARTWORK_TIMEOUT_MS = 10000;
const APP_TIMEOUT_MS = 30000;
const ZAZA_APP_TIMEOUT_MS = 65000;
const ZAZA_PREPARE_CONCURRENCY = 8;
const STANDARD_PREPARE_CONCURRENCY = 10;
const BULK_LOOKAHEAD = 20;

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

const labelForKind: Record<BatchKind, string> = {
  squareReplace: 'Cover quadrate',
  squareMissing: 'Cover quadrate mancanti',
  portraitReplace: 'Cover verticali',
  portraitMissing: 'Cover verticali mancanti',
  perfectHeroReplace: 'Perfect Hero',
  perfectHeroMissing: 'Perfect Hero mancanti',
  banner920: 'Banner',
  missingLogos: 'Loghi',
  logoFix: 'Fix',
  resetArtwork: 'Ripristino artwork Steam',
  fixAll: 'Tutto',
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

const phasesForKind = (kind: BatchKind): ProcessableBatchKind[] => (
  kind === 'fixAll'
    ? ['portraitMissing', 'perfectHeroMissing', 'banner920', 'missingLogos', 'logoFix']
    : [kind]
);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

const apiRequest = async (url: string): Promise<any[]> => {
  const apiKey = String(await call<[key: string, fallback: string], string>(
    'get_setting',
    'steamgriddb_api_key',
    ''
  )).trim();
  if (!apiKey) {
    throw new Error('Configura la tua chiave API SteamGridDB prima di avviare un completamento automatico.');
  }
  const response = await withTimeout(fetchNoCors(`${SGDB_API_BASE}${url}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  }), API_TIMEOUT_MS, 'SteamGridDB API timeout');

  if (response.status === 404) return [];

  const body = await withTimeout(response.json(), JSON_TIMEOUT_MS, 'SteamGridDB risposta timeout');
  if (!body?.success) {
    const message = Array.isArray(body?.errors) ? body.errors.join(', ') : 'SteamGridDB API error';
    throw new Error(message);
  }

  return body.data ?? [];
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
  } else if (DIMENSIONS[assetType].default.length > 0) {
    params.set('dimensions', DIMENSIONS[assetType].default.join(','));
  }

  return params.toString();
};

const searchGames = async (term: string) => {
  if (!term.trim()) return [];
  return await apiRequest(`/search/autocomplete/${encodeURIComponent(encodeURIComponent(term))}`);
};

/** Every usable asset for an app, largest first. */
const allUsefulAssets = (assets: any[]) => assets
  .filter((asset) => asset?.url && !String(asset.url).includes('.webm'))
  .sort((a, b) => (Number(b.width) * Number(b.height)) - (Number(a.width) * Number(a.height)));

const firstUsefulAsset = (assets: any[], predicate?: (asset: any) => boolean) => {
  return assets.find((asset) => {
    if (!asset?.url) return false;
    if (typeof asset.url === 'string' && asset.url.includes('.webm')) return false;
    return predicate ? predicate(asset) : true;
  }) ?? null;
};

const findAssetForApp = async (
  app: ZazaLibraryApp,
  assetType: SGDBAssetType,
  options: AssetSearchOptions = {}
) => {
  const endpoint = endpointForAsset[assetType];
  const pages = options.pages ?? 2;

  // Steam app ids can be queried directly. Shortcut ids normally cannot, so those use name search below.
  if (!app.is_shortcut) {
    let sawSteamAssets = false;
    for (let page = 0; page < pages; page += 1) {
      const qs = getApiParams(assetType, page, options);
      const assets = await apiRequest(`/${endpoint}/steam/${app.appid}?${qs}`);
      if (assets.length > 0) sawSteamAssets = true;
      const asset = firstUsefulAsset(assets, options.predicate);
      if (asset) return asset;
      if (assets.length === 0) break;
    }

    // If SGDB recognized the Steam AppID, a second autocomplete/game-id pass
    // would query the same title again. Keep name fallback only for unmapped IDs.
    if (sawSteamAssets) return null;
  }

  const name = app.display_name?.trim();
  if (!name) {
    log('ZazaMastro app without a name, name search skipped', app.appid);
    return null;
  }

  const games = await searchGames(name);
  const gameId = games[0]?.id;
  if (!gameId) return null;

  for (let page = 0; page < pages; page += 1) {
    const qs = getApiParams(assetType, page, options);
    const assets = await apiRequest(`/${endpoint}/game/${gameId}?${qs}`);
    const asset = firstUsefulAsset(assets, options.predicate);
    if (asset) return asset;
    if (assets.length === 0) break;
  }

  return null;
};

/** The single biggest asset of a type for an app, across every page searched. */
const largestAssetForApp = async (
  app: ZazaLibraryApp,
  assetType: SGDBAssetType,
  options: AssetSearchOptions = {}
) => {
  const endpoint = endpointForAsset[assetType];
  const pages = options.pages ?? 2;
  const found: any[] = [];

  const collect = async (path: string) => {
    for (let page = 0; page < pages; page += 1) {
      const assets = await apiRequest(`${path}?${getApiParams(assetType, page, options)}`);
      found.push(...allUsefulAssets(assets));
      if (assets.length === 0) break;
    }
  };

  if (!app.is_shortcut) {
    await collect(`/${endpoint}/steam/${app.appid}`);
  }
  if (found.length === 0) {
    const name = app.display_name?.trim();
    if (!name) {
      log('ZazaMastro app without a name, largest-asset search skipped', app.appid);
      return null;
    }
    const games = await searchGames(name);
    const gameId = games[0]?.id;
    if (!gameId) return null;
    await collect(`/${endpoint}/game/${gameId}`);
  }

  return allUsefulAssets(found)[0] ?? null;
};

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
    return await call<[appid: number, asset_type: string], LocalAssetInfo>('get_local_asset_info', appId, assetType);
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
      'Lettura marker ZazaMastro timeout'
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
      'Salvataggio marker ZazaMastro timeout'
    );
  } catch (error) {
    log('ZazaMastro marker save failed', appId, error);
  }
};

const downloadAssetPayload = async (url: string): Promise<DownloadedAssetPayload> => {
  return await withTimeout(
    call<[url: string], DownloadedAssetPayload>('download_asset_payload', url),
    DOWNLOAD_TIMEOUT_MS,
    'Download artwork timeout'
  );
};

const applyDownloadedAsset = async (appId: number, assetType: SGDBAssetType, payload: { data: string; format: string; animated?: boolean }) => {
  const normalized = await normalizeArtworkPayload(payload);
  await withTimeout(Promise.resolve(SteamClient.Apps.ClearCustomArtworkForApp(appId, ASSET_TYPE[assetType])), STEAM_ARTWORK_TIMEOUT_MS, 'Clear artwork timeout');
  // Steam resolves ClearCustomArtworkForApp before the cache write is fully visible.
  // Keep a short pause even with multiple writers so Clear -> Set stays reliable.
  await delay(180);
  await withTimeout(Promise.resolve(SteamClient.Apps.SetCustomArtworkForApp(appId, normalized.data, normalized.format, ASSET_TYPE[assetType])), STEAM_ARTWORK_TIMEOUT_MS, 'Set artwork timeout');
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

const setMinimalLogoPosition = async (appId: number) => {
  await setLogoPosition(appId, MIN_LOGO_POSITION, 'Logo position timeout');
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

const loadBitmap = (source: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('Immagine non caricabile.'));
  image.src = source;
});

/** Canvas work needs a `data:` URL; anything else taints it and `toDataURL` throws. */
const asDataUrl = async (source: string): Promise<string> => {
  if (!source) return '';
  if (source.startsWith('data:')) return source;
  try {
    const response = await fetchNoCors(source, { method: 'GET' });
    if (!response?.ok) return '';
    const blob = await response.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(blob);
    });
  } catch (_) {
    return '';
  }
};

/** The logo already installed for this game, if there is one. */
const installedLogoDataUrl = async (appId: number): Promise<string> => {
  try {
    const overview = await withTimeout(getAppOverview(appId), 2000, 'Steam overview timeout');
    if (!overview) return '';
    const url = window.appStore?.GetCustomLogoImageURLs?.(overview)?.[0]
      ?? (overview as any)?.m_strLogoURL
      ?? '';
    return url ? await asDataUrl(String(url)) : '';
  } catch (_) {
    return '';
  }
};

/** Caps the kept-aside original so it fits through the plugin bridge. */
const PRISTINE_MAX_WIDTH = 4096;

const boundedSourceData = async (dataUrl: string): Promise<{ data: string; ext: string } | null> => {
  try {
    const image = await loadBitmap(dataUrl);
    if (image.naturalWidth <= PRISTINE_MAX_WIDTH) {
      const payload = dataUrl.split(',', 2)[1] ?? '';
      const ext = /image\/(png|webp|jpe?g)/i.exec(dataUrl)?.[1]?.replace('jpeg', 'jpg') ?? 'jpg';
      return payload ? { data: payload, ext } : null;
    }
    const scale = PRISTINE_MAX_WIDTH / image.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = PRISTINE_MAX_WIDTH;
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL('image/jpeg', 0.95).split(',', 2)[1] ?? '', ext: 'jpg' };
  } catch (_) {
    return null;
  }
};

const composePerfectHero = async (heroSource: string, logoSource: string): Promise<{ data: string; format: 'jpg' }> => {
  const hero = await loadBitmap(heroSource);
  const canvas = document.createElement('canvas');
  canvas.width = PERFECT_WIDTH;
  canvas.height = PERFECT_HEIGHT;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Compositing non disponibile.');

  context.fillStyle = '#000';
  context.fillRect(0, 0, PERFECT_WIDTH, PERFECT_HEIGHT);

  // Cover-fit: fill the frame and centre whatever overflows.
  const ratio = Math.max(PERFECT_WIDTH / hero.naturalWidth, PERFECT_HEIGHT / hero.naturalHeight);
  const drawWidth = hero.naturalWidth * ratio;
  const drawHeight = hero.naturalHeight * ratio;
  context.drawImage(
    hero,
    (PERFECT_WIDTH - drawWidth) / 2,
    (PERFECT_HEIGHT - drawHeight) / 2,
    drawWidth,
    drawHeight
  );

  if (logoSource) {
    try {
      const logo = await loadBitmap(logoSource);
      const width = (PERFECT_WIDTH * STANDARD_LOGO.scale) / 100;
      const height = (width * logo.naturalHeight) / logo.naturalWidth;
      const left = (PERFECT_WIDTH * STANDARD_LOGO.x) / 100 - width / 2;
      const top = (PERFECT_HEIGHT * STANDARD_LOGO.y) / 100 - height / 2;
      // A soft drop shadow keeps a light logo readable over a light background.
      context.save();
      context.shadowColor = 'rgba(0, 0, 0, 0.55)';
      context.shadowBlur = Math.round(PERFECT_WIDTH * 0.006);
      context.shadowOffsetY = Math.round(PERFECT_WIDTH * 0.003);
      context.drawImage(logo, left, top, width, height);
      context.restore();
    } catch (error) {
      // A hero without its logo is still better than no hero.
      log('ZazaMastro automatic hero without logo', error);
    }
  }

  const data = canvas.toDataURL('image/jpeg', 0.95).split(',', 2)[1] ?? '';
  if (!data) throw new Error('Composizione vuota.');
  return { data, format: 'jpg' };
};

/** The biggest background any enabled source has, in priority order. */
const largestHeroFromSources = async (
  app: ZazaLibraryApp,
  sources: ArtworkProviderId[]
): Promise<any> => {
  const chain = sources.length ? sources : (['steamgriddb'] as ArtworkProviderId[]);
  for (const provider of chain) {
    if (provider === 'steamgriddb') {
      const asset = await largestAssetForApp(app, 'hero', { pages: 3 });
      if (asset?.url) return asset;
      continue;
    }
    const name = app.display_name?.trim();
    if (!name) continue;
    try {
      const results = await call<[
        provider: string, title: string, assetType: string, squareOnly: boolean, limit: number,
        minimumQuality: string, mimes: string[], contentType: string, query: string, exactSize: string,
      ], any[]>('search_provider_assets', provider, name, 'hero', false, 12, 'any', [], 'all', '', '');
      const best = allUsefulAssets(results ?? [])[0];
      if (best?.url) return best;
    } catch (error) {
      log('bulk hero provider search failed', provider, app.appid, error);
    }
  }
  return null;
};

const prepareAutoPerfectHero = async (
  rawApp: ZazaLibraryApp,
  sources: ArtworkProviderId[],
  replace: boolean
): Promise<PreparedHeroArtwork> => {
  const name = rawApp.display_name || String(rawApp.appid);

  const [currentHero, marker, alreadyPerfect] = await Promise.all([
    getLocalAssetInfo(rawApp.appid, 'hero'),
    getZazaHeroMarker(rawApp.appid),
    call<[key: string, fallback: boolean], boolean>('get_setting', `perfect_hero_${rawApp.appid}`, false)
      .catch(() => false),
  ]);

  /*
    "Only the missing ones" means: a game that already carries the ZazaMastro hero it
    should have, or that already has a Perfect Hero, is left alone. A NEW ZazaMastro
    artwork still lands, because the check below is against the artwork actually
    installed, not against a "done" flag.
  */
  const hasZazaHero = currentHero.source === 'custom' && currentHero.sha256 && marker.sha256 === currentHero.sha256;
  if (!replace && hasZazaHero) {
    return { app: rawApp, name, result: 'skipped', isZazaMastro: true, skipReason: 'hero LoZazaMastro già applicato' };
  }
  if (!replace && alreadyPerfect) {
    return { app: rawApp, name, result: 'skipped', isZazaMastro: false, skipReason: 'Perfect Hero già presente' };
  }

  const app = await normalizeApp(rawApp);

  // The one ZazaMastro artwork check that is worth a request: it wins over anything else.
  const zazaAsset = await findAssetForApp(app, 'hero', { pages: 4, predicate: isZazaMastroAsset });
  if (zazaAsset?.url) {
    const payload = await downloadAssetPayload(zazaAsset.url);
    return {
      app,
      name: app.display_name || name,
      result: 'ready',
      isZazaMastro: true,
      assetUrl: zazaAsset.url,
      data: payload.data,
      sha256: payload.sha256,
      format: payload.format,
      animated: payload.animated,
    };
  }

  const hero = await largestHeroFromSources(app, sources);
  if (!hero?.url) {
    return { app, name: app.display_name || name, result: 'skipped', isZazaMastro: false, skipReason: 'nessuno sfondo disponibile' };
  }

  const heroData = await asDataUrl(String(hero.url));
  if (!heroData) {
    return { app, name: app.display_name || name, result: 'skipped', isZazaMastro: false, skipReason: 'sfondo non scaricabile' };
  }

  // The installed logo first; SteamGridDB only if the game has none.
  let logoData = await installedLogoDataUrl(app.appid);
  if (!logoData) {
    const logo = await largestAssetForApp(app, 'logo', { pages: 1 });
    if (logo?.url) logoData = await asDataUrl(String(logo.url));
  }

  /*
    Keep the untouched background.

    Without this the editor, opened later on a game the bulk had already done, found no
    stored source and fell back to the INSTALLED hero - which is the composition itself.
    Editing then drew a second logo on top of the first.
  */
  try {
    const bounded = await boundedSourceData(heroData);
    if (bounded?.data) await call('save_perfect_source', app.appid, 'hero', bounded.data, bounded.ext);
  } catch (error) {
    log('bulk pristine hero not stored', app.appid, error);
  }

  const composed = await composePerfectHero(heroData, logoData);
  return {
    app,
    name: app.display_name || name,
    result: 'ready',
    isZazaMastro: false,
    perfectComposition: true,
    assetUrl: String(hero.url),
    data: composed.data,
    format: composed.format,
    animated: false,
  };
};

const applyPreparedHero3840 = async (prepared: PreparedHeroArtwork): Promise<ProcessResult> => {
  if (prepared.result === 'skipped') return 'skipped';

  if (prepared.result === 'ready') {
    if (!prepared.data) throw new Error('Prepared hero artwork is incomplete');
    await applyDownloadedAsset(prepared.app.appid, 'hero', { data: prepared.data, format: prepared.format || 'png', animated: prepared.animated });
  }

  if (prepared.isZazaMastro || prepared.perfectComposition) {
    /*
      Both a ZazaMastro hero and one composed here already carry the logo, so Steam's
      separate logo layer is switched off. A plain 3840x1240 fallback does not, and
      leaves the user's logo position untouched.
    */
    await setMinimalLogoPosition(prepared.app.appid);
    await withTimeout(
      call('set_setting', `logo_visible_${prepared.app.appid}`, false),
      3000,
      'Salvataggio visibilità logo timeout'
    );
    // Flagged as a Perfect Hero so the game page offers to undo it.
    await withTimeout(
      call('set_setting', `perfect_hero_${prepared.app.appid}`, true),
      3000,
      'Salvataggio Perfect Hero timeout'
    ).catch(() => undefined);
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
    return firstUsefulAsset(results ?? []);
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
  sources: ArtworkProviderId[]
): Promise<PreparedBulkArtwork> => {
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
    return { app: rawApp, name: label, result: 'skipped', skipReason: 'cover già di questa forma' };
  }
  if (kind === 'banner920' && local.exists && local.width && local.height && local.width >= 920 && local.height >= 430) {
    return { app: rawApp, name: label, result: 'skipped', skipReason: 'banner già presente' };
  }
  if (kind === 'missingLogos' && local.exists && (!local.width || local.width > 1) && (!local.height || local.height > 1)) {
    return { app: rawApp, name: label, result: 'skipped', skipReason: 'logo già presente' };
  }

  const app = await normalizeApp(rawApp);
  const name = app.display_name || label;

  let asset: any = null;
  if (cover) {
    if (sources.length === 0) {
      return { app, name, result: 'skipped', skipReason: 'nessuna sorgente attiva' };
    }
    const found = await findCoverForApp(app, shapeForKind(kind), sources);
    asset = found?.asset ?? null;
  } else {
    asset = await findAssetForApp(app, assetType, kind === 'banner920' ? { dimensions: '920x430' } : {});
  }

  if (!asset?.url) {
    return { app, name, result: 'skipped', skipReason: 'nessun artwork trovato' };
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
    throw new Error('Prepared bulk artwork is incomplete');
  }

  await applyDownloadedAsset(prepared.app.appid, prepared.assetType, { data: prepared.data, format: prepared.format || 'png', animated: prepared.animated });
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
  requestedSteamWrites = 4
) => {
  const steamWriteConcurrency = Math.max(4, Math.min(10, Math.round(requestedSteamWrites || 4)));
  const apps = await getLibraryApps();
  const phases = phasesForKind(kind);
  const totalSteps = apps.length * phases.length;
  const counters = { changed: 0, skipped: 0, failed: 0 };
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
      current,
      message: running
        ? `${phaseLabel}${current ?? 'Lettura della libreria'}`
        : `${labelForKind[kind]}: fatto`,
      running,
    });
  };

  /* Read once per run: the user's source order, minus whatever they switched off. */
  const coverPhase = phases.find(isCoverKind);
  const coverSources = coverPhase ? await enabledCoverSources(shapeForKind(coverPhase)) : [];
  if (coverPhase) log('bulk cover sources', shapeForKind(coverPhase), coverSources);
  const heroSources = phases.some(isHeroKind) ? await enabledCoverSources('hero') : [];
  if (heroSources.length) log('bulk hero sources', heroSources);

  emit(0, apps.length ? undefined : 'Nessun gioco trovato', phases[0]);

  let processed = 0;
  for (const phase of phases) {
    if (isHeroKind(phase)) {
      // ZazaMastro discovery has priority; a regular 3840x1240 hero is prepared
      // only as fallback. Network work stays ahead of the Steam writer pool.
      const preparing = new Map<number, Promise<{ prepared?: PreparedHeroArtwork; error?: unknown }>>();
      const preparationWindow = Math.max(ZAZA_PREPARE_CONCURRENCY, steamWriteConcurrency * 2);
      let nextToPrepare = 0;
      let nextToProcess = 0;

      const fillPreparationWindow = () => {
        while (nextToPrepare < apps.length && preparing.size < preparationWindow) {
          const prepareIndex = nextToPrepare;
          const app = apps[prepareIndex];
          preparing.set(
            prepareIndex,
            withTimeout(
              prepareAutoPerfectHero(app, heroSources, replacesExisting(phase)),
              ZAZA_APP_TIMEOUT_MS,
              'Preparazione hero timeout'
            )
              .then((prepared) => ({ prepared }))
              .catch((error) => ({ error }))
          );
          nextToPrepare += 1;
        }
      };

      fillPreparationWindow();

      const worker = async () => {
        while (true) {
          const index = nextToProcess;
          nextToProcess += 1;
          if (index >= apps.length) return;

          const app = apps[index];
          const current = app.display_name || String(app.appid);
          emit(processed, current, phase);

          try {
            const task = preparing.get(index);
            if (!task) throw new Error('Hero preparation task missing');
            const outcome = await task;
            preparing.delete(index);
            fillPreparationWindow();
            if (outcome.error) throw outcome.error;
            if (!outcome.prepared) throw new Error('Hero preparation returned no result');

            if (outcome.prepared.result === 'skipped') {
              log('bulk skipped', { phase, appid: app.appid, reason: outcome.prepared.skipReason });
            }

            const result = await withTimeout(
              applyPreparedHero3840(outcome.prepared),
              APP_TIMEOUT_MS,
              'Applicazione hero timeout'
            );
            counters[result] += 1;
          } catch (error) {
            preparing.delete(index);
            fillPreparationWindow();
            counters.failed += 1;
            log('Artwork hero batch error', app.appid, current, error);
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
      continue;
    }

    if (phase === 'resetArtwork') {
      /*
        Everything custom goes, for every artwork type, and Steam re-downloads its own.
        Nothing is searched and nothing is downloaded, so this only needs the writer pool.
      */
      const types: SGDBAssetType[] = ['grid_p', 'grid_l', 'hero', 'logo', 'icon'];
      for (const app of apps) {
        const name = app.display_name || String(app.appid);
        emit(processed, name, phase);
        let cleared = false;
        for (const assetType of types) {
          try {
            const local = await getLocalAssetInfo(app.appid, assetType);
            if (!local.exists) continue;
            await withTimeout(
              Promise.resolve(SteamClient.Apps.ClearCustomArtworkForApp(app.appid, ASSET_TYPE[assetType])),
              STEAM_ARTWORK_TIMEOUT_MS,
              'Clear artwork timeout'
            );
            cleared = true;
          } catch (error) {
            log('reset artwork failed', app.appid, assetType, error);
            counters.failed += 1;
          }
        }
        if (cleared) {
          // Perfect Hero bookkeeping and the hidden logo go with it.
          await Promise.all([
            call('delete_setting', `perfect_hero_${app.appid}`).catch(() => undefined),
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
      const preparationWindow = Math.max(BULK_LOOKAHEAD, STANDARD_PREPARE_CONCURRENCY, steamWriteConcurrency * 2);
      let nextToPrepare = 0;
      let nextToProcess = 0;

      const fillPreparationWindow = () => {
        while (nextToPrepare < apps.length && preparing.size < preparationWindow) {
          const prepareIndex = nextToPrepare;
          const app = apps[prepareIndex];
          preparing.set(
            prepareIndex,
            withTimeout(prepareBulkArtwork(phase, app, coverSources), ZAZA_APP_TIMEOUT_MS, 'Preparazione artwork timeout')
              .then((prepared) => ({ prepared }))
              .catch((error) => ({ error }))
          );
          nextToPrepare += 1;
        }
      };

      fillPreparationWindow();

      const worker = async () => {
        while (true) {
          const index = nextToProcess;
          nextToProcess += 1;
          if (index >= apps.length) return;

          const app = apps[index];
          const current = app.display_name || String(app.appid);
          emit(processed, current, phase);

          try {
            const task = preparing.get(index);
            if (!task) throw new Error('Bulk preparation task missing');
            const outcome = await task;
            preparing.delete(index);
            fillPreparationWindow();
            if (outcome.error) throw outcome.error;
            if (!outcome.prepared) throw new Error('Bulk preparation returned no result');

            if (outcome.prepared.result === 'skipped') {
              log('bulk skipped', { phase, appid: app.appid, reason: outcome.prepared.skipReason });
            }

            const result = await withTimeout(
              applyPreparedBulkArtwork(outcome.prepared),
              APP_TIMEOUT_MS,
              'Applicazione artwork timeout'
            );
            counters[result] += 1;
          } catch (error) {
            preparing.delete(index);
            fillPreparationWindow();
            counters.failed += 1;
            log('Artwork bulk error', phase, app.appid, current, error);
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
      continue;
    }

    // Fix combines hidden-logo registration and ZazaMastro positioning in one
    // Steam call per logo. The marker scan is local and performed only once.
    const zazaAppids = await getVerifiedZazaAppids();
    let nextToProcess = 0;
    const worker = async () => {
      while (true) {
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
          counters.failed += 1;
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
    message: `${labelForKind[kind]} completato`,
    running: false,
  };
  onProgress(finalProgress);
  return finalProgress;
};
