import { useEffect, useState } from 'react';

/**
 * Candidate URLs for an artwork, custom first then whatever Steam itself would show.
 *
 * Going through Steam's own stores means the plugin never has to guess a file name,
 * and every asset type resolves the same way.
 */
export const artworkSources = (app: AppStoreAppOverview, assetType: SGDBAssetType): string[] => {
  const store = window.appStore as any;
  const details = window.appDetailsStore as any;
  const list = (value: any): string[] => (Array.isArray(value) ? value : value ? [value] : []);

  try {
    switch (assetType) {
    case 'grid_p':
      return [
        ...list(store?.GetCustomVerticalCapsuleURLs?.(app)),
        ...list(store?.GetVerticalCapsuleURLForApp?.(app)),
        ...list(store?.GetCachedVerticalImageURLForApp?.(app)),
        ...list(store?.GetPregeneratedVerticalCapsuleForApp?.(app)),
      ].filter(Boolean);
    case 'grid_l':
      return [
        ...list(store?.GetCustomLandcapeImageURLs?.(app)),
        ...list(store?.GetLandscapeImageURLForApp?.(app)),
        ...list(store?.GetCachedLandscapeImageURLForApp?.(app)),
      ].filter(Boolean);
    case 'hero':
      return [
        ...list(store?.GetCustomHeroImageURLs?.(app)),
        ...list(details?.GetHeroImagesForAppId?.(app.appid)?.rgHeroImages),
      ].filter(Boolean);
    case 'logo':
      return [
        ...list(store?.GetCustomLogoImageURLs?.(app)),
        ...list(details?.GetLogoImagesForAppId?.(app.appid)?.rgLogoImages),
      ].filter(Boolean);
    case 'icon':
      return list(store?.GetIconURLForApp?.(app)).filter(Boolean);
    default:
      return [];
    }
  } catch (_) {
    return [];
  }
};

/*
  A custom artwork, recognised by its URL.

  Steam serves the user's own artwork from its local loopback host, or from a per-user
  library path. `GetHeroImagesForAppId` and friends happily include those - which is why
  "only Steam's artwork" was still handing back the Perfect composition, logo and all.
*/
const isCustomArtwork = (url: string): boolean =>
  /steamloopback\.host/i.test(url) || /\/library\/\d{6,}\//.test(url) || /\/userimages\//i.test(url);

/*
  Valve's own file for this app, straight from the store CDN.

  The last-resort guarantee: whatever the client has cached or replaced locally, this URL
  is the untouched publisher artwork. Without it, a game whose Perfect artwork was made
  before the original was kept aside had nothing clean left to start from.
*/
const officialArtwork = (appId: number, assetType: SGDBAssetType): string[] => {
  const base = `https://shared.steamstatic.com/store_item_assets/steam/apps/${appId}`;
  switch (assetType) {
  case 'hero':
    return [`${base}/library_hero.jpg`];
  case 'grid_l':
    return [`${base}/header.jpg`];
  case 'grid_p':
    return [`${base}/library_600x900.jpg`];
  case 'logo':
    return [`${base}/logo.png`];
  default:
    return [];
  }
};

/**
 * Only the artwork Steam itself would show, with every custom asset left out.
 *
 * This is the way back out of a Perfect composition: once a composed hero or banner has
 * been applied it IS the custom artwork, so re-opening the editor on it would compose a
 * second logo on top of the first. Custom URLs are filtered out by shape, and Valve's own
 * CDN file is appended so there is always something clean to fall back to.
 */
export const steamOwnArtworkSources = (app: AppStoreAppOverview, assetType: SGDBAssetType): string[] => {
  const store = window.appStore as any;
  const details = window.appDetailsStore as any;
  const list = (value: any): string[] => (Array.isArray(value) ? value : value ? [value] : []);

  let candidates: string[] = [];
  try {
    switch (assetType) {
    case 'grid_p':
      candidates = [
        ...list(store?.GetCachedVerticalImageURLForApp?.(app)),
        ...list(store?.GetPregeneratedVerticalCapsuleForApp?.(app)),
      ];
      break;
    case 'grid_l':
      candidates = list(store?.GetCachedLandscapeImageURLForApp?.(app));
      break;
    case 'hero':
      candidates = list(details?.GetHeroImagesForAppId?.(app.appid)?.rgHeroImages);
      break;
    case 'logo':
      candidates = list(details?.GetLogoImagesForAppId?.(app.appid)?.rgLogoImages);
      break;
    default:
      candidates = [];
    }
  } catch (_) {
    candidates = [];
  }

  return [
    ...candidates.filter((url) => url && !isCustomArtwork(url)),
    ...officialArtwork(app.appid, assetType),
  ];
};

/**
 * Resolves the first candidate that actually loads.
 * Steam hands out URLs that 404 often enough that trying them in order is the only
 * reliable way to end up with a picture on screen.
 */
export const useArtworkPreview = (sources: string[], reloadKey: unknown = 0) => {
  const [resolved, setResolved] = useState('');
  const key = `${sources.join('|')}#${String(reloadKey)}`;

  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setResolved('');
    void (async () => {
      for (const source of sources) {
        try {
          const response = await fetch(source, { cache: 'reload' });
          if (!response.ok) continue;
          const blob = await response.blob();
          if (!blob.size) continue;
          objectUrl = URL.createObjectURL(blob);
          if (active) setResolved(objectUrl);
          else URL.revokeObjectURL(objectUrl);
          return;
        } catch (_) {
          // try the next candidate
        }
      }
    })();
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  // The joined key already covers every source plus the explicit reload trigger.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return resolved;
};
