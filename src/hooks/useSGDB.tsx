import {
  useState,
  createContext,
  FC,
  useEffect,
  useContext,
  useCallback,
  useMemo,
  ReactNode,
} from 'react';
import { call, fetchNoCors } from '@decky/api';

import getAppOverview from '../utils/getAppOverview';
import log from '../utils/log';
import {
  ARTWORK_PROVIDERS, ASSET_TYPE, MIMES, STYLES, DIMENSIONS, providerForId, coverShapesForProvider,
} from '../constants';
import getAppDetails from '../utils/getAppDetails';
import showRestartConfirm from '../utils/showRestartConfirm';
import getCurrentSteamUserId from '../utils/getCurrentSteamUserId';
import getCustomLogoPosition from '../utils/getCustomLogoPosition';
import { DEFAULT_LOGO_POSITION, writeLogoPosition } from '../utils/logoControl';
import { runArtworkJob } from '../utils/artworkJobStore';
import { ArtworkPayload, normalizeArtworkPayload } from '../utils/normalizeArtworkPayload';

export const SGDB_API_BASE = process.env.ROLLUP_ENV === 'development' ? 'http://sgdb.test/api/v2' : 'https://www.steamgriddb.com/api/v2';

export type SGDBContextType = {
  appId: number | null;
  setAppId: React.Dispatch<React.SetStateAction<number | null>>;
  appOverview: AppStoreAppOverview;
  searchAssets: (assetType: SGDBAssetType, options: {gameId?: number | null, gameName?: string, gameProvider?: string, filters?: any, page?: number, signal?: AbortSignal}) => Promise<Array<any>>;
  searchGames: (term: string) => Promise<Array<any>>;
  getSgdbGame: (sgdbGame: any) => Promise<any>;
  getSgdbGameBySteamAppId: (steamAppId: number) => Promise<any>;
  changeAsset: (data: string, assetType: SGDBAssetType | eAssetType, format?: 'png' | 'jpg') => Promise<void>;
  changeAssetFromUrl: (location: string, assetType: SGDBAssetType | eAssetType, path?: boolean) => Promise<void>;
  clearAsset: (assetType: SGDBAssetType | eAssetType) => Promise<void>;
  apiConfigured: boolean;
}

const getAmbiguousAssetType = (assetType: SGDBAssetType | eAssetType) => typeof assetType === 'number' ? assetType : ASSET_TYPE[assetType];

/** Never let a backend hiccup turn into `Cannot read properties of undefined`. */
export const readApiKey = async (): Promise<string> => {
  try {
    const key = await call<[], string>('get_steamgriddb_api_key');
    return typeof key === 'string' ? key.trim() : '';
  } catch (_) {
    return '';
  }
};

const getApiParams = (assetType: SGDBAssetType, filters: any, page: number) => {
  let adult = 'false';
  let humor = 'any';
  let epilepsy = 'any';
  let oneoftag = '';

  if (filters?.untagged === true) {
    if (filters?.humor === false) {
      humor = 'false';
    }

    if (filters?.adult === false) {
      adult = 'false';
    }

    if (filters?.adult === true) {
      adult = 'any';
    }

    if (filters?.epilepsy === false) {
      epilepsy = 'false';
    }
  } else {
    const selectedTags = [];
    if (filters?.humor === true) {
      humor = 'any';
      selectedTags.push('humor');
    }

    if (filters?.adult === true) {
      adult = 'any';
      selectedTags.push('nsfw');
    }

    if (filters?.epilepsy === true) {
      epilepsy = 'any';
      selectedTags.push('epilepsy');
    }

    oneoftag = selectedTags.join(',');
  }

  return new URLSearchParams({
    page: page.toString(),
    styles:  filters?.styles ?? STYLES[assetType].default.join(','),
    dimensions: filters?.dimensions ?? DIMENSIONS[assetType].default.join(','),
    mimes: filters?.mimes ?? MIMES[assetType].default.join(','),
    nsfw: adult,
    humor,
    epilepsy,
    oneoftag,
    types: [filters?._static && 'static', filters?.animated && 'animated'].filter(Boolean).join(','),
  }).toString();
};

export const SGDBContext = createContext({});

