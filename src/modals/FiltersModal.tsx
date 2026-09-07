import t from '../utils/i18n';
import {
  DialogButton,
  Focusable,
  Marquee,
  showModal,
} from '@decky/ui';
import { call } from '@decky/api';
import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  const fallbackProvider = availableProviders[0]?.value ?? ARTWORK_PROVIDERS.default;
  const [provider, setProvider] = useState<string>(availableProviders.some((item) => item.value === savedProvider) ? savedProvider : fallbackProvider);
  const [minimumQuality, setMinimumQuality] = useState<string>(defaultFilters?.minimumQuality ?? QUALITY_LEVELS.default);
  const [contentType, setContentType] = useState<string>(defaultFilters?.contentType ?? 'all');
  const [aspectMode, setAspectMode] = useState<string>(defaultFilters?.aspectMode ?? 'both');
  const [animated, setAnimated] = useState<boolean>(defaultFilters?.animated ?? true);
  const [_static, setStatic] = useState<boolean>(defaultFilters?._static ?? true);
  const [adult, setAdult] = useState<boolean>(defaultFilters?.adult ?? false);
  const [humor, setHumor] = useState<boolean>(defaultFilters?.humor ?? true);
  const [epilepsy, setEpilepsy] = useState<boolean>(defaultFilters?.epilepsy ?? true);
  const [untagged, setUntagged] = useState<boolean>(defaultFilters?.untagged ?? true);
  /*
    Every scraper owns its own selected title. A SteamGridDB fallback must never become
    the title searched by IGDB, IGN, Xbox, PlayStation or Nintendo when tabs are changed.
  */
  const [gamesByProvider, setGamesByProvider] = useState<Record<string, any>>(() => {
    const initial: Record<string, any> = {};
    for (const candidate of [defaultSelectedGame, defaultStoreGame]) {
      if (!candidate) continue;
      const source = String(candidate.provider ?? savedProvider);
      initial[source] = candidate.provider === source ? candidate : { ...candidate, provider: source };
    }
    return initial;
  });
  const manuallyClearedProviders = useRef<Set<string>>(new Set());
  const providerSearchSequence = useRef(0);

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
        displayName: t('PA_EXACT_SEARCH', 'Exact search “{name}”').replace('{name}', clean),
        provider,
        exact: true,
      }, ...matches.filter((game: any) => game.name?.toLocaleLowerCase() !== clean.toLocaleLowerCase())];
    } catch (_) {
      return providerConfig.exactSearch ? [{
        id: `exact:${provider}:${clean}`,
        name: clean,
        displayName: t('PA_EXACT_SEARCH', 'Exact search “{name}”').replace('{name}', clean),
        provider,
        exact: true,
      }] : [];
    }
  }, [provider, providerConfig.exactSearch, searchGames, sourceSearch]);

  const activeGame = gamesByProvider[provider];
  const originalGameTitle = String(defaultSearchTerm ?? '').trim();

  const selectProviderGame = useCallback((game: any) => {
    manuallyClearedProviders.current.delete(provider);
    const normalized = game ? { ...game, provider } : undefined;
    setGamesByProvider((current) => {
      const next = { ...current };
      if (normalized) next[provider] = normalized;
      else delete next[provider];
      return next;
    });
    if (storeSearch) onStoreGameChange?.(normalized);
  }, [onStoreGameChange, provider, storeSearch]);

  const clearProviderGame = useCallback(() => {
    manuallyClearedProviders.current.add(provider);
    providerSearchSequence.current += 1;
    setGamesByProvider((current) => {
      const next = { ...current };
      delete next[provider];
      return next;
    });
    if (storeSearch) onStoreGameChange?.(undefined);
  }, [onStoreGameChange, provider, storeSearch]);

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
    if (
      activeGame
      || manuallyClearedProviders.current.has(provider)
      || !originalGameTitle
    ) return;
    const sequence = ++providerSearchSequence.current;
    let active = true;
    void searchProviderGames(originalGameTitle)
      .then((results) => {
        if (!active || sequence !== providerSearchSequence.current || results.length === 0) return;
        const normalized = { ...results[0], provider };
        setGamesByProvider((current) => ({ ...current, [provider]: normalized }));
        if (storeSearch) onStoreGameChange?.(normalized);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [activeGame, onStoreGameChange, originalGameTitle, provider, searchProviderGames, storeSearch]);

  const handleClose = useCallback(() => {
    onSave(assetType, filters, activeGame);
    closeModal?.();
  }, [activeGame, assetType, closeModal, filters, onSave]);

  const resetFilters = () => {
    manuallyClearedProviders.current.clear();
    setStyles(STYLES[assetType].default);
    setMimes(MIMES[assetType].default);
    setDimensions(DIMENSIONS[assetType].default);
    setProvider(availableProviders.some((item) => item.value === ARTWORK_PROVIDERS.default) ? ARTWORK_PROVIDERS.default : fallbackProvider);
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
      onCancelActionDescription={t('PA_APPLY_CLOSE', "Apply and close")}
    >
      {/* Clicking anywhere outside the panel applies and closes, like every other panel. */}
      <div className="pa-editor-backdrop" onClick={handleClose} />

      <div className="pa-filters-shell">
        <div className="pa-editor-head">
          <strong>{t('LABEL_FILTER_MODAL_TITLE', '{assetType} Filter').replace('{assetType}', ASSET_TAB_LABEL[assetType] ?? assetType)}</strong>
          <span>{providerConfig.description}</span>
        </div>

        <Focusable className="pa-filters-scroll" flow-children="vertical">
          <div className="pa-filter-block">
            <div className="pa-filter-block-head"><strong>{t('PA_SOURCE', "Source")}</strong></div>
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
              <strong>{t('LABEL_FILTER_GAME', 'Game')}</strong>
              <span>
                {t('PA_GAME_SUGGESTIONS_DESC', 'Suggestions come from {source}. Change the title if the results do not match.').replace('{source}', providerConfig.label)}
              </span>
            </div>
            <Focusable className="pa-filter-game" flow-children="horizontal">
              <DialogButton
                className="pa-filter-game-value"
                onClick={() => showModal(
                  <GameSelectionModal
                    defaultTerm={activeGame?.name || originalGameTitle}
                    searchGames={searchProviderGames}
                    onSelect={selectProviderGame}
                  />
                )}
              >
                <Marquee>{activeGame?.name || originalGameTitle || t('PA_SEARCH_GAME', 'Search for a game…')}</Marquee>
              </DialogButton>
              {Boolean(activeGame && !isNonsteam) && (
                <DialogButton
                  className="pa-filter-game-clear"
                  onClick={clearProviderGame}
                >
                  <HiXMark strokeWidth={1.5} />
                </DialogButton>
              )}
            </Focusable>
          </div>

          {isSgdb && DIMENSIONS[assetType].options.length > 0 && (
            <CheckRow
              label={t('LABEL_FILTER_DIMENSIONS', 'Dimensions')}
              description={t('PA_EXACT_DIMENSIONS_DESC', 'Only artwork with these exact dimensions.')}
              options={DIMENSIONS[assetType].options as Option[]}
              selected={dimensions}
              onChange={setDimensions}
            />
          )}

          {aspectOptions.length > 0 && (
            <ChoiceRow
              label={t('PA_COVER_SHAPE', "Cover shape")}
              description={t('PA_COVER_SHAPE_DESC', 'Only keep images that match the library layout you want.')}
              options={aspectOptions}
              selected={aspectMode}
              onChange={setAspectMode}
            />
          )}

          {contentOptions.length > 0 && (
            <ChoiceRow
              label={t('PA_CONTENT', 'Content')}
              description={t('PA_CONTENT_DESC', 'Clean promotional artwork or in-game screenshots.')}
              options={contentOptions}
              selected={contentType}
              onChange={setContentType}
            />
          )}

          {qualityOptions.length > 0 && (
            <ChoiceRow
              label={t('PA_MIN_RESOLUTION', 'Minimum resolution')}
              description={qualityFilterDescription(assetType)}
              options={qualityOptions}
              selected={minimumQuality}
              onChange={setMinimumQuality}
            />
          )}

          {isSgdb && (
            <CheckRow
              label={t('LABEL_FILTER_STYLES', 'Styles')}
              options={STYLES[assetType].options as Option[]}
              selected={styles}
              onChange={setStyles}
            />
          )}

          {providerConfig.fileTypes && (
            <CheckRow
              label={t('LABEL_FILTER_FILE_TYPES', 'File Types')}
              options={MIMES[assetType].options as Option[]}
              selected={mimes}
              onChange={setMimes}
            />
          )}

          {isSgdb && (
            <ToggleRow
              label={t('LABEL_FILTER_ANIMATION_TYPE_TITLE', 'Types')}
              items={[
                { label: t('LABEL_FILTER_TYPE_STATIC', 'Static'), value: _static, onChange: (next) => (!animated && !next ? (setAnimated(true), setStatic(false)) : setStatic(next)) },
                { label: t('LABEL_FILTER_TYPE_ANIMATED', 'Animated'), value: animated, onChange: (next) => (!_static && !next ? (setStatic(true), setAnimated(false)) : setAnimated(next)) },
              ]}
            />
          )}

          {isSgdb && (
            <ToggleRow
              label={t('LABEL_FILTER_TAGS_TITLE', 'Tags')}
              items={[
                { label: t('LABEL_FILTER_TAG_NSFW', 'Adult Content'), value: adult, onChange: setAdult },
                { label: t('LABEL_FILTER_TAG_HUMOR', 'Humor'), value: humor, onChange: setHumor },
                { label: t('LABEL_FILTER_TAG_EPILEPSY', 'Epilepsy'), value: epilepsy, onChange: setEpilepsy },
                { label: t('LABEL_FILTER_TAG_UNTAGGED', 'Untagged'), value: untagged, onChange: setUntagged },
              ]}
            />
          )}
        </Focusable>

        {/* No apply button: filters are live and B closes the panel. */}
        {dirty && (
          <Focusable className="pa-filters-footer" flow-children="horizontal">
            <DialogButton onClick={resetFilters}><MdRefresh /><span>{t('ACTION_FILTER_RESET', 'Reset Filters')}</span></DialogButton>
          </Focusable>
        )}
      </div>
    </Focusable>
  );
};

export default FiltersModal;
