export const steamView = (): Window => window;

export const steamPath = (): string => window.location.pathname;

export const steamHref = (): string => window.location.href;

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
