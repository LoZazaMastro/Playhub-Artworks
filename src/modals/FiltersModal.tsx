import {
  DialogButton,
  Focusable,
  Marquee,
  showModal,
} from '@decky/ui';
import { call } from '@decky/api';
import { FC, useCallback, useEffect, useMemo, useState } from 'react';
import { HiCheck, HiXMark } from 'react-icons/hi2';
import { MdRefresh } from 'react-icons/md';

import {
  ARTWORK_PROVIDERS,
  MIMES,
  STYLES,
  DIMENSIONS,
  QUALITY_LEVELS,
  ASSET_TAB_LABEL,
  aspectModesForProvider,
  contentTypesForProvider,
  providerForId,
  providersForAsset,
  qualityFilterDescription,
  qualityLevelsForProvider,
} from '../constants';
import compareFilterWithDefaults from '../utils/compareFilterWithDefaults';

import GameSelectionModal from './GameSelectionModal';

type Option = { label: string; value: string | number };

const CheckRow: FC<{
  label: string;
  description?: string;
  options: Option[];
  selected: Array<string | number>;
  onChange: (next: Array<string | number>) => void;
}> = ({ label, description, options, selected, onChange }) => (
  <div className="pa-filter-block">
    <div className="pa-filter-block-head">
      <strong>{label}</strong>
      {description && <span>{description}</span>}
    </div>
    <Focusable className="pa-filter-checks" flow-children="grid">
      {options.map((option) => {
        const on = selected.includes(option.value);
        return (
          <DialogButton
            key={String(option.value)}
            className={`pa-check ${on ? 'on' : ''}`}
            onClick={() => onChange(on
              ? selected.filter((value) => value !== option.value)
              : [...selected, option.value])}
          >
            <span className="pa-check-box">{on ? <HiCheck /> : null}</span>
            <span>{option.label}</span>
          </DialogButton>
        );
      })}
    </Focusable>
  </div>
);

const ChoiceRow: FC<{
  label: string;
  description?: string;
  options: Option[];
  selected: string;
  onChange: (next: string) => void;
}> = ({ label, description, options, selected, onChange }) => (
  <div className="pa-filter-block">
    <div className="pa-filter-block-head">
      <strong>{label}</strong>
      {description && <span>{description}</span>}
    </div>
    <Focusable className="pa-filter-choices" flow-children="grid">
      {options.map((option) => (
        <DialogButton
          key={String(option.value)}
          className={`pa-choice-pill ${selected === option.value ? 'on' : ''}`}
          onClick={() => onChange(String(option.value))}
        >
          {option.label}
        </DialogButton>
      ))}
    </Focusable>
  </div>
);

const ToggleRow: FC<{
  label: string;
  items: Array<{ label: string; value: boolean; onChange: (next: boolean) => void }>;
}> = ({ label, items }) => (
  <div className="pa-filter-block">
    <div className="pa-filter-block-head"><strong>{label}</strong></div>
    <Focusable className="pa-filter-checks" flow-children="grid">
      {items.map((item) => (
        <DialogButton
          key={item.label}
          className={`pa-check ${item.value ? 'on' : ''}`}
          onClick={() => item.onChange(!item.value)}
        >
          <span className="pa-check-box">{item.value ? <HiCheck /> : null}</span>
          <span>{item.label}</span>
        </DialogButton>
      ))}
    </Focusable>
  </div>
);

