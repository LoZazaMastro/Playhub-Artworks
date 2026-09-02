import {
  DialogButton, Focusable, GamepadButton, GamepadEvent, TabsProps, showModal,
} from '@decky/ui';
import { call, toaster } from '@decky/api';
import {
  memo, useCallback, useEffect, useMemo, useRef, useState, FC,
} from 'react';
import {
  MdApps,
  MdAutoAwesome,
  MdCropLandscape,
  MdCropPortrait,
  MdOutlineBrandingWatermark,
  MdTune,
  MdWallpaper,
} from 'react-icons/md';
import { HiEye, HiEyeSlash, HiTrash } from 'react-icons/hi2';
import { FaSlidersH, FaSteam } from 'react-icons/fa';

import useAssetSearch from '../../hooks/useAssetSearch';
import useSGDB from '../../hooks/useSGDB';
import {
  ASSET_TAB_LABEL, DEFAULT_TABS, coverShapesForProvider, providerForId, providerLabel, SGDB_ASSET_TYPE_READABLE,
} from '../../constants';
import useSettings from '../../hooks/useSettings';
import LogoPositionerModal from '../../modals/LogoPositionerModal';
import ArtworkComposerModal from '../../modals/ArtworkComposerModal';
import OfficialAssetsModal from '../../modals/OfficialAssetsModal';
import MenuIcon from '../Icons/MenuIcon';
import t from '../../utils/i18n';
import { hideLogo, isLogoHidden, showLogo } from '../../utils/logoControl';
import { clearPerfectArtwork, isPerfectArtwork, markPerfectArtwork } from '../../utils/perfectArtwork';

import ManageTab from './ManageTab';
import AssetTab from './AssetTab';

const TAB_ICONS: Record<string, JSX.Element> = {
  grid_p: <MdCropPortrait />,
  grid_l: <MdCropLandscape />,
  hero: <MdWallpaper />,
  logo: <MdOutlineBrandingWatermark />,
  icon: <MdApps />,
  manage: <MdTune />,
};

const hasOfficialAsset = (data: any, assetType: SGDBAssetType) => {
  const metadata = data?.steam?.[0]?.metadata;
  if (!metadata) return false;

  const hasLocalizedImages = (value: any) => Boolean(
    value?.image && Object.values(value.image).some(Boolean)
  );

  switch (assetType) {
  case 'grid_l':
    return Boolean(Object.values(metadata.header_image_full ?? {}).some(Boolean) || metadata.header_image);
  case 'grid_p':
    return hasLocalizedImages(metadata.library_capsule_full) || Boolean(metadata.library_capsule);
  case 'hero':
    return hasLocalizedImages(metadata.library_hero_full) || Boolean(metadata.library_hero);
  case 'logo':
    return hasLocalizedImages(metadata.library_logo_full) || Boolean(metadata.library_logo);
  case 'icon':
    return Boolean(metadata.clienticon || metadata.icon);
  default:
    return false;
  }
};

