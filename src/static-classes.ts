import { findModule, findClassModule } from '@decky/ui';

type ClassMap = Record<string, string>;

/*
  Steam ships different class module shapes across betas. A missing module used to throw
  `Cannot read properties of undefined` while Playhub Artworks was mounting, which killed the
  whole plugin on Decky startup. Every lookup is now defensive and always returns an object.
*/
const findOnce = (finder: () => any): ClassMap | null => {
  try {
    const found = finder();
    return (found && typeof found === 'object' && Object.keys(found).length > 0) ? found as ClassMap : null;
  } catch (_) {
    return null;
  }
};

/*
  Class modules are resolved LAZILY, and retried until they resolve.

  They used to be looked up once, at import time. At Decky start - and every time Big
  Picture is opened - Steam has not necessarily loaded the chunk that owns them yet, so
  the lookup returned nothing and the empty result was kept for the whole session: the
  library cover format silently did not apply, with no error anywhere. Now the first
  successful lookup is cached and every access before that tries again, so the styles
  land as soon as Steam is ready.
*/
const lazyModule = (finder: () => any): ClassMap => {
  let resolved: ClassMap | null = null;
  const value = (): ClassMap => {
    if (!resolved) resolved = findOnce(finder);
    return resolved ?? {};
  };

  return new Proxy({} as ClassMap, {
    get: (_target, property: string | symbol) => (value() as any)[property],
    has: (_target, property: string | symbol) => property in value(),
    ownKeys: () => Reflect.ownKeys(value()),
    getOwnPropertyDescriptor: (_target, property: string | symbol) => {
      const found = (value() as any)[property];
      return found === undefined
        ? undefined
        : { value: found, enumerable: true, configurable: true, writable: false };
    },
  });
};

export const libraryAssetImageClasses = lazyModule(() => findModule((mod: any) => typeof mod === 'object' && mod?.PortraitImage && mod?.Container && mod?.LandscapeImage));
export const gamepadLibraryClasses = lazyModule(() => findModule((mod: any) => typeof mod === 'object' && mod?.GamepadLibrary));
/*
  The Home hero image, plus the containers around it.

  The Playhub CSS Loader profile ("Proper Hero Scaling", 169home.css) pins this element to
  `object-position: top center !important`. That is fine for a 1920x620 hero and wrong for
  anything taller: the picture is cropped from the top instead of the middle, which is the
  discrepancy between the Home and the game page.
*/
export const homeRecentsClasses = lazyModule(() => findModule((mod: any) =>
  typeof mod === 'object' && mod?.RecentGamesBackgroundImage && mod?.RecentGamesBackgroundImages));

/*
  The recents ROW's own classes, which are not the carousel's.

  Steam names them in the component that builds the Home recents: `RecentGame`,
  `RecentGameMediaContainer` and `Featured` for the first item.
*/
export const recentGameClasses = lazyModule(() => findModule((mod: any) =>
  typeof mod === 'object' && mod?.RecentGameMediaContainer));

export const homeCarouselClasses = lazyModule(() => findModule((mod: any) => typeof mod === 'object' && mod?.Featured && mod?.LabelHeight && mod?.CarouselGameLabelWrapper));
/*
  `InRecentGames` does NOT live in the AppPortraitBanner module.

  It was looked up there for a long time and always came back empty, which meant every
  Home selector was malformed and the "classes are ready" check could never succeed - so
  the layout controller retried forever, tearing down and rebuilding the Home patch each
  time and stacking `replacePatch` layers on the carousel until the Home fell apart. The
  class belongs to the library-item-box module, alongside `LibraryItemBox` and
  `HoversEnabled`.
*/
export const appportraitClasses = lazyModule(() => findModule((mod: any) =>
  typeof mod === 'object' && mod?.InRecentGames && mod?.LibraryItemBox && mod?.HoversEnabled));
// seems to have Marquee, info box, and subheader stuff
export const miscInfoClasses = lazyModule(() => findClassModule((m: any) => m.ResetOnPause && m.Content && m.Playing && m.BackgroundAnimation && m.Container));

/** Returns `.the-class` or an empty string when Steam does not expose that class. */
export const sel = (map: ClassMap, key: string): string => {
  const value = map?.[key];
  return typeof value === 'string' && value.trim() ? `.${value.trim().split(' ').join('.')}` : '';
};

/** True when every requested class exists, so a patch can bail out instead of throwing. */
export const hasClasses = (map: ClassMap, ...keys: string[]): boolean =>
  keys.every((key) => typeof map?.[key] === 'string' && Boolean(map[key]));
