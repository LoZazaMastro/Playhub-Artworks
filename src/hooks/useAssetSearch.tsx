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
import debounce from 'just-debounce';

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
  games: any[];
  selectedGame: any;
  isFilterActive: boolean;
  moreLoading: boolean;
  endReached: boolean;
  currentFilters: any;
  setCoverAspect: (mode: 'portrait' | 'square') => Promise<void>;
}

export const SearchContext = createContext({});

let abortCont: AbortController | null = null;

export const AssetSearchContext: FC<{ children: ReactNode }> = ({ children }) => {
  const { set, get } = useSettings();
  const { appId, searchAssets, searchGames, getSgdbGame, getSgdbGameBySteamAppId, appOverview } = useSGDB();
  const [assets, setAssets] = useState<Array<any>>([]);
  const [currentFilters, setCurrentFilters] = useState();
  const [isFilterActive, setIsFilterActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedGame, setSelectedGame] = useState<any>();
  const [externalSgdbData, setExternalSgdbData] = useState<any>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const [endReached, setEndReached] = useState(false);
  const [page, setPage] = useState(0);
  const filterCache = useRef<Record<string, any>>({});
  const searchSgdbGames = useCallback(async (term: string) =>
    (await searchGames(term)).map((game: any) => ({ ...game, provider: 'steamgriddb' })), [searchGames]);

  /*
    The store pick belongs to the GAME, and to nothing else.

    It used to travel inside the saved filters, which are stored once per asset type for
    the whole plugin: the PlayStation title picked while scraping Cars was still selected
    when opening another game, so Beast of Reincarnation was served Cars artwork. It now
    lives here, keyed to nothing but the app currently open, and is thrown away the moment
    the app changes. Nothing about it is persisted.
  */
  const storeGame = useRef<any>(undefined);
  const storePickChanged = useRef(false);
  useEffect(() => { storeGame.current = undefined; }, [appId]);

  /* A saved filter set must never carry a store pick, not even a legacy one. */
  const withoutStorePick = (filters: any) => {
    if (!filters || typeof filters !== 'object' || !('storeGame' in filters)) return filters;
    const { storeGame: _drop, ...rest } = filters;
    return rest;
  };
  /*
    Both searches are debounced, so a trailing call from the tab you just left could
    still land - and `loadMore` appends. That is how banners ended up mixed into the
    cover grid. Every request carries a token plus the asset type it belongs to, and
    anything that does not match the newest request is dropped on arrival.
  */
  const requestToken = useRef(0);
  const activeAssetType = useRef<SGDBAssetType | null>(null);
  const searchAndSetAssetsRef = useRef<AssetSearchContextType['searchAndSetAssets'] | null>(null);

  const showGameSelection = useCallback(() => {
    showModal(
      <GameSelectionModal
        defaultTerm={appOverview.display_name}
        searchGames={searchSgdbGames}
        onSelect={(game: any) => {
          setSelectedGame(game);
          set(`nonsteam_${appId}`, game);
        }}
      />
    );
  }, [appId, appOverview.display_name, searchSgdbGames, set]);

  /*
    A non-Steam game resolves itself on first open.

    SteamGridDB has no entry for a shortcut's app id, so the search came back
    "Game not found" and the grid simply stayed empty until the user opened Filters and
    confirmed the game by hand - which looked like the plugin wanting confirmation that
    "yes, we really are talking about this game". Now the title is looked up once,
    silently, and the picker is only shown when that lookup finds nothing.
  */
  const resolveShortcutGame = useCallback(async () => {
    const title = appOverview?.display_name?.trim();
    if (!title) return null;
    try {
      const matches = await searchSgdbGames(title);
      const match = matches?.[0];
      if (!match) return null;
      log('resolved non-Steam game', { title, id: match.id, name: match.name });
      setSelectedGame(match);
      void set(`nonsteam_${appId}`, match);
      return match;
    } catch (error) {
      log('non-Steam game lookup failed', { title, error });
      return null;
    }
  }, [appId, appOverview, searchSgdbGames, set]);

  const searchAndSetAssets = useMemo(() => debounce(async (assetType, page, filters, onSuccess, gameOverride, retried = false) => {
    let searchGame = gameOverride ?? selectedGame;
    if (appOverview?.BIsModOrShortcut() && !searchGame) {
      searchGame = await resolveShortcutGame();
      if (!searchGame) {
        showGameSelection();
        onSuccess?.();
        return;
      }
    }
    if (abortCont) abortCont?.abort();
    abortCont = new AbortController();

    const token = ++requestToken.current;
    activeAssetType.current = assetType;

    try {
      setCurrentFilters(filters);
      setAssets([]);
      setIsFilterActive(compareFilterWithDefaults(assetType, filters));
      const resp = await searchAssets(assetType, {
        gameId: searchGame?.id,
        gameName: searchGame?.name,
        gameProvider: searchGame?.provider,
        page,
        // Merged here, never stored: the pick is valid for this game only.
        filters: { ...filters, storeGame: storeGame.current },
        signal: abortCont.signal,
      });
      if (token !== requestToken.current) {
        log('stale search discarded', assetType);
        return;
      }
      log('search resp', assetType, resp);

      /*
        An empty first answer is retried once, resolving the title first.

        SteamGridDB answers by Steam app id, and for a game it does not have under that id
        it returns nothing at all rather than an error - so the grid stayed empty until the
        user opened Filters, waited for the title to appear and reloaded by hand. That is a
        chore, not a choice.
      */
      if (resp.length === 0 && !searchGame && !retried) {
        const resolved = await resolveShortcutGame();
        if (resolved) {
          searchAndSetAssetsRef.current?.(assetType, page, filters, onSuccess, resolved, true);
          return;
        }
      }

      setAssets(resp);
      setEndReached(false);
      setPage(page + 1); // set to next page so correct page is requested when loadMore() is used
    } catch (err: any) {
      if (err.name === 'AbortError') {
        log('Search Aborted');
      } else if (err?.status === 404) {
        /*
          SteamGridDB does not know this app id. Resolve the title once and retry before
          bothering the user: making them go Filters > Game > pick > close > Apply just to
          see any artwork at all is not a choice, it is a chore.
        */
        const resolved = await resolveShortcutGame();
        if (resolved) {
          searchAndSetAssetsRef.current?.(assetType, page, filters, onSuccess, resolved);
          return;
        }
        showGameSelection();
      } else {
        log('search failed', { assetType, message: err?.message, stack: err?.stack });
        if (selectedGame) {
          set(`nonsteam_${appId}`, false);
        }
      }
    } finally {
      onSuccess?.();
    }
  }, 500), [appId, appOverview, searchAssets, showGameSelection, selectedGame, set, resolveShortcutGame]) as AssetSearchContextType['searchAndSetAssets'];
  searchAndSetAssetsRef.current = searchAndSetAssets;

  const loadMore = useMemo(() => debounce(async (assetType, onSuccess) => {
    if (appOverview?.BIsModOrShortcut() && !selectedGame) return;
    // Never append to a grid that has since moved to another artwork type.
    if (activeAssetType.current !== assetType) return;
    if (abortCont) abortCont?.abort();
    abortCont = new AbortController();

    if (assets.length === 0) return;

    const token = requestToken.current;

    try {
      setMoreLoading(true);
      const resp = await searchAssets(assetType, {
        page,
        gameId: selectedGame?.id,
        gameName: selectedGame?.name,
        gameProvider: selectedGame?.provider,
        filters: currentFilters,
        signal: abortCont.signal,
      });
      if (token !== requestToken.current || activeAssetType.current !== assetType) {
        log('stale load more discarded', assetType);
        return;
      }
      log('search load more resp', resp);
      setAssets((assets) => [...assets, ...resp]);
      setMoreLoading(false);
      if (resp.length > 0) {
        setPage((x) => x + 1);
      }
      if (resp.length === 0) {
        setEndReached(true);
      }
      onSuccess?.(resp);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        log('Load more aborted');
      } else {
        log('load more failed', { assetType, message: err?.message, stack: err?.stack });
      }
    }
  }, 500), [appOverview, assets.length, currentFilters, page, searchAssets, selectedGame]);

  const handleFiltersSave = useCallback(async (assetType: SGDBAssetType, rawFilters: any, game: any) => {
    const filters = withoutStorePick(rawFilters);
    filterCache.current[assetType] = filters;
    const filtersChanged = !isEqual(filters, currentFilters);
    const gameChanged = game?.id !== selectedGame?.id;
    const storeChanged = storePickChanged.current;
    storePickChanged.current = false;
    if (filtersChanged || gameChanged || storeChanged) {
      setLoading(true);
      searchAndSetAssets(assetType, 0, filters, () => {
        setLoading(false);
      }, game);
    }
    if (filtersChanged) {
      set(`filters_${assetType}`, filters, true);
      setCurrentFilters(filters);
    }
    if (gameChanged) {
      setSelectedGame(game ?? false);
      // save selected game to reuse for this shortcut
      set(`nonsteam_${appId}`, game ?? false);
    }
    if (filtersChanged || gameChanged || storeChanged) {
      log('filtersChanged');
      setMoreLoading(false);
    }
    setIsFilterActive(compareFilterWithDefaults(assetType, filters));
  }, [currentFilters, selectedGame, searchAndSetAssets, set, appId]);

  const openFilters = useCallback((assetType: SGDBAssetType) => {
    log('Open Filters');
    const defaultFilters = filterCache.current[assetType] ?? currentFilters ?? null;
    showModal((
      <FiltersModal
        assetType={assetType}
        onSave={handleFiltersSave}
        defaultFilters={defaultFilters}
        defaultSelectedGame={selectedGame}
        defaultSearchTerm={selectedGame?.name || appOverview.display_name}
        isNonsteam={appOverview.BIsModOrShortcut()}
        searchGames={searchSgdbGames}
        defaultStoreGame={storeGame.current}
        onStoreGameChange={(game: any) => {
          /*
            Changing the store title has to re-run the search.
            Closing the panel after picking another PlayStation entry used to leave the
            previous results on screen, because only "filters" and "game" counted as a
            change and the store pick was neither.
          */
          const changed = storeGame.current?.id !== game?.id;
          storeGame.current = game;
          if (changed) storePickChanged.current = true;
        }}
      />
    ), window);
  }, [appOverview, currentFilters, handleFiltersSave, searchSgdbGames, selectedGame]);

  useEffect(() => {
    void Promise.all(['grid_p', 'grid_l', 'hero', 'logo', 'icon'].map(async (type) => {
      filterCache.current[type] = withoutStorePick(await get(`filters_${type}`, null));
    }));
  }, [get]);

  const setCoverAspect = useCallback(async (mode: 'portrait' | 'square') => {
    const saved = await get('filters_grid_p', null);
    const filters = {
      ...(saved ?? currentFilters ?? {}),
      aspectMode: mode,
      dimensions: mode === 'square'
        ? ['1024x1024', '512x512']
        : ['600x900', '342x482', '660x930'],
    };
    await handleFiltersSave('grid_p', filters, selectedGame);
  }, [currentFilters, get, handleFiltersSave, selectedGame]);

  useEffect(() => {
    if (!appOverview) return;
    (async () => {
      setLoading(true);
      const game = await get(`nonsteam_${appId}`, false);
      if (game) {
        setSelectedGame(game);
      } else {
        if (appOverview.BIsModOrShortcut()) {
          const gameRes = await searchSgdbGames(appOverview.display_name);
          if (gameRes.length) {
            setSelectedGame(gameRes[0]);
          } else {
            showGameSelection();
          }
        }
      }
      setLoading(false);
    })();
  }, [appOverview, appId, get, searchSgdbGames, set, showGameSelection]);

  useEffect(() => {
    if (!appOverview || !appId) return;
    (async () => {
      const sgdbGame = selectedGame
        ? await getSgdbGame(selectedGame)
        : !appOverview.BIsModOrShortcut()
          ? await getSgdbGameBySteamAppId(appId)
          : null;
      setExternalSgdbData(sgdbGame?.external_platform_data ?? null);
    })();
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