const AssetTabs: FC<{
  currentTab: string,
  onShowTab: TabsProps['onShowTab']
}> = ({ currentTab, onShowTab }) => {
  const { get, set } = useSettings();
  const { appOverview, changeAsset, changeAssetFromUrl, clearAsset } = useSGDB();
  const {
    openFilters, loading, assets, currentFilters, externalSgdbData, setCoverAspect,
  } = useAssetSearch();
  const [tabPositions, setTabPositions] = useState<string[]>(DEFAULT_TABS as string[]);
  const [hiddenTabs, setHiddenTabs] = useState<string[]>([]);
  const [logoHidden, setLogoHidden] = useState(false);
  const [perfect, setPerfect] = useState<{ hero: boolean; grid_l: boolean }>({ hero: false, grid_l: false });

  useEffect(() => {
    void (async () => {
      setTabPositions(await get('tabs_order', DEFAULT_TABS));
      setHiddenTabs(await get('tabs_hidden', []));
      const useCount = await get('plugin_use_count', 0);
      set('plugin_use_count', useCount + 1, true);
    })();
  }, [get, set]);

  const tabs = useMemo(() => {
    const visible = tabPositions
      .filter((type) => !(type === 'icon' && (
        appOverview.third_party_mod ||
        (appOverview.BIsShortcut() && appOverview.selected_clientid != '0')
      )))
      .filter((type) => !hiddenTabs.includes(type));
    return visible.length > 0 ? visible : ['manage'];
  }, [appOverview, hiddenTabs, tabPositions]);

  const active = tabs.includes(currentTab) ? currentTab : tabs[0];
  const isAssetTab = active !== 'manage';
  const assetType = active as SGDBAssetType;
  const showTab = useCallback((id: string) => (onShowTab as ((tabID: string) => void))?.(id), [onShowTab]);

  const refreshPerfect = useCallback(async () => {
    if (!appOverview?.appid) return;
    const [hero, banner] = await Promise.all([
      isPerfectArtwork(appOverview.appid, 'hero'),
      isPerfectArtwork(appOverview.appid, 'grid_l'),
    ]);
    setPerfect({ hero, grid_l: banner });
  }, [appOverview?.appid]);

  useEffect(() => { void refreshPerfect(); }, [refreshPerfect]);

  useEffect(() => {
    if (!appOverview?.appid) return;
    void isLogoHidden(appOverview.appid).then(setLogoHidden);
  }, [appOverview?.appid, active]);

  /* LB / RB move between tabs anywhere in the workspace. */
  const cycleTab = useCallback((direction: number) => {
    const index = tabs.indexOf(active);
    if (index < 0) return;
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    if (next && next !== active) showTab(next);
  }, [active, showTab, tabs]);

  const handleButtonDown = useCallback((event: GamepadEvent) => {
    if (event.detail.button === GamepadButton.BUMPER_LEFT) {
      event.stopPropagation();
      cycleTab(-1);
    } else if (event.detail.button === GamepadButton.BUMPER_RIGHT) {
      event.stopPropagation();
      cycleTab(1);
    }
  }, [cycleTab]);

  /*
    The page takes the focus itself, on the tab that is open.

    Without this Steam leaves the focus wherever it was - the search bar at the top of the
    interface - so arriving on the plugin page meant pressing down a few times before
    anything responded.
  */
  const activeTabRef = useRef<any>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        activeTabRef.current?.focus?.();
      } catch (_) {
        // Steam has not mounted the button yet; the next render tries again.
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, []);

  /* Live description of what the current scraper is actually returning. */
  const statusLine = useMemo(() => {
    if (active === 'manage') return 'Artwork attualmente installati per questo gioco';
    const label = providerLabel(currentFilters?.provider ?? currentFilters?.providers?.[0]);
    if (loading) return `Ricerca in corso su ${label}…`;
    if (!assets?.length) return `Nessun risultato su ${label} con i filtri attuali`;
    /*
      The shape named here is what was really searched.

      It used to repeat the filter blindly and announced "cover verticali e quadrate" even
      on a source that only has square ones - which is exactly the promise the search
      cannot keep.
    */
    let shape = (ASSET_TAB_LABEL[assetType] ?? '').toLowerCase();
    if (assetType === 'grid_p') {
      const config = providerForId(String(currentFilters?.provider ?? currentFilters?.providers?.[0] ?? ''));
      const available = coverShapesForProvider(config);
      const chosen = String(currentFilters?.aspectMode ?? 'both');
      const shapes = available.length > 1 && (chosen === 'square' || chosen === 'portrait')
        ? available.filter((entry) => entry === chosen)
        : available;
      shape = shapes.length > 1
        ? 'cover verticali e quadrate'
        : shapes[0] === 'square' ? 'cover quadrate' : 'cover verticali';
    }
    return `${assets.length} risultati da ${label}${shape ? ` · ${shape}` : ''}`;
  }, [active, assetType, assets, currentFilters, loading]);

  const composerTarget = assetType === 'hero' ? 'hero' : 'grid_l';
  const composerLabel = assetType === 'hero' ? 'Crea Perfect Hero' : 'Crea Perfect Banner';

  const openComposer = () => showModal(
    <ArtworkComposerModal
      appId={appOverview.appid}
      target={composerTarget}
      onSave={async (data, format, withLogo) => {
        await changeAsset(data, composerTarget, format);
        /*
          A Perfect composition that CARRIES the logo means Steam's separate logo layer is
          shrunk to nothing - for the banner too, not just the hero - otherwise the logo is
          drawn twice. When the logo was deliberately left out of the composition the
          opposite is true: Steam's own layer is what shows it, so it goes back on.
        */
        await markPerfectArtwork(appOverview.appid, composerTarget, withLogo);
        if (composerTarget === 'hero') {
          // From this point it is a manual composition, no longer the untouched Zaza hero.
          await Promise.all([
            call('delete_setting', `manual_zazamastro_hero_${appOverview.appid}`),
            call('delete_setting', `zazamastro_hero_${appOverview.appid}`),
          ]);
        }
        if (!withLogo) await showLogo(appOverview.appid);
        await refreshPerfect();
        setLogoHidden(await isLogoHidden(appOverview.appid));
      }}
    />,
    window
  );

  const removePerfect = async () => {
    try {
      await clearAsset(composerTarget);
      await clearPerfectArtwork(appOverview.appid, composerTarget);
      await refreshPerfect();
      setLogoHidden(await isLogoHidden(appOverview.appid));
      toaster.toast({
        title: appOverview.display_name,
        body: composerTarget === 'hero'
          ? 'Perfect Hero rimosso, tornano hero di Steam e logo separato.'
          : 'Perfect Banner rimosso, torna il banner di Steam.',
        icon: <MenuIcon />,
        duration: 2200,
      });
    } catch (error: any) {
      toaster.toast({ title: 'Rimozione non riuscita', body: error?.message ?? 'Riprova.', icon: <MenuIcon fill="#ff5d5d" /> });
    }
  };

  const openOfficialAssets = () => showModal((
    <OfficialAssetsModal
      onAssetChange={async (url) => {
        try {
          await changeAssetFromUrl(url, assetType);
          toaster.toast({
            title: appOverview?.display_name,
            body: t('MSG_ASSET_APPLY_SUCCESS', '{assetType} has been successfully applied!').replace('{assetType}', SGDB_ASSET_TYPE_READABLE[assetType]),
            icon: <MenuIcon />,
            duration: 1500,
          });
        } catch (err: any) {
          toaster.toast({
            title: t('MSG_ASSET_APPLY_ERROR', 'There was a problem applying this asset.'),
            body: err.message,
            icon: <MenuIcon fill="#f3171e" />,
          });
        }
      }}
      assetType={assetType}
      data={externalSgdbData}
    />
  ), window);

  return (
    <Focusable
      className="pa-workspace"
      flow-children="vertical"
      onButtonDown={handleButtonDown}
      onSecondaryButton={isAssetTab ? () => openFilters(assetType) : undefined}
      onSecondaryActionDescription={isAssetTab ? 'Filtri' : undefined}
      actionDescriptionMap={tabs.length > 1 ? {
        [GamepadButton.BUMPER_LEFT]: 'Scheda precedente',
        [GamepadButton.BUMPER_RIGHT]: 'Scheda successiva',
      } : undefined}
    >
      <header className="pa-ws-head">
        <div className="pa-ws-identity">
          <span className="pa-ws-kicker">Playhub Artworks</span>
          <strong>{appOverview.display_name}</strong>
          <span className="pa-ws-status" aria-live="polite">{statusLine}</span>
        </div>
      </header>

      <Focusable className="pa-ws-tabs" flow-children="grid">
        {tabs.map((type) => (
          <DialogButton
            key={type}
            ref={type === active ? activeTabRef : undefined}
            className={type === active ? 'active' : ''}
            onClick={() => showTab(type)}
          >
            {TAB_ICONS[type] ?? TAB_ICONS.manage}
            <span>{ASSET_TAB_LABEL[type] ?? type}</span>
          </DialogButton>
        ))}
      </Focusable>

      {isAssetTab && (
        <Focusable className="pa-ws-actions" flow-children="grid">
          <DialogButton className="pa-action" onClick={() => openFilters(assetType)}>
            <FaSlidersH /><span>Filtri</span>
          </DialogButton>

          {/*
            Verticali/Quadrate only exists where BOTH shapes exist.

            IGN, PlayStation and Nintendo publish square covers only, so offering
            "Verticali" on them is a button whose only possible outcome is an empty grid.
          */}
          {assetType === 'grid_p' && coverShapesForProvider(providerForId(String(
            currentFilters?.provider ?? currentFilters?.providers?.[0] ?? ''
          ))).length > 1 && (
            <>
              <DialogButton
                className={`pa-action pa-toggle ${currentFilters?.aspectMode !== 'square' ? 'active' : ''}`}
                onClick={() => void setCoverAspect('portrait')}
              >
                <MdCropPortrait /><span>Verticali</span>
              </DialogButton>
              <DialogButton
                className={`pa-action pa-toggle ${currentFilters?.aspectMode === 'square' ? 'active' : ''}`}
                onClick={() => void setCoverAspect('square')}
              >
                <MdApps /><span>Quadrate</span>
              </DialogButton>
            </>
          )}

          {(assetType === 'hero' || assetType === 'grid_l') && (
            <>
              <DialogButton className="pa-action" onClick={openComposer}>
                <MdAutoAwesome /><span>{composerLabel}</span>
              </DialogButton>
              {/* The logo sits on top of the hero, so it is adjusted from here too. */}
              {assetType === 'hero' && (
                <DialogButton
                  className="pa-action"
                  onClick={() => showModal(<LogoPositionerModal appId={appOverview.appid} />, window)}
                >
                  <MdTune /><span>Posiziona logo</span>
                </DialogButton>
              )}
              {perfect[composerTarget] && (
                <DialogButton className="pa-action" onClick={() => void removePerfect()}>
                  <HiTrash /><span>{assetType === 'hero' ? 'Rimuovi Perfect Hero' : 'Rimuovi Perfect Banner'}</span>
                </DialogButton>
              )}
            </>
          )}

          {assetType === 'logo' && (
            <>
              <DialogButton
                className="pa-action"
                onClick={() => showModal(<LogoPositionerModal appId={appOverview.appid} />, window)}
              >
                <MdTune /><span>Posiziona logo</span>
              </DialogButton>
              <DialogButton
                className="pa-action"
                onClick={() => void (async () => {
                  if (logoHidden) await showLogo(appOverview.appid);
                  else await hideLogo(appOverview.appid);
                  setLogoHidden(!logoHidden);
                })()}
              >
                {logoHidden ? <HiEye /> : <HiEyeSlash />}
                <span>{logoHidden ? 'Mostra logo' : 'Nascondi logo'}</span>
              </DialogButton>
            </>
          )}

          {hasOfficialAsset(externalSgdbData, assetType) && (
            <DialogButton className="pa-action" onClick={openOfficialAssets}>
              <FaSteam /><span>Ufficiali Steam</span>
            </DialogButton>
          )}
        </Focusable>
      )}

      <div className="pa-ws-body">
        {active === 'manage'
          ? <ManageTab />
          : (
            <AssetTab
              key={assetType}
              assetType={assetType}
              onArtworkApplied={() => {
                void refreshPerfect();
                void isLogoHidden(appOverview.appid).then(setLogoHidden);
              }}
            />
          )}
      </div>
    </Focusable>
  );
};

export default memo(AssetTabs);
