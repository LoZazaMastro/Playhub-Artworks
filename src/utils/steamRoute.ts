import { findSteamUI } from './steamWindow';

export const steamView = (): Window => findSteamUI()?.window ?? window;

export const steamPath = (): string => {
  try { return findSteamUI()?.path ?? steamView().location?.pathname ?? ''; } catch { return ''; }
};

export const steamHref = (): string => {
  try { return steamView().location?.href ?? ''; } catch { return ''; }
};

export const isHomeRoute = (path = steamPath()): boolean =>
  /\/library\/home(?:\/|$)/i.test(path);

export const isCollectionsOverview = (path = steamPath()): boolean =>
  /\/library\/(?:tab\/collections|collections)(?:\/|$)/i.test(path);

export const isSquareLibraryRoute = (path = steamPath()): boolean => {
  if (isHomeRoute(path) || isCollectionsOverview(path) || /\/library\/app(?:\/|$)/i.test(path)) {
    return false;
  }
  return /\/library(?:\/tab(?:\/|$)|\/collection(?:\/|$)|\/?$)/i.test(path);
};
