import { call } from '@decky/api';
import { findSP } from '@decky/ui';

import { gamepadLibraryClasses, libraryAssetImageClasses, appportraitClasses, hasClasses } from '../static-classes';
import log from '../utils/log';

import { addHomePatch, homeDiagnostics, removeHomePatch } from './homePatch';
import { applyHomeHeroCentering } from './homeHeroPatch';
import { addSquareLibraryPatch, removeSquareLibraryPatch } from './squareLibraryPatch';

export type LibraryCoverFormat = 'portrait' | 'square';
export type HomeRecentFormat = 'banner' | 'cover';

let retryTimer: number | undefined;
let lastSettings = { square: false, coverRecents: false };
let lastHeroSetting = false;
let cachedBootstrapPending = false;

/** What the layout was last told to be, for anything that needs to check the result. */
export const currentLayoutSettings = () => lastSettings;
let retries = 0;
const MAX_RETRIES = 30;

/**
 * True once Steam has loaded the class modules these styles are written against.
 *
 * Applying before that produced empty selectors and therefore no styles at all - which
 * is why the library cover format did not survive a Decky restart or a fresh Big Picture
 * session.
 */
const classesReady = (): boolean =>
  hasClasses(libraryAssetImageClasses, 'Container', 'PortraitImage') &&
  hasClasses(gamepadLibraryClasses, 'GamepadLibrary') &&
  hasClasses(appportraitClasses, 'InRecentGames');

/*
  The last known answer, kept where it can be read WITHOUT waiting.

  At a Big Picture start the plugin has to ask its python backend what the cover format is,
  and that is three websocket round trips through a process that is itself still starting.
  Steam draws the Home in the meantime - with Steam's own portrait covers - and the format
  only lands a beat later: the couple of seconds of "verticali più alte del banner" before
  everything snaps into place.

  So the answer is also kept in the Steam client's own localStorage, which reads
  synchronously. The patches go on with the remembered value in the same tick the plugin
  mounts, and the real answer from the backend confirms it (or corrects it) right after.
*/
const CACHE_KEY = 'playhub_artworks_layout';

type CachedLayout = { square: boolean; recents: HomeRecentFormat; hero: boolean };

const readCachedLayout = (): CachedLayout | null => {
  try {
    const raw = findSP()?.window?.localStorage?.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.square !== 'boolean') return null;
    return {
      square: parsed.square,
      recents: parsed.recents === 'cover' ? 'cover' : 'banner',
      hero: Boolean(parsed.hero),
    };
  } catch (_) {
    return null;
  }
};

const writeCachedLayout = (value: CachedLayout) => {
  try {
    findSP()?.window?.localStorage?.setItem(CACHE_KEY, JSON.stringify(value));
  } catch (_) {
    // Private mode, quota, a window mid-teardown: the backend answer still arrives.
  }
};

/** Puts the patches on with the remembered format, synchronously. */
export const applyCachedLayout = (): boolean => {
  const cached = readCachedLayout();
  if (!cached) return false;
  try {
    lastSettings = { square: cached.square, coverRecents: cached.recents === 'cover' };
    lastHeroSetting = cached.hero;
    removeHomePatch(true, true);
    if (!cached.square) removeSquareLibraryPatch(true);
    const squareApplied = cached.square ? addSquareLibraryPatch(true) : true;
    const homeApplied = addHomePatch(true, cached.square);
    const heroApplied = applyHomeHeroCentering(cached.hero);
    cachedBootstrapPending = squareApplied && homeApplied && heroApplied && classesReady();
    log('layout da cache', cached);
    return true;
  } catch (error) {
    log('layout da cache fallito', error);
    return false;
  }
};

export const refreshLayoutPatches = async (mounting = false) => {
  const read = async <T,>(key: string, fallback: T): Promise<T> => {
    try {
      return await call<[string, T], T>('get_setting', key, fallback);
    } catch (_) {
      return fallback;
    }
  };
  const [libraryCoverFormat, homeRecentFormat, centerHomeHero] = await Promise.all([
    read<LibraryCoverFormat>('library_cover_format', 'portrait'),
    read<HomeRecentFormat>('home_recent_format', 'banner'),
    read<boolean>('home_hero_center', false),
  ]);

  const square = libraryCoverFormat === 'square';
  const coverRecents = homeRecentFormat === 'cover';
  const hero = Boolean(centerHomeHero);
  const cachedLayoutMatches = cachedBootstrapPending
    && lastSettings.square === square
    && lastSettings.coverRecents === coverRecents
    && lastHeroSetting === hero;
  lastSettings = { square, coverRecents: homeRecentFormat === 'cover' };
  lastHeroSetting = hero;
  writeCachedLayout({ square, recents: homeRecentFormat, hero });

  if (mounting && cachedLayoutMatches) {
    cachedBootstrapPending = false;
    retries = 0;
    log('layout da cache confermato');
    return;
  }
  cachedBootstrapPending = false;
  let applied = false;

  /*
    The whole application is guarded, and the retry is scheduled from `finally`.

    This is what made the cover format "forget itself" on every cold start: `findSP()`
    throws while Steam is still building its UI, the throw escaped from the style
    injector, and `refreshLayoutPatches` never reached the code that would have tried
    again. The setting was read correctly and then silently dropped for the rest of the
    session.
  */
  try {
    /*
      Unconditionally, not `if (active)`.

      `active` is false in a freshly loaded bundle, so the previous bundle's patches - which
      are still live on Steam's own objects - were never taken down on a plugin reload.
    */
    removeHomePatch(true, true);
    if (!square) removeSquareLibraryPatch(true);

    const squareApplied = square ? addSquareLibraryPatch(true) : true;
    const homeApplied = addHomePatch(mounting, square);
    /*
      The first recent is a banner by Steam's own default, so only "cover" needs a patch.
    */
    const heroApplied = applyHomeHeroCentering(Boolean(centerHomeHero));
    applied = squareApplied && homeApplied && heroApplied && classesReady();

    /*
      One record that says exactly what the layout ended up as.

      Every layout bug so far - the forgotten cover format, the Home with the giant
      capsules, the portrait rows with square capsules - was invisible in the log and had
      to be diagnosed from a screenshot. This line makes the state readable.
    */
    log('layout applied', {
      settings: { libraryCoverFormat, homeRecentFormat, centerHomeHero: Boolean(centerHomeHero) },
      squareLibrary: squareApplied,
      home: homeApplied,
      heroCentering: heroApplied,
      classesReady: classesReady(),
      retries,
      homeDetail: homeDiagnostics,
    });

  } catch (error) {
    log('layout patches failed, will retry', error);
  } finally {
    if (retryTimer) {
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (applied) {
      retries = 0;
    } else if (retries < MAX_RETRIES) {
      retries += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        void refreshLayoutPatches(true);
      }, 2000);
    } else {
      log('layout patches gave up: Steam never became ready');
    }
  }
};

export const stopLayoutPatches = () => {
  cachedBootstrapPending = false;
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  removeHomePatch(true);
  // The plugin is going away: Steam gets its own grid-height getter back here, and only here.
  removeSquareLibraryPatch(true, true);
  applyHomeHeroCentering(false);
};