const FiltersModal: FC<{
  closeModal?: () => void,
  assetType: SGDBAssetType,
  isNonsteam: boolean,
  onSave: (assetType: SGDBAssetType, filters: any, selectedGame?: any) => void,
  defaultFilters: any,
  defaultSelectedGame: any;
  defaultSearchTerm: string;
  searchGames: (term: string) => Promise<any[]>;
  /* The store pick belongs to the GAME being scraped, so it arrives and leaves separately. */
  defaultStoreGame?: any;
  onStoreGameChange?: (game: any) => void;
}> = ({
  closeModal,
  assetType,
  isNonsteam,
  onSave,
  defaultFilters,
  defaultSelectedGame,
  defaultSearchTerm,
  searchGames,
  defaultStoreGame,
  onStoreGameChange,
}) => {
  const [styles, setStyles] = useState<Array<string | number>>(defaultFilters?.styles ?? STYLES[assetType].default);
  const [mimes, setMimes] = useState<Array<string | number>>(defaultFilters?.mimes ?? MIMES[assetType].default);
  const [dimensions, setDimensions] = useState<Array<string | number>>(defaultFilters?.dimensions ?? DIMENSIONS[assetType].default);
  const availableProviders = useMemo(() => providersForAsset(assetType), [assetType]);
  const savedProvider = String(defaultFilters?.provider ?? defaultFilters?.providers?.[0] ?? ARTWORK_PROVIDERS.default);
  const [provider, setProvider] = useState<string>(availableProviders.some((item) => item.value === savedProvider) ? savedProvider : availableProviders[0].value);
  const [minimumQuality, setMinimumQuality] = useState<string>(defaultFilters?.minimumQuality ?? QUALITY_LEVELS.default);
  const [contentType, setContentType] = useState<string>(defaultFilters?.contentType ?? 'all');
  const [aspectMode, setAspectMode] = useState<string>(defaultFilters?.aspectMode ?? 'both');
  const [animated, setAnimated] = useState<boolean>(defaultFilters?.animated ?? true);
  const [_static, setStatic] = useState<boolean>(defaultFilters?._static ?? true);
  const [adult, setAdult] = useState<boolean>(defaultFilters?.adult ?? false);
  const [humor, setHumor] = useState<boolean>(defaultFilters?.humor ?? true);
  const [epilepsy, setEpilepsy] = useState<boolean>(defaultFilters?.epilepsy ?? true);
  const [untagged, setUntagged] = useState<boolean>(defaultFilters?.untagged ?? true);
  const [selectedGame, setSelectedGame] = useState(defaultSelectedGame);
  /*
    The store pick is NOT part of the saved filters.

    It used to be, and the filters are saved once per asset type for the whole plugin - so
    the PlayStation title chosen while scraping Cars was still selected when opening Beast
    of Reincarnation, and the search happily returned Cars artwork for another game. It now
    belongs to the app being scraped and is handed in and out on its own.
  */
  const [storeGame, setStoreGameState] = useState<any>(defaultStoreGame);
  const setStoreGame = useCallback((game: any) => {
    setStoreGameState(game);
    onStoreGameChange?.(game);
  }, [onStoreGameChange]);

  const providerConfig = useMemo(() => providerForId(provider), [provider]);
  const storeSearch = Boolean(providerConfig.storeSearch);
  const sourceSearch = providerConfig.gameSearch ?? 'provider';

  /* Every source supplies its own names. The literal IGDB/AlphaCoders choice stays first. */
  const searchProviderGames = useCallback(async (term: string) => {
    const clean = term.trim();
    if (!clean) return [];
    try {
      const games = sourceSearch === 'steamgriddb'
        ? await searchGames(clean)
        : await call<[string, string, number], any[]>('search_provider_games', provider, clean, 12);
      const matches = (games ?? []).map((game: any) => ({ ...game, provider }));
      if (!providerConfig.exactSearch) return matches;
      return [{
        id: `exact:${provider}:${clean}`,
        name: clean,
        displayName: `Ricerca esatta “${clean}”`,
        provider,
        exact: true,
      }, ...matches.filter((game: any) => game.name?.toLocaleLowerCase() !== clean.toLocaleLowerCase())];
    } catch (_) {
      return providerConfig.exactSearch ? [{
        id: `exact:${provider}:${clean}`,
        name: clean,
        displayName: `Ricerca esatta “${clean}”`,
        provider,
        exact: true,
      }] : [];
    }
  }, [provider, providerConfig.exactSearch, searchGames, sourceSearch]);

  /* A store pick belongs to the store it came from: switching source starts over. */
  const providerStoreGame = storeGame?.provider === provider ? storeGame : undefined;

  // Pick the best store match on its own, exactly like the SteamGridDB path does.
  useEffect(() => {
    if (!storeSearch || providerStoreGame || !defaultSearchTerm.trim()) return;
    let active = true;
    void searchProviderGames(defaultSearchTerm).then((results) => {
      if (active && results.length > 0) setStoreGame(results[0]);
    });
    return () => { active = false; };
  }, [defaultSearchTerm, providerStoreGame, searchProviderGames, setStoreGame, storeSearch]);

  const selectedForProvider = selectedGame?.provider === provider ? selectedGame : undefined;
  const activeGame = storeSearch ? providerStoreGame : selectedForProvider;

  const filters = useMemo(() => ({
    styles,
    dimensions,
    mimes,
    provider,
    providers: [provider],
    minimumQuality,
    contentType,
    aspectMode,
    animated,
    _static,
    adult,
    humor,
    epilepsy,
    untagged,
  }), [styles, dimensions, mimes, provider, minimumQuality, contentType, aspectMode, animated, _static, adult, humor, epilepsy, untagged]);
  const qualityOptions = useMemo(() => qualityLevelsForProvider(providerConfig, assetType), [providerConfig, assetType]);
  const contentOptions = useMemo(() => contentTypesForProvider(providerConfig, assetType), [providerConfig, assetType]);
  const aspectOptions = useMemo(() => aspectModesForProvider(providerConfig, assetType), [providerConfig, assetType]);
  const isSgdb = provider === 'steamgriddb';

  useEffect(() => {
    if (qualityOptions.length > 0 && !qualityOptions.some((option) => option.value === minimumQuality)) {
      setMinimumQuality(qualityOptions.some((option) => option.value === QUALITY_LEVELS.default) ? QUALITY_LEVELS.default : qualityOptions[0].value);
    }
    if (contentOptions.length > 0 && !contentOptions.some((option) => option.value === contentType)) {
      setContentType(contentOptions[0].value);
    }
    if (aspectOptions.length > 0 && !aspectOptions.some((option) => option.value === aspectMode)) {
      setAspectMode(providerConfig.defaultAspectMode?.[assetType] ?? aspectOptions[0].value);
    }
  }, [providerConfig, assetType, qualityOptions, contentOptions, aspectOptions, minimumQuality, contentType, aspectMode]);

  useEffect(() => {
    if (storeSearch || selectedForProvider || !defaultSearchTerm.trim()) return;
    let active = true;
    void searchProviderGames(defaultSearchTerm).then((results) => {
      if (active && results.length > 0) setSelectedGame(results[0]);
    });
    return () => { active = false; };
  }, [defaultSearchTerm, searchProviderGames, selectedForProvider, storeSearch]);

  const handleClose = useCallback(() => {
    onSave(assetType, filters, activeGame);
    closeModal?.();
  }, [activeGame, assetType, closeModal, filters, onSave]);

  const resetFilters = () => {
    setStyles(STYLES[assetType].default);
    setMimes(MIMES[assetType].default);
    setDimensions(DIMENSIONS[assetType].default);
    setProvider(availableProviders.some((item) => item.value === ARTWORK_PROVIDERS.default) ? ARTWORK_PROVIDERS.default : availableProviders[0].value);
    setMinimumQuality(QUALITY_LEVELS.default);
    setContentType('all');
    setAspectMode('both');
    setAnimated(true);
    setStatic(true);
    setAdult(false);
    setHumor(true);
    setEpilepsy(true);
    setUntagged(true);
  };

  const dirty = compareFilterWithDefaults(assetType, filters);

  return (
    <Focusable
      className="pa-filters"
      flow-children="vertical"
      onCancel={handleClose}
      onCancelButton={handleClose}
      onCancelActionDescription="Applica e chiudi"
    >
      {/* Clicking anywhere outside the panel applies and closes, like every other panel. */}
      <div className="pa-editor-backdrop" onClick={handleClose} />

      <div className="pa-filters-shell">
        <div className="pa-editor-head">
          <strong>Filtri · {ASSET_TAB_LABEL[assetType] ?? assetType}</strong>
          <span>{providerConfig.description}</span>
        </div>

        <Focusable className="pa-filters-scroll" flow-children="vertical">
          <div className="pa-filter-block">
            <div className="pa-filter-block-head"><strong>Sorgente</strong></div>
            <Focusable className="pa-filter-choices" flow-children="grid">
              {availableProviders.map((item) => (
                <DialogButton
                  key={item.value}
                  className={`pa-choice-pill ${provider === item.value ? 'on' : ''}`}
                  onClick={() => setProvider(item.value)}
                >
                  {item.label}
                </DialogButton>
              ))}
            </Focusable>
          </div>

          <div className="pa-filter-block">
            <div className="pa-filter-block-head">
              <strong>Gioco</strong>
              <span>
                I suggerimenti arrivano da {providerConfig.label}. Cambia il titolo se i risultati non corrispondono.
              </span>
            </div>
            <Focusable className="pa-filter-game" flow-children="horizontal">
              <DialogButton
                className="pa-filter-game-value"
                onClick={() => showModal(
                  <GameSelectionModal
                    defaultTerm={activeGame?.name || defaultSearchTerm}
                    searchGames={searchProviderGames}
                    onSelect={(game: any) => (storeSearch ? setStoreGame(game) : setSelectedGame(game))}
                  />
                )}
              >
                <Marquee>{activeGame?.name || defaultSearchTerm || 'Cerca un gioco…'}</Marquee>
              </DialogButton>
              {Boolean(activeGame && !isNonsteam) && (
                <DialogButton
                  className="pa-filter-game-clear"
                  onClick={() => (storeSearch ? setStoreGame(undefined) : setSelectedGame(undefined))}
                >
                  <HiXMark strokeWidth={1.5} />
                </DialogButton>
              )}
            </Focusable>
          </div>

          {isSgdb && DIMENSIONS[assetType].options.length > 0 && (
            <CheckRow
              label="Risoluzioni"
              description="Solo gli artwork con queste dimensioni esatte."
              options={DIMENSIONS[assetType].options as Option[]}
              selected={dimensions}
              onChange={setDimensions}
            />
          )}

          {aspectOptions.length > 0 && (
            <ChoiceRow
              label="Forma della cover"
              description="Tiene solo le immagini adatte alla libreria che vuoi costruire."
              options={aspectOptions}
              selected={aspectMode}
              onChange={setAspectMode}
            />
          )}

          {contentOptions.length > 0 && (
            <ChoiceRow
              label="Contenuto"
              description="Immagini promozionali pulite oppure screenshot di gioco."
              options={contentOptions}
              selected={contentType}
              onChange={setContentType}
            />
          )}

          {qualityOptions.length > 0 && (
            <ChoiceRow
              label="Risoluzione minima"
              description={qualityFilterDescription(assetType)}
              options={qualityOptions}
              selected={minimumQuality}
              onChange={setMinimumQuality}
            />
          )}

          {isSgdb && (
            <CheckRow
              label="Stili"
              options={STYLES[assetType].options as Option[]}
              selected={styles}
              onChange={setStyles}
            />
          )}

          {providerConfig.fileTypes && (
            <CheckRow
              label="Formati file"
              options={MIMES[assetType].options as Option[]}
              selected={mimes}
              onChange={setMimes}
            />
          )}

          {isSgdb && (
            <ToggleRow
              label="Tipo"
              items={[
                { label: 'Statici', value: _static, onChange: (next) => (!animated && !next ? (setAnimated(true), setStatic(false)) : setStatic(next)) },
                { label: 'Animati', value: animated, onChange: (next) => (!_static && !next ? (setStatic(true), setAnimated(false)) : setAnimated(next)) },
              ]}
            />
          )}

          {isSgdb && (
            <ToggleRow
              label="Tag"
              items={[
                { label: 'Contenuto adulto', value: adult, onChange: setAdult },
                { label: 'Umorismo', value: humor, onChange: setHumor },
                { label: 'Epilessia', value: epilepsy, onChange: setEpilepsy },
                { label: 'Senza tag', value: untagged, onChange: setUntagged },
              ]}
            />
          )}
        </Focusable>

        {/* No apply button: filters are live and B closes the panel. */}
        {dirty && (
          <Focusable className="pa-filters-footer" flow-children="horizontal">
            <DialogButton onClick={resetFilters}><MdRefresh /><span>Reimposta i filtri</span></DialogButton>
          </Focusable>
        )}
      </div>
    </Focusable>
  );
};

export default FiltersModal;