export const SGDBProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [appId, setAppId] = useState<number>(0);
  const [appOverview, setAppOverview] = useState<AppStoreAppOverview | null>(null);
  const [apiConfigured, setApiConfigured] = useState(false);

  const clearAsset: SGDBContextType['clearAsset'] = useCallback(async (assetType) => {
    assetType = getAmbiguousAssetType(assetType);
    if (assetType === ASSET_TYPE.icon) {
      if (appOverview?.BIsShortcut()) {
        const res = await call<[
          appid: number | null,
          owner_id: string,
          path: string | null,
        ], string>('set_shortcut_icon',
          appId,
          getCurrentSteamUserId(),
          null // null removes the icon
        );
        if (res !== 'icon_is_same_path') showRestartConfirm();
      } else {
        if (appOverview) {
          // Redownload the icon from Steam
          await call<[
            appid: number | null,
            url: string,
          ]>('set_steam_icon_from_url',
            appId,
            window.appStore.GetIconURLForApp(appOverview)
          );
        }
      }
    } else {
      await SteamClient.Apps.ClearCustomArtworkForApp(appId, assetType);
      // ClearCustomArtworkForApp() resolves instantly instead of after clearing, so we need to wait a bit.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }, [appId, appOverview]);

  const changeAsset: SGDBContextType['changeAsset'] = useCallback(async (data, assetType, format = 'png') => {
    assetType = getAmbiguousAssetType(assetType);
    try {
      await clearAsset(assetType);
      await SteamClient.Apps.SetCustomArtworkForApp(appId, data, format, assetType);

      /*
        Steam only renders the logo layer for an app that already owns a custom logo
        position. A game that never had a logo therefore stayed blank after applying one:
        the file was written but nothing was ever mounted.
      */
      if (assetType === ASSET_TYPE.logo && appId) {
        try {
          const logoPos = await getCustomLogoPosition(appId);
          if (!logoPos) await writeLogoPosition(appId, DEFAULT_LOGO_POSITION);
        } catch (positionError) {
          log('logo position seed failed', positionError);
        }
      }
    } catch (error) {
      log(error);
      throw error;
    }
  }, [appId, clearAsset]);

  const apiRequest = useCallback(async (url: string, signal?: AbortSignal): Promise<any> => {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const apiKey = await readApiKey();
    setApiConfigured(Boolean(apiKey));
    if (!apiKey) {
      throw new Error('Inserisci la tua chiave API SteamGridDB nelle impostazioni di Playhub Artworks.');
    }

    /*
      Every step here is checked explicitly. When the transport hands back something
      unexpected, an unguarded `res.json()` surfaced as a bare
      "Cannot read properties of undefined" in a toast, with no way to tell what failed.
    */
    let res: any;
    try {
      res = await fetchNoCors(`${SGDB_API_BASE}${url}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal,
      });
    } catch (error: any) {
      if (error?.name === 'AbortError') throw error;
      log('sgdb request failed', { url, message: error?.message, stack: error?.stack });
      throw new Error('SteamGridDB non raggiungibile. Controlla la connessione.');
    }

    if (!res) {
      log('sgdb request returned nothing', { url });
      throw new Error('SteamGridDB non ha risposto.');
    }

    let assetRes: any;
    try {
      if (typeof res.json === 'function') {
        assetRes = await res.json();
      } else {
        const body = typeof res.text === 'function' ? await res.text() : res.body ?? res.data;
        assetRes = typeof body === 'string' ? JSON.parse(body) : body;
      }
    } catch (error: any) {
      log('sgdb response unreadable', { url, status: res.status, message: error?.message, stack: error?.stack });
      throw new Error('Risposta di SteamGridDB non leggibile.');
    }

    const ok = typeof res.ok === 'boolean' ? res.ok : (Number(res.status ?? 200) < 400);
    if (!ok || !assetRes?.success) {
      const message = Array.isArray(assetRes?.errors) && assetRes.errors.length > 0
        ? assetRes.errors.join(', ')
        : `Richiesta SteamGridDB non riuscita${res.status ? ` (${res.status})` : ''}.`;
      const apiErr = new Error(message);
      (apiErr as any).status = res.status;
      throw apiErr;
    }
    return assetRes.data ?? [];
  }, []);

  const getImageAsB64 = useCallback(async (
    location: string,
    path = false,
    reportProgress?: (progress: number) => void
  ) : Promise<ArtworkPayload | null> => {
    log('downloading', location);
    try {
      if (path) {
        const data = await call<[path: string], ArtworkPayload>('read_artwork_payload', location);
        reportProgress?.(80);
        return data;
      }
      const jobId = `artwork-${appId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let polling = false;
      const timer = window.setInterval(() => {
        if (polling) return;
        polling = true;
        void call<[jobId: string], { percent?: number }>('get_download_progress', jobId)
          .then((progress) => reportProgress?.(Math.min(80, Number(progress?.percent ?? 0) * .8)))
          .finally(() => { polling = false; });
      }, 120);
      try {
        const data = await call<[url: string, jobId: string], ArtworkPayload>('download_artwork_payload', location, jobId);
        reportProgress?.(80);
        return data;
      } finally {
        window.clearInterval(timer);
        void call('clear_download_progress', jobId);
      }
    } catch (error) {
      return null;
    }
  }, [appId]);

  const changeAssetFromUrl: SGDBContextType['changeAssetFromUrl'] = useCallback(async (url, assetType, path = false) => {
    const requestedAssetType = assetType;
    const numericAssetType = getAmbiguousAssetType(assetType);
    await runArtworkJob(appId, requestedAssetType, url, async (reportProgress) => {
      if (numericAssetType === ASSET_TYPE.icon) {
        if (appOverview?.BIsShortcut()) {
          const res = await call<[
          appid: number | null,
          owner_id: string,
          path: string | null,
        ], string | boolean>(path ? 'set_shortcut_icon_from_path' : 'set_shortcut_icon_from_url',
          appId,
          getCurrentSteamUserId(),
          url
        );

          log('set_shortcut_icon result', res);
          reportProgress(96);
          if (res === 'icon_is_same_path') {
          // If the path is already the same as the current icon, we can force an icon re-read by setting the name to itself
            SteamClient.Apps.SetShortcutName(appOverview.appid, appOverview.display_name);
          } else if (res === true) {
          // shortcuts.vdf was modified, can't figure out how to make Steam re-read it so just ask user to reboot
            showRestartConfirm();
          }
        } else {
        // Change default Steam icon by poisoning the cache like Boop does it
          const res = await call<[
          appid: number | null,
          path: string | null,
        ], string | boolean>(path ? 'set_steam_icon_from_path' : 'set_steam_icon_from_url',
          appId,
          url
        );
          log('set_steam_icon result', res);
          reportProgress(96);
        }
      } else {
        const data = await getImageAsB64(url, path, reportProgress);
        if (!data) {
          throw new Error('Failed to retrieve asset');
        }
        reportProgress(86);
        const normalized = await normalizeArtworkPayload(data);
        await changeAsset(normalized.data, numericAssetType, normalized.format);
        reportProgress(98);
      }
    });
  }, [appId, appOverview, changeAsset, getImageAsB64]);

  const searchGames = useCallback(async (term: string) => {
    try {
      // encodeURIComponent twice to preserve some symbols
      // api is equpped to handle various types of inputs so this is fine
      const res = await apiRequest(`/search/autocomplete/${encodeURIComponent(encodeURIComponent(term))}`);
      log('search games', res);
      return res;
    } catch (err: any) {
      log('searchGames failed', { message: err?.message, stack: err?.stack });
      return [];
    }
  }, [apiRequest]);

  const searchAssets: SGDBContextType['searchAssets'] = useCallback(async (assetType, { gameId, gameName, gameProvider, filters = null, page = 0, signal }) => {
    let type = '';
    switch (assetType) {
    case 'grid_p':
    case 'grid_l':
      type = 'grids';
      break;
    case 'hero':
      type = 'heroes';
      break;
    case 'icon':
      type = 'icons';
      break;
    case 'logo':
      type = 'logos';
      break;
    }

    const provider = String(filters?.provider ?? filters?.providers?.[0] ?? ARTWORK_PROVIDERS.default);
    const providers: string[] = [provider];
    const jobs: Array<Promise<any[]>> = [];
    const qs = getApiParams(assetType, filters, page);
    if (providers.includes('steamgriddb')) {
      const sgdbGameId = !gameProvider || gameProvider === 'steamgriddb' ? gameId : undefined;
      jobs.push(apiRequest(`/${type}/${sgdbGameId ? 'game' : 'steam'}/${sgdbGameId ?? appId}?${qs}`, signal));
    }

    if (page === 0) {
      for (const provider of providers.filter((item) => item !== 'steamgriddb')) {
        const providerConfig = providerForId(provider);
        const requestedQuality = String(filters?.minimumQuality ?? 'standard');
        const supportedQuality = providerConfig.qualityLevelsByAsset?.[assetType] ?? providerConfig.qualityLevels ?? [];
        const minimumQuality = supportedQuality.includes(requestedQuality) ? requestedQuality : 'any';
        const requestedContentType = String(filters?.contentType ?? 'all');
        const supportedContentTypes = providerConfig.contentTypes?.[assetType] ?? [];
        const contentType = supportedContentTypes.some((option) => option.value === requestedContentType) ? requestedContentType : 'all';
        const mimes = providerConfig.fileTypes ? (filters?.mimes ?? []) : [];
        /*
          Store providers are asked for one specific store entry.

          `query` carries the id the user picked in the filters (PlayStation Store,
          Nintendo Store); with nothing picked the backend keeps its own best match.
        */
        const storePick = filters?.storeGame?.provider === provider ? filters.storeGame : undefined;
        const storeQuery = providerConfig.storeSearch ? String(storePick?.id ?? '') : '';
        const storeTitle = providerConfig.storeSearch ? String(storePick?.name ?? '') : '';
        const aspectMode = String(filters?.aspectMode ?? providerConfig.defaultAspectMode?.[assetType] ?? 'portrait');
        /*
          The shapes actually asked for are the intersection of what the user chose and
          what the source HAS. PlayStation publishes a square cover (the PS5 tile) and only
          sometimes a portrait one - searching it for portrait covers alone is why it
          "found nothing"; Nintendo and IGN have square covers only.
        */
        const shapes = coverShapesForProvider(providerConfig);
        const chooses = assetType === 'grid_p' && Boolean(providerConfig.aspectModes?.grid_p?.length) && shapes.length > 1;
        const wantsSquare = assetType === 'grid_p'
          && shapes.includes('square')
          && (!chooses || aspectMode === 'square' || aspectMode === 'both');
        const wantsPortrait = assetType !== 'grid_p'
          || (shapes.includes('portrait') && (!chooses || aspectMode === 'portrait' || aspectMode === 'both'));
        const providerSearch = (squareOnly: boolean) => call<[
          provider: string, title: string, assetType: string, squareOnly: boolean, limit: number,
          minimumQuality: string, mimes: string[], contentType: string, query: string, exactSize: string,
        ], any[]>(
          'search_provider_assets',
          provider,
          /*
            The Steam title wins for every source that is not SteamGridDB.

            `gameName` is the SteamGridDB match, and handing that to IGN, IGDB, Xbox or a
            store is a game of telephone: it is a different database's spelling, it sticks
            around from the previously scraped game, and it is how one game ended up being
            served another game's artwork. The store pick, when the user made one, wins
            over both.
          */
          storeTitle || (gameProvider === provider ? gameName : '') || appOverview?.display_name || '',
          assetType,
          squareOnly,
          24,
          minimumQuality,
          mimes,
          contentType,
          storeQuery,
          ''
        );
        /*
          The store pick is logged with every search, so serving one game's artwork under
          another game's name is visible in the log instead of on screen.
        */
        log('provider search', {
          provider,
          titolo: storeTitle || gameName || appOverview?.display_name || '',
          storePick: storePick ? `${storePick.name} (${storePick.id})` : 'nessuna, usa il nome del gioco',
          forme: [wantsPortrait ? 'verticali' : '', wantsSquare ? 'quadrate' : ''].filter(Boolean).join('+'),
        });
        if (wantsPortrait) jobs.push(providerSearch(false));
        if (wantsSquare) jobs.push(providerSearch(true));
      }
    }

    log('asset search', gameId, providers, qs);
    const settled = await Promise.allSettled(jobs);
    settled.forEach((result) => {
      if (result.status === 'rejected' && result.reason?.name !== 'AbortError') {
        log('asset search job failed', { message: result.reason?.message, stack: result.reason?.stack });
      }
    });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const combined = settled.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    const seen = new Set<string>();
    return combined.filter((asset: any) => {
      const key = String(asset?.url ?? asset?.thumb ?? asset?.id ?? '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [apiRequest, appId, appOverview?.display_name]);

  const getSgdbGame = useCallback(async (game: any) => {
    try {
      const gameRes = await apiRequest(`/games/id/${game.id}?platformdata=steam`);
      log('sgdb game', gameRes);
      return gameRes;
    } catch (err: any) {
      log('getSgdbGame failed', { message: err?.message, stack: err?.stack });
      return [];
    }
  }, [apiRequest]);

  const getSgdbGameBySteamAppId = useCallback(async (steamAppId: number) => {
    try {
      const gameRes = await apiRequest(`/games/steam/${steamAppId}?platformdata=steam`);
      log('sgdb steam game', gameRes);
      return gameRes;
    } catch (err: any) {
      log('SteamGridDB official Steam assets unavailable', steamAppId, err);
      return null;
    }
  }, [apiRequest]);

  useEffect(() => {
    void readApiKey().then((key) => setApiConfigured(Boolean(key)));
  }, []);

  useEffect(() => {
    if (appId) {
      setAppOverview(null);
      void (async () => {
        // Get details before overview or some games will be null.
        try {
          await getAppDetails(appId);
          const overview = await getAppOverview(appId);
          log('overview', overview);
          setAppOverview(overview);
        } catch (error) {
          log('app overview failed', appId, error);
          setAppOverview(null);
        }
      })();
    }
  }, [appId]);

  const value = useMemo(() => ({
    appId,
    appOverview,
    setAppId,
    searchAssets,
    searchGames,
    getSgdbGame,
    getSgdbGameBySteamAppId,
    changeAsset,
    changeAssetFromUrl,
    clearAsset,
    apiConfigured,
  }), [appId, appOverview, searchAssets, searchGames, getSgdbGame, getSgdbGameBySteamAppId, changeAsset, changeAssetFromUrl, clearAsset, apiConfigured]);

  return (
    <SGDBContext.Provider value={value}>
      {children}
    </SGDBContext.Provider>
  );
};

export const useSGDB = () => useContext(SGDBContext) as SGDBContextType;

export default useSGDB;
