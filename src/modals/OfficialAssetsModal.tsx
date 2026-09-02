import { DialogButton, Focusable } from '@decky/ui';
import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { HiArrowDownTray } from 'react-icons/hi2';

import SteamLang from '../utils/steam-api-language-map';
import { SGDB_ASSET_TYPE_READABLE } from '../constants';
import t from '../utils/i18n';

type FullAssetImages = {
  image?: { [language: string]: string };
  image2x?: { [language: string]: string };
};

type FullHeaderImages = { [languageCode: string]: string };

type SteamMetadata = {
  store_asset_mtime?: number | null;
  library_capsule?: string | null;
  library_logo?: string | null;
  library_hero?: string | null;
  logo_position?: string | null;
  header_image?: string | null;
  clienticon?: string | null;
  icon?: string | null;
  header_image_full?: FullHeaderImages | null;
  library_capsule_full?: FullAssetImages | null;
  library_hero_full?: FullAssetImages | null;
  library_logo_full?: FullAssetImages | null;
};

const localizedImages = (full: FullAssetImages | null | undefined, fallback?: string | null) => {
  const images = full?.image ?? {};
  return Object.keys(images).length > 0 ? images : fallback ? { english: fallback } : {};
};

/** Steam's own asset for this game, per language, at its declared size. */
const buildVariants = (
  assetType: SGDBAssetType,
  steamId: string,
  meta: SteamMetadata
): Array<{ language: string; url: string; fallback?: string; width: number; height: number }> => {
  const officialUrl = (fileName: string) =>
    `https://shared.steamstatic.com/store_item_assets/steam/apps/${steamId}/${fileName}?t=${meta.store_asset_mtime ?? 0}`;

  switch (assetType) {
  case 'grid_l': {
    const images = Object.keys(meta.header_image_full ?? {}).length > 0
      ? meta.header_image_full ?? {}
      : meta.header_image ? { english: meta.header_image } : {};
    return Object.entries(images).map(([language, file]) => ({
      language,
      url: officialUrl(String(file).replace(/\.jpg$/, '_2x.jpg')),
      fallback: officialUrl(String(file)),
      width: 920,
      height: 430,
    }));
  }
  case 'grid_p': {
    const images = localizedImages(meta.library_capsule_full, meta.library_capsule);
    return Object.entries(images).map(([language, file]) => ({
      language,
      url: officialUrl(meta.library_capsule_full?.image2x?.[language] ?? String(file)),
      fallback: officialUrl(String(file)),
      width: 600,
      height: 900,
    }));
  }
  case 'hero': {
    const images = localizedImages(meta.library_hero_full, meta.library_hero);
    return Object.entries(images).map(([language, file]) => ({
      language,
      url: officialUrl(meta.library_hero_full?.image2x?.[language] ?? String(file)),
      fallback: officialUrl(String(file)),
      width: 1920,
      height: 620,
    }));
  }
  case 'logo': {
    const images = localizedImages(meta.library_logo_full, meta.library_logo);
    return Object.entries(images).map(([language, file]) => ({
      language,
      url: officialUrl(meta.library_logo_full?.image2x?.[language] ?? String(file)),
      fallback: officialUrl(String(file)),
      width: 0,
      height: 0,
    }));
  }
  case 'icon':
    return (meta.clienticon || meta.icon)
      ? [{
        language: 'english',
        url: `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${steamId}/${meta.clienticon ?? meta.icon}.ico`,
        width: 32,
        height: 32,
      }]
      : [];
  default:
    return [];
  }
};

