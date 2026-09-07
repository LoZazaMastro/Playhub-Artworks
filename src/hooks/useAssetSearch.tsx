import {
  useState,
  createContext,
  FC,
  useContext,
  useCallback,
  useMemo,
  useEffect,
  ReactNode,
  useRef,
} from 'react';
import { showModal } from '@decky/ui';
import isEqual from 'react-fast-compare';

import useSettings from '../hooks/useSettings';
import { useSGDB } from '../hooks/useSGDB';
import FiltersModal from '../modals/FiltersModal';
import GameSelectionModal from '../modals/GameSelectionModal';
import log from '../utils/log';
import compareFilterWithDefaults from '../utils/compareFilterWithDefaults';

export type AssetSearchContextType = {
  loading: boolean;
  assets: any[];
  searchAndSetAssets: (assetType: SGDBAssetType, page: number, filters: any, onSuccess?: () => void, gameOverride?: any, retried?: boolean) => Promise<void>;
  loadMore: (assetType: SGDBAssetType, onSuccess?: (res: any[]) => void) => Promise<void>;
  externalSgdbData: any;
  openFilters: (assetType: SGDBAssetType) => void;
  selectedGame: any;
  isFilterActive: boolean;
  moreLoading: boolean;
  endReached: boolean;
  currentFilters: any;
  setCoverAspect: (mode: 'portrait' | 'square') => Promise<void>;
}

export const SearchContext = createContext({});

const providerFromFilters = (filters: any): string => String(
  filters?.provider ?? filters?.providers?.[0] ?? 'steamgriddb'
);

const normalizeProviderGame = (provider: string, game: any) => {
  if (!game) return undefined;
  return game.provider === provider ? game : { ...game, provider };
};

const sameProviderGame = (left: any, right: any) => {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return String(left.provider ?? '') === String(right.provider ?? '')
    && String(left.id ?? '') === String(right.id ?? '')
    && String(left.name ?? '') === String(right.name ?? '');
};

