import { Focusable, showModal } from '@decky/ui';
import { call, toaster } from '@decky/api';
import { useState, FC, useRef, useEffect, useCallback } from 'react';

import { useSGDB } from '../../hooks/useSGDB';
import Asset from '../asset/Asset';
import t from '../../utils/i18n';
import MenuIcon from '../Icons/MenuIcon';
import AssetDetailsModal from '../../modals/AssetDetailsModal';
import { SGDB_ASSET_TYPE_READABLE } from '../../constants';
import useAssetSearch from '../../hooks/useAssetSearch';
import useSettings from '../../hooks/useSettings';
import { artworkJobKey, isArtworkTargetBusy, useArtworkJobs } from '../../utils/artworkJobStore';
import { isZazaMastroAsset } from '../../utils/zazamastroBatch';
import { clearPerfectArtwork, markPerfectArtwork } from '../../utils/perfectArtwork';

const AssetTab: FC<{ assetType: SGDBAssetType; onArtworkApplied?: () => void }> = ({ assetType, onArtworkApplied }) => {
  const { get } = useSettings();
  const {
    loading: searchLoading,
    assets,
    searchAndSetAssets,
    loadMore,
    openFilters,
    endReached,
    currentFilters,
  } = useAssetSearch();
  const { appOverview, changeAssetFromUrl } = useSGDB();
  const artworkJobs = useArtworkJobs();
  const [tabLoading, setTabLoading] = useState(true);
  const loading = searchLoading || tabLoading;

  const scrollRef = useRef<HTMLDivElement>(null);
  const intersectRef = useRef<HTMLDivElement>(null);

  const setAsset = useCallback(async (asset: any) => {
    if (isArtworkTargetBusy(appOverview.appid, assetType)) return;
    try {
      /*
        There is only ever one hero (and one banner) per game. Picking a new one from the
        grid therefore replaces whatever was there - including a Perfect composition and
        the untouched source it was built from - so the next edit starts from THIS artwork
        instead of quietly re-composing the old one.
      */
      if (assetType === 'hero' || assetType === 'grid_l') {
        await clearPerfectArtwork(appOverview.appid, assetType);
      }

      await changeAssetFromUrl(asset.url, assetType);

      /*
        A ZazaMastro hero already has the logo painted into it, so Steam's separate
        logo layer has to go or the game page shows it twice.
      */
      const zazaHero = assetType === 'hero' && isZazaMastroAsset(asset);
      if (assetType === 'hero') {
        if (zazaHero) {
          await call('set_setting', `manual_zazamastro_hero_${appOverview.appid}`, true);
          await markPerfectArtwork(appOverview.appid, 'hero', true);
        } else {
          await call('delete_setting', `manual_zazamastro_hero_${appOverview.appid}`);
        }
      }
      onArtworkApplied?.();

      toaster.toast({
        title: appOverview?.display_name,
        body: zazaHero
          ? 'Perfect Hero applicato. Il logo separato è stato nascosto.'
          : t('MSG_ASSET_APPLY_SUCCESS', '{assetType} has been successfully applied!').replace('{assetType}', SGDB_ASSET_TYPE_READABLE[assetType]),
        icon: <MenuIcon />,
        duration: zazaHero ? 2600 : 1500,
      });
    } catch (err: any) {
      toaster.toast({
        title: t('MSG_ASSET_APPLY_ERROR', 'There was a problem applying this asset.'),
        body: err.message,
        icon: <MenuIcon fill="#f3171e" />,
      });
    }
  }, [appOverview, assetType, changeAssetFromUrl, onArtworkApplied]);

  const openDetails = useCallback((asset: any) => {
    showModal(
      <AssetDetailsModal
        asset={asset}
        assetType={assetType}
        onApply={() => setAsset(asset)}
      />,
      window
    );
  }, [assetType, setAsset]);

  useEffect(() => {
    (async () => {
      setTabLoading(true);
      const filters = await get(`filters_${assetType}`, null);
      await searchAndSetAssets(assetType, 0, filters, () => {
        setTabLoading(false);
      });
    })();
  }, [searchAndSetAssets, assetType, get]);

  useEffect(() => {
    if (!intersectRef.current || loading || endReached) return;
    const observer = new IntersectionObserver(([entry], self) => {
      if (entry.isIntersecting) {
        loadMore(assetType, (res) => {
          if (res.length === 0) self.disconnect();
        });
      }
    }, { threshold: 0, root: scrollRef.current });
    observer.observe(intersectRef.current);
    return () => observer.disconnect();
  }, [assetType, endReached, loadMore, loading]);

  if (!appOverview) return null;

  return (
    <div className="pa-results">
      <div className="pa-results-scroll" ref={scrollRef}>
        {loading ? (
          <div className="pa-inline-state">
            <img alt="" src="/images/steam_spinner.png" />
            <span>Sto cercando gli artwork…</span>
          </div>
        ) : (
          <Focusable className={`pa-grid type-${assetType}`} flow-children="grid">
            {assets.map((asset: any) => {
              const job = artworkJobs.find((item) => item.key === artworkJobKey(appOverview.appid, assetType, asset.url));
              return (
                <Asset
                  key={asset.id}
                  scrollContainer={scrollRef.current as Element}
                  author={asset.author}
                  provider={asset.provider ?? currentFilters?.provider ?? currentFilters?.providers?.[0] ?? 'steamgriddb'}
                  notes={asset.notes}
                  src={asset.thumb}
                  width={asset.width}
                  height={asset.height}
                  humor={asset.humor}
                  epilepsy={asset.epilepsy}
                  nsfw={asset.nsfw}
                  assetType={assetType}
                  isAnimated={String(asset.thumb).includes('.webm')}
                  isDownloading={job?.status === 'running'}
                  downloadProgress={job?.progress}
                  downloadStatus={job?.status}
                  onActivate={() => setAsset(asset)}
                  onOKActionDescription={t('ACTION_ASSET_APPLY', 'Apply {assetType}').replace('{assetType}', SGDB_ASSET_TYPE_READABLE[assetType])}
                  onSecondaryActionDescription="Filtri"
                  onSecondaryButton={() => openFilters(assetType)}
                  onMenuActionDescription="Dettagli"
                  onMenuButton={() => openDetails(asset)}
                  onContextMenu={(evt: any) => {
                    evt.preventDefault();
                    openDetails(asset);
                  }}
                />
              );
            })}
            <div ref={intersectRef} style={{ gridColumn: '1 / -1', height: '4px' }} />
            {assets.length === 0 && (
              <div className="pa-empty">{t('Search_NoResults', 'No Results Found.', true)}</div>
            )}
          </Focusable>
        )}
      </div>
    </div>
  );
};

export default AssetTab;
