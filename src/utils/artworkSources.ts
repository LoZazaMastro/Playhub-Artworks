import { artworkPayloadUrl, readArtworkSource } from './artworkTransfer';
import { useEffect, useState } from 'react';

/**
 * Candidate URLs for an artwork, custom first then whatever Steam itself would show.
 *
 * Going through Steam's own stores means the plugin never has to guess a file name,
 * and every asset type resolves the same way.
 */
const readUrls = (getter: () => any): string[] => {
  try {
    const value = getter();
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return values.map(item => typeof item === 'string' ? item : item?.strURL || item?.url || '').filter(Boolean);
  } catch (_) { return []; }
};

export const artworkSources = (app: AppStoreAppOverview, assetType: SGDBAssetType): string[] => {
  const store = window.appStore as any;
  const details = window.appDetailsStore as any;
  const getters: Array<() => any> = [];
  switch (assetType) {
  case 'grid_p':
    getters.push(() => store?.GetCustomVerticalCapsuleURLs?.(app), () => store?.GetVerticalCapsuleURLForApp?.(app),
      () => store?.GetCachedVerticalImageURLForApp?.(app), () => store?.GetPregeneratedVerticalCapsuleForApp?.(app));
    break;
  case 'grid_l':
    getters.push(() => store?.GetCustomLandscapeImageURLs?.(app), () => store?.GetCustomLandcapeImageURLs?.(app),
      () => store?.GetLandscapeImageURLForApp?.(app), () => store?.GetCachedLandscapeImageURLForApp?.(app));
    break;
  case 'hero':
    getters.push(() => store?.GetCustomHeroImageURLs?.(app), () => details?.GetHeroImagesForAppId?.(app.appid)?.rgHeroImages);
    break;
  case 'logo':
    getters.push(() => store?.GetCustomLogoImageURLs?.(app), () => details?.GetLogoImagesForAppId?.(app.appid)?.rgLogoImages,
      () => (app as any)?.m_strLogoURL);
    break;
  case 'icon': getters.push(() => store?.GetIconURLForApp?.(app)); break;
  }
  const official = app.appid > 0 && app.appid < 0x80000000 && !(app as any).is_shortcut
    ? officialArtwork(app.appid, assetType) : [];
  return [...new Set([...getters.flatMap(readUrls), ...official])];
};

/*
  A custom artwork, recognised by its URL.

  Steam serves the user's own artwork from its local loopback host, or from a per-user
  library path. `GetHeroImagesForAppId` and friends happily include those - which is why
  "only Steam's artwork" was still handing back the Perfect composition, logo and all.
*/
const isCustomArtwork = (url: string): boolean =>
  /steamloopback\.host/i.test(url) || /\/customimages\//i.test(url) || /\/library\/\d{6,}\//.test(url) || /\/userimages\//i.test(url);

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
    return [`${base}/logo.png`, `${base}/library_logo.png`];
  default:
    return [];
  }
};

/**
 * Real landscape artwork that can be turned into a cover, in strict priority order:
 * custom banner, Steam banner, custom hero, Steam hero.
 */
export const landscapeCoverSources = (app: AppStoreAppOverview): string[] => {
  const store = window.appStore as any;
  const details = window.appDetailsStore as any;
  const list = (value: any): string[] => (Array.isArray(value) ? value : value ? [value] : []);
  try {
    const customBanners = [
      ...list(store?.GetCustomLandscapeImageURLs?.(app)),
      ...list(store?.GetCustomLandcapeImageURLs?.(app)),
    ];
    const steamBanners = [
      ...list(store?.GetLandscapeImageURLForApp?.(app)),
      ...list(store?.GetCachedLandscapeImageURLForApp?.(app)),
      ...officialArtwork(app.appid, 'grid_l'),
    ].filter((url) => !isCustomArtwork(url));
    const customHeroes = list(store?.GetCustomHeroImageURLs?.(app));
    const steamHeroes = [
      ...list(details?.GetHeroImagesForAppId?.(app.appid)?.rgHeroImages),
      ...officialArtwork(app.appid, 'hero'),
    ].filter((url) => !isCustomArtwork(url));

    return [...new Set([
      ...customBanners,
      ...steamBanners,
      ...customHeroes,
      ...steamHeroes,
    ].filter(Boolean))];
  } catch (_) {
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
    const controller = new AbortController();
    setResolved('');
    void (async () => {
      for (const source of sources) {
        if (!active) return;
        try {
          const payload = await readArtworkSource(source, { signal: controller.signal, staticOnly: true });
          if (payload) {
            // Owned data URLs survive the editor closing and the asynchronous save.
            if (active) setResolved(artworkPayloadUrl(payload));
            return;
          }
        } catch (_) { /* Try the next real candidate, not a thumbnail. */ }
      }
    })();
    return () => { active = false; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return resolved;
};