export const AssetSearchContext: FC<{ children: ReactNode }> = ({ children }) => {
  const { set, get } = useSettings();
  const { appId, searchAssets, searchGames, getSgdbGame, getSgdbGameBySteamAppId, appOverview } = useSGDB();
  const [assets, setAssets] = useState<Array<any>>([]);
  const [currentFilters, setCurrentFilters] = useState<any>();
  const [isFilterActive, setIsFilterActive] = useState(false);
  const [loading, setLoading] = useState(false);
  /* `selectedGame` is intentionally SteamGridDB-only: SGDB external data depends on it. */
  const [selectedGame, setSelectedGame] = useState<any>();
  const [externalSgdbData, setExternalSgdbData] = useState<any>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [endReached, setEndReached] = useState(false);
  const [page, setPage] = useState(0);

  const filterCache = useRef<Record<string, any>>({});
  /* Every provider owns its own title. No suggestion can leak into another source. */
  const providerGames = useRef<Record<string, any>>({});
  const requestToken = useRef(0);
  const activeAssetType = useRef<SGDBAssetType | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const loadMoreAbort = useRef<AbortController | null>(null);
  const moreLoadingRef = useRef(false);
  const shortcutResolve = useRef<Promise<any> | null>(null);

  const searchSgdbGames = useCallback(async (term: string) =>
    (await searchGames(term)).map((game: any) => ({ ...game, provider: 'steamgriddb' })), [searchGames]);

  /* A saved filter set must never carry a title picked for a particular game. */
  const withoutTransientGame = useCallback((filters: any) => {
    if (!filters || typeof filters !== 'object') return filters;
    const { storeGame: _storeGame, providerGame: _providerGame, ...rest } = filters;
    return rest;
  }, []);

  useEffect(() => {
    requestToken.current += 1;
    searchAbort.current?.abort();
    loadMoreAbort.current?.abort();
    searchAbort.current = null;
    loadMoreAbort.current = null;
    shortcutResolve.current = null;
    moreLoadingRef.current = false;
    providerGames.current = {};
    setSelectedGame(undefined);
    setAssets([]);
    setMoreLoading(false);
    setEndReached(false);
    setPage(0);
  }, [appId]);

  useEffect(() => () => {
    requestToken.current += 1;
    searchAbort.current?.abort();
    loadMoreAbort.current?.abort();
  }, []);

  const rememberSgdbGame = useCallback((game: any, persist = true) => {
    const normalized = normalizeProviderGame('steamgriddb', game);
    if (normalized) providerGames.current.steamgriddb = normalized;
    else delete providerGames.current.steamgriddb;
    setSelectedGame(normalized);
    if (persist && appId) void set(`nonsteam_${appId}`, normalized ?? false);
    return normalized;
  }, [appId, set]);

  const showGameSelection = useCallback(() => {
    const title = appOverview?.display_name ?? '';
    showModal(
      <GameSelectionModal
        defaultTerm={title}
        searchGames={searchSgdbGames}
        onSelect={(game: any) => rememberSgdbGame(game)}
      />,
      window
    );
  }, [appOverview?.display_name, rememberSgdbGame, searchSgdbGames]);

  /** Resolve one SGDB identity at a time; repeated tab effects reuse the same request. */
  const resolveSgdbGameByTitle = useCallback(async () => {
    const title = appOverview?.display_name?.trim();
    if (!title) return null;
    if (shortcutResolve.current) return shortcutResolve.current;

    const pending = (async () => {
      try {
        const matches = await searchSgdbGames(title);
        const match = matches?.[0];
        if (!match) return null;
        log('resolved SteamGridDB game', { title, id: match.id, name: match.name });
        const persist = Boolean(appOverview?.BIsModOrShortcut());
        return rememberSgdbGame(match, persist);
      } catch (error) {
        log('SteamGridDB title lookup failed', { title, error });
        return null;
      } finally {
        shortcutResolve.current = null;
      }
    })();

    shortcutResolve.current = pending;
    return pending;
  }, [appOverview, rememberSgdbGame, searchSgdbGames]);

  /*
    Searches run immediately and cancel only their own predecessor. The old shared,
    debounced AbortController could leave a dropped callback holding the loading state
    forever and `loadMore` could abort the main search. These paths are now independent.
  */
  const searchAndSetAssets = useCallback<AssetSearchContextType['searchAndSetAssets']>(async (
    assetType,
    requestedPage,
    rawFilters,
    onSuccess,
    gameOverride,
    retried = false
  ) => {
    const filters = withoutTransientGame(rawFilters);
    const provider = providerFromFilters(filters);
    const token = ++requestToken.current;
    activeAssetType.current = assetType;

    searchAbort.current?.abort();
    loadMoreAbort.current?.abort();
    loadMoreAbort.current = null;
    moreLoadingRef.current = false;
    setMoreLoading(false);

    const controller = new AbortController();
    searchAbort.current = controller;

    setCurrentFilters(filters);
    setAssets([]);
    setEndReached(false);
    setPage(requestedPage + 1);
    setIsFilterActive(compareFilterWithDefaults(assetType, filters));

    try {
      if (!appOverview || !appId) return;

      let searchGame = gameOverride !== undefined
        ? normalizeProviderGame(provider, gameOverride)
        : providerGames.current[provider];

      if (gameOverride !== undefined) {
        if (searchGame) providerGames.current[provider] = searchGame;
        else delete providerGames.current[provider];
      }

      if (!searchGame && provider === 'steamgriddb') {
        searchGame = selectedGame?.provider === 'steamgriddb' ? selectedGame : undefined;
      }

      if (provider === 'steamgriddb' && appOverview.BIsModOrShortcut() && !searchGame) {
        searchGame = await resolveSgdbGameByTitle();
        if (controller.signal.aborted || token !== requestToken.current) return;
        if (!searchGame) {
          showGameSelection();
          return;
        }
      }

      const runSearch = (game: any) => searchAssets(assetType, {
        gameId: game?.id,
        gameName: game?.name,
        gameProvider: game?.provider,
        page: requestedPage,
        /* useSGDB consumes this only for a matching store provider. */
        filters: { ...filters, storeGame: game },
        signal: controller.signal,
      });

      let response: any[];
      try {
        response = await runSearch(searchGame);
      } catch (error: any) {
        if (
          provider !== 'steamgriddb'
          || retried
          || error?.status !== 404
          || controller.signal.aborted
        ) throw error;

        const resolved = await resolveSgdbGameByTitle();
        if (controller.signal.aborted || token !== requestToken.current) return;
        if (!resolved) {
          showGameSelection();
          return;
        }
        searchGame = resolved;
        response = await runSearch(resolved);
      }

      if (controller.signal.aborted || token !== requestToken.current || activeAssetType.current !== assetType) {
        log('stale search discarded', assetType);
        return;
      }

      /* Steam-app lookup may be empty even though title lookup succeeds: retry once. */
      if (provider === 'steamgriddb' && response.length === 0 && !searchGame && !retried) {
        const resolved = await resolveSgdbGameByTitle();
        if (controller.signal.aborted || token !== requestToken.current) return;
        if (resolved) response = await runSearch(resolved);
      }

      if (controller.signal.aborted || token !== requestToken.current || activeAssetType.current !== assetType) return;
      log('search resp', assetType, response);
      setAssets(response);
      setEndReached(false);
      setPage(requestedPage + 1);
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        log('Search Aborted');
      } else {
        log('search failed', { assetType, provider, message: error?.message, stack: error?.stack });
      }
    } finally {
      if (searchAbort.current === controller) searchAbort.current = null;
      if (token === requestToken.current) onSuccess?.();
    }
  }, [appId, appOverview, resolveSgdbGameByTitle, searchAssets, selectedGame, showGameSelection, withoutTransientGame]);

  const loadMore = useCallback<AssetSearchContextType['loadMore']>(async (assetType, onSuccess) => {
    if (
      activeAssetType.current !== assetType
      || assets.length === 0
      || moreLoadingRef.current
    ) return;

    const provider = providerFromFilters(currentFilters);
    /* The non-SGDB providers return their complete result set on page zero. */
    if (provider !== 'steamgriddb') {
      setEndReached(true);
      onSuccess?.([]);
      return;
    }

    const searchGame = providerGames.current.steamgriddb
      ?? (selectedGame?.provider === 'steamgriddb' ? selectedGame : undefined);
    if (appOverview?.BIsModOrShortcut() && !searchGame) return;

    loadMoreAbort.current?.abort();
    const controller = new AbortController();
    loadMoreAbort.current = controller;
    const token = requestToken.current;
    moreLoadingRef.current = true;
    setMoreLoading(true);

    try {
      const response = await searchAssets(assetType, {
        page,
        gameId: searchGame?.id,
        gameName: searchGame?.name,
        gameProvider: searchGame?.provider,
        filters: currentFilters,
        signal: controller.signal,
      });

      if (
        controller.signal.aborted
        || token !== requestToken.current
        || activeAssetType.current !== assetType
      ) {
        log('stale load more discarded', assetType);
        return;
      }

      log('search load more resp', response);
      if (response.length > 0) {
        setAssets((current) => [...current, ...response]);
        setPage((current) => current + 1);
      } else {
        setEndReached(true);
      }
      onSuccess?.(response);
    } catch (error: any) {
      if (error?.name === 'AbortError') log('Load more aborted');
      else log('load more failed', { assetType, message: error?.message, stack: error?.stack });
    } finally {
      if (loadMoreAbort.current === controller) {
        loadMoreAbort.current = null;
        moreLoadingRef.current = false;
        setMoreLoading(false);
      }
    }
  }, [appOverview, assets.length, currentFilters, page, searchAssets, selectedGame]);

  const handleFiltersSave = useCallback(async (assetType: SGDBAssetType, rawFilters: any, game: any) => {
    const filters = withoutTransientGame(rawFilters);
    const provider = providerFromFilters(filters);
    const normalizedGame = normalizeProviderGame(provider, game);
    const previousGame = providerGames.current[provider];
    const filtersChanged = !isEqual(filters, currentFilters);
    const gameChanged = !sameProviderGame(previousGame, normalizedGame);

    filterCache.current[assetType] = filters;
    if (normalizedGame) providerGames.current[provider] = normalizedGame;
    else delete providerGames.current[provider];

    if (provider === 'steamgriddb' && gameChanged) {
      rememberSgdbGame(normalizedGame);
    }

    if (filtersChanged) {
      void set(`filters_${assetType}`, filters, true);
      setCurrentFilters(filters);
    }

    if (filtersChanged || gameChanged) {
      setLoading(true);
      await searchAndSetAssets(assetType, 0, filters, () => setLoading(false), normalizedGame);
      setMoreLoading(false);
    }

    setIsFilterActive(compareFilterWithDefaults(assetType, filters));
  }, [currentFilters, rememberSgdbGame, searchAndSetAssets, set, withoutTransientGame]);

  const openFilters = useCallback((assetType: SGDBAssetType) => {
    if (!appOverview) return;
    log('Open Filters');
    const defaultFilters = filterCache.current[assetType] ?? currentFilters ?? null;
    const provider = providerFromFilters(defaultFilters);
    const providerGame = providerGames.current[provider]
      ?? (provider === 'steamgriddb' ? selectedGame : undefined);

    showModal((
      <FiltersModal
        assetType={assetType}
        onSave={handleFiltersSave}
        defaultFilters={defaultFilters}
        defaultSelectedGame={providerGame}
        /* Reset always returns to Steam's real title, never to an SGDB fallback. */
        defaultSearchTerm={appOverview.display_name}
        isNonsteam={appOverview.BIsModOrShortcut()}
        searchGames={searchSgdbGames}
        defaultStoreGame={providerGame}
      />
    ), window);
  }, [appOverview, currentFilters, handleFiltersSave, searchSgdbGames, selectedGame]);

  useEffect(() => {
    void Promise.all(['grid_p', 'grid_l', 'hero', 'logo', 'icon'].map(async (type) => {
      filterCache.current[type] = withoutTransientGame(await get(`filters_${type}`, null));
    }));
  }, [get, withoutTransientGame]);

  const setCoverAspect = useCallback(async (mode: 'portrait' | 'square') => {
    const saved = withoutTransientGame(await get('filters_grid_p', null));
    const filters = {
      ...(saved ?? currentFilters ?? {}),
      aspectMode: mode,
      dimensions: mode === 'square'
        ? ['1024x1024', '512x512']
        : ['600x900', '342x482', '660x930'],
    };
    const provider = providerFromFilters(filters);
    const game = providerGames.current[provider]
      ?? (provider === 'steamgriddb' ? selectedGame : undefined);
    await handleFiltersSave('grid_p', filters, game);
  }, [currentFilters, get, handleFiltersSave, selectedGame, withoutTransientGame]);

  useEffect(() => {
    if (!appOverview || !appId) return;
    let active = true;
    void (async () => {
      setLoading(true);
      try {
        const saved = await get(`nonsteam_${appId}`, false);
        if (!active) return;

        /* Purge legacy values accidentally saved by a different provider. */
        if (saved && saved.provider && saved.provider !== 'steamgriddb') {
          await set(`nonsteam_${appId}`, false);
        } else if (saved) {
          rememberSgdbGame(saved, false);
        } else if (appOverview.BIsModOrShortcut()) {
          const resolved = await resolveSgdbGameByTitle();
          if (active && !resolved) showGameSelection();
        }
      } catch (error) {
        log('saved game restore failed', error);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [appId, appOverview, get, rememberSgdbGame, resolveSgdbGameByTitle, set, showGameSelection]);

  useEffect(() => {
    if (!appOverview || !appId) return;
    let active = true;
    void (async () => {
      const sgdbGame = selectedGame
        ? await getSgdbGame(selectedGame)
        : !appOverview.BIsModOrShortcut()
          ? await getSgdbGameBySteamAppId(appId)
          : null;
      if (active) setExternalSgdbData(sgdbGame?.external_platform_data ?? null);
    })();
    return () => { active = false; };
  }, [appId, appOverview, getSgdbGame, getSgdbGameBySteamAppId, selectedGame]);

  const value = useMemo(() => ({
    loading,
    assets,
    searchAndSetAssets,
    loadMore,
    selectedGame,
    externalSgdbData,
    openFilters,
    isFilterActive,
    moreLoading,
    endReached,
    currentFilters,
    setCoverAspect,
  }), [loading, assets, searchAndSetAssets, loadMore, selectedGame, externalSgdbData, openFilters, isFilterActive, moreLoading, endReached, currentFilters, setCoverAspect]);

  return (
    <SearchContext.Provider value={value}>
      {children}
    </SearchContext.Provider>
  );
};

export const useAssetSearch = () => useContext(SearchContext) as AssetSearchContextType;

export default useAssetSearch;