const OfficialAssetsModal: FC<{
  closeModal?: () => void,
  assetType: SGDBAssetType,
  onAssetChange?: (url: string) => Promise<any>,
  data: { steam: { id: string; metadata: SteamMetadata }[] },
}> = ({ closeModal, assetType, data, onAssetChange }) => {
  const steam = data?.steam?.[0];
  const variants = useMemo(
    () => (steam?.metadata ? buildVariants(assetType, steam.id, steam.metadata) : []),
    [assetType, steam]
  );

  /* Steam's own UI language first, then English, then whatever exists. */
  const preferredIndex = useMemo(() => {
    const steamLocale = window.LocalizationManager?.m_rgLocalesToUse?.[0] ?? 'en';
    const candidates = [
      SteamLang(steamLocale, 'webapi', 'api'),
      SteamLang(steamLocale, 'api', 'api'),
      steamLocale,
      SteamLang('en', 'webapi', 'api'),
      'english',
    ].filter(Boolean) as string[];
    const found = variants.findIndex((variant) =>
      candidates.some((candidate) => variant.language.toLowerCase() === String(candidate).toLowerCase()));
    return found >= 0 ? found : 0;
  }, [variants]);

  const [index, setIndex] = useState(0);
  const [usedFallback, setUsedFallback] = useState(false);
  const [applying, setApplying] = useState(false);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const applyRef = useRef<any>(null);

  useEffect(() => { setIndex(preferredIndex); }, [preferredIndex]);
  useEffect(() => { setUsedFallback(false); }, [index]);

  const close = () => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => closeModal?.(), 170);
  };

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    node.addEventListener('vgp_oncancel', onCancel);
    window.setTimeout(() => applyRef.current?.focus(), 0);
    return () => node.removeEventListener('vgp_oncancel', onCancel);
  // close is stable enough for the lifetime of the modal.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = variants[index];
  if (!current) return null;

  const source = usedFallback && current.fallback ? current.fallback : current.url;

  const apply = async () => {
    if (applying) return;
    setApplying(true);
    try {
      await onAssetChange?.(source);
      close();
    } finally {
      setApplying(false);
    }
  };

  const applyLabel = t('ACTION_ASSET_APPLY', 'Apply {assetType}')
    .replace('{assetType}', SGDB_ASSET_TYPE_READABLE[assetType]);

  return (
    <Focusable
      ref={rootRef}
      className={`pa-details ${closing ? 'is-closing' : ''}`}
      flow-children="vertical"
      onCancel={close}
      onCancelButton={close}
      onCancelActionDescription="Chiudi"
    >
      <div className="pa-details-backdrop" onClick={close} />

      {/*
        The panel is a Focusable column, not a plain div.

        With a plain div between them, the language pills and the apply button were two
        unrelated focus islands: pressing down on a language did not reach "Scarica e
        applica", and pressing up from the button did not reach the languages. Every menu
        in this plugin has to navigate in all four directions, so the column that owns
        both of them says so.
      */}
      <Focusable className="pa-details-panel" flow-children="vertical">
        <div className="pa-details-head">
          <strong>Artwork ufficiale Steam</strong>
        </div>

        <div className={`pa-details-preview type-${assetType}`}>
          <img
            src={source}
            alt=""
            onError={() => { if (current.fallback && !usedFallback) setUsedFallback(true); }}
          />
        </div>

        <Focusable className="pa-details-body" flow-children="vertical">
          <dl className="pa-details-meta">
            <div><dt>Sorgente</dt><dd>Steam</dd></div>
            <div>
              <dt>Dimensioni</dt>
              <dd>{current.width > 0 ? `${current.width} × ${current.height}` : 'variabili'}</dd>
            </div>
            <div><dt>Lingua</dt><dd>{SteamLang(current.language, 'api', 'native') || current.language}</dd></div>
          </dl>

          {/* An official asset often exists in several languages. */}
          {variants.length > 1 && (
            <div className="pa-details-langs">
              <span className="pa-details-langs-label">{t('LanguageTitle', 'Language', true)}</span>
              {/*
                Horizontal, so up and down leave the row instead of being swallowed by it:
                a grid flow keeps vertical presses for its own rows and the button below
                stayed unreachable.
              */}
              <Focusable className="pa-filter-choices" flow-children="horizontal">
                {variants.map((variant, position) => (
                  <DialogButton
                    key={variant.language}
                    className={`pa-choice-pill ${position === index ? 'on' : ''}`}
                    onClick={() => setIndex(position)}
                  >
                    {SteamLang(variant.language, 'api', 'native') || variant.language}
                  </DialogButton>
                ))}
              </Focusable>
            </div>
          )}
        </Focusable>

        <DialogButton
          ref={applyRef}
          className="pa-details-apply"
          disabled={applying}
          onClick={() => void apply()}
          onOKActionDescription={applyLabel}
          onCancelActionDescription="Chiudi"
        >
          <HiArrowDownTray />
          <span>{applying ? 'Download in corso…' : 'Scarica e applica'}</span>
        </DialogButton>
      </Focusable>
    </Focusable>
  );
};

export default OfficialAssetsModal;
