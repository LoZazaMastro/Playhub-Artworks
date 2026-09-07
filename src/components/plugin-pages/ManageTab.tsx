import t from '../../utils/i18n';
import { FC, useState, useEffect, useRef, useCallback } from 'react';
import { call } from '@decky/api';
import { DialogButton, Focusable } from '@decky/ui';
import { HiFolderOpen, HiTrash } from 'react-icons/hi2';

import useSGDB from '../../hooks/useSGDB';
import getAppOverview from '../../utils/getAppOverview';
import { clearPerfectArtwork } from '../../utils/perfectArtwork';
import openFilePicker from '../../utils/openFilePicker';
import { artworkSources, useArtworkPreview } from '../../utils/artworkSources';

const SLOTS: Array<{ assetType: SGDBAssetType; title: string; hint: string }> = [
  { assetType: 'grid_p', title: t('PA_COVER', 'Cover'), hint: t('PA_COVER_HINT', 'Portrait or square, used in the library') },
  { assetType: 'grid_l', title: t('PA_BANNER', 'Banner'), hint: t('PA_BANNER_HINT', 'Horizontal capsule') },
  { assetType: 'hero', title: t('PA_BACKGROUND', 'Background'), hint: t('PA_BACKGROUND_HINT', 'Game page header') },
  { assetType: 'logo', title: t('ASSET_TYPE_LOGO', 'Logo'), hint: t('PA_LOGO_HINT', 'Transparent, overlaid on the background') },
  { assetType: 'icon', title: t('ASSET_TYPE_ICON', 'Icon'), hint: t('PA_ICON_HINT', 'Square, used in lists') },
];

const AssetSlot: FC<{
  app: AppStoreAppOverview;
  assetType: SGDBAssetType;
  title: string;
  hint: string;
  browseStartPath: string;
  editable: boolean;
  active: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
}> = ({ app, assetType, title, hint, browseStartPath, editable, active, onActivate, onDeactivate }) => {
  const { clearAsset, changeAssetFromUrl } = useSGDB();
  const [overview, setOverview] = useState<AppStoreAppOverview>(app);
  const [reloadKey, setReloadKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const preview = useArtworkPreview(artworkSources(overview, assetType), reloadKey);

  const refresh = useCallback(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const next = await getAppOverview(app.appid);
    if (next) setOverview(next);
    setReloadKey((value) => value + 1);
  }, [app.appid]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const browse = () => run(async () => {
    const path = await openFilePicker(browseStartPath, true, undefined, {
      validFileExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng', 'tiff', 'tga'],
    });
    // One hero, one banner: a file chosen here replaces any Perfect composition too.
    if (assetType === 'hero' || assetType === 'grid_l') {
      await clearPerfectArtwork(app.appid, assetType);
    }
    await changeAssetFromUrl(path.path as string, assetType, true);
  });

  const leave = () => {
    onDeactivate();
    window.setTimeout(() => cardRef.current?.focus(), 0);
  };

  return (
    <Focusable
      ref={cardRef}
      className={`pa-slot ${active ? 'is-active' : ''}`}
      focusClassName="is-focused"
      focusWithinClassName="is-focused"
      onActivate={editable && !active ? onActivate : undefined}
      onOKActionDescription={editable && !active ? t('PA_MANAGE_ITEM', 'Manage {item}').replace('{item}', title.toLowerCase()) : undefined}
    >
      <div className="pa-slot-art">
        {preview
          ? <img className="pa-slot-image" src={preview} alt="" />
          : <span className="pa-slot-missing">{t('PA_NO_ARTWORK', "No artwork")}</span>}
      </div>

      <div className="pa-slot-copy">
        <strong>{title}</strong>
        <span>{hint}</span>
        {!editable && <span className="pa-slot-locked">{t('PA_NOT_EDITABLE_SHORTCUT', 'Not editable for this shortcut')}</span>}
      </div>

      {/*
        The buttons only exist once the card is chosen. Keeping five cards' worth of
        buttons permanently focusable made Steam scroll sideways through them and push
        the artwork behind the top bar and the footer.
      */}
      {active && editable && (
        <Focusable
          className="pa-slot-actions"
          flow-children="horizontal"
          onCancelButton={leave}
          onCancelActionDescription={t('PA_BACK_TO_CARDS', 'Back to cards')}
        >
          <DialogButton
            disabled={busy}
            onClick={browse}
            onOKActionDescription={t('PA_CHOOSE_LOCAL_FILE', 'Choose a local file')}
          >
            <HiFolderOpen /><span>{t('PA_CHOOSE_FILE', "Choose file")}</span>
          </DialogButton>
          <DialogButton
            disabled={busy}
            onClick={() => run(async () => {
              // Restoring Steam's own artwork drops the Perfect composition with it.
              if (assetType === 'hero' || assetType === 'grid_l') {
                await clearPerfectArtwork(app.appid, assetType);
              }
              await clearAsset(assetType);
            })}
            onOKActionDescription={t('PA_RESTORE_STEAM_ART', 'Restore Steam artwork')}
          >
            <HiTrash /><span>{t('PA_DELETE', "Delete")}</span>
          </DialogButton>
        </Focusable>
      )}

      {!active && editable && (
        <span className="pa-slot-cta">{t('PA_PRESS_A_MANAGE', "Press A to manage")}</span>
      )}
    </Focusable>
  );
};

const ManageTab: FC = () => {
  const { appId, appOverview } = useSGDB();
  const [startPath, setStartPath] = useState('/');
  const [overview, setOverview] = useState<AppStoreAppOverview>();
  const [activeSlot, setActiveSlot] = useState<SGDBAssetType | null>(null);

  useEffect(() => {
    if (!appId) return;
    (async () => {
      const appoverview = await getAppOverview(appId);
      if (!appoverview) return;
      setOverview(appoverview);
      try {
        setStartPath(await call<[], string>('get_local_start'));
      } catch (_) {
        setStartPath('/');
      }
    })();
  }, [appId, appOverview]);

  if (!overview || !appId) return null;

  const iconEditable = !(overview.third_party_mod || (overview.BIsShortcut() && overview.selected_clientid != '0'));

  return (
    <div className="pa-results">
      <div className="pa-results-scroll pa-results-scroll-slots">
        <Focusable className="pa-slots" flow-children="vertical">
          {SLOTS.map((slot) => (
            <AssetSlot
              key={slot.assetType}
              app={overview}
              assetType={slot.assetType}
              title={slot.title}
              hint={slot.hint}
              browseStartPath={startPath}
              editable={slot.assetType === 'icon' ? iconEditable : true}
              active={activeSlot === slot.assetType}
              onActivate={() => setActiveSlot(slot.assetType)}
              onDeactivate={() => setActiveSlot(null)}
            />
          ))}
        </Focusable>
      </div>
    </div>
  );
};

export default ManageTab;
