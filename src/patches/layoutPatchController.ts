import { call } from '@decky/api';
import { findSteamUI } from '../utils/steamWindow';
import log from '../utils/log';
import { addHomePatch, homeDiagnostics, removeHomePatch } from './homePatch';
import { applyHomeHeroCentering } from './homeHeroPatch';
import { addSquareLibraryPatch, removeSquareLibraryPatch } from './squareLibraryPatch';
import { applyCachedHomeRecentCover } from './homeRecentCover';

export type LibraryCoverFormat = 'portrait' | 'square';
export type HomeRecentFormat = 'banner' | 'cover';
type CachedLayout = { square: boolean; recents: HomeRecentFormat; hero: boolean };
const CACHE_KEY = 'playhub_artworks_layout';
let retryTimer: number | undefined;
let lifecycle = 0;
let latestRequest = 0;
let retries = 0;
let lastSettings = { square: false, coverRecents: false };
let lastHeroSetting = false;
let knownSettings = false;
let lastReport = '';

export const currentLayoutSettings = () => lastSettings;
const readCachedLayout = (): CachedLayout | null => {
  try {
    const raw = findSteamUI()?.window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.square !== 'boolean') return null;
    return { square: parsed.square, recents: parsed.recents === 'cover' ? 'cover' : 'banner', hero: Boolean(parsed.hero) };
  } catch { return null; }
};
const remember = (value: CachedLayout) => {
  lastSettings = { square: value.square, coverRecents: value.recents === 'cover' };
  lastHeroSetting = value.hero;
  knownSettings = true;
};
const apply = (mounting: boolean): boolean => {
  const { square, coverRecents } = lastSettings;
  if (!square) removeSquareLibraryPatch(true);
  const library = square ? addSquareLibraryPatch(true) : true;
  // addHomePatch updates flags/styles in place; it does not remount the Steam subtree.
  const home = addHomePatch(mounting, square);
  const hero = applyHomeHeroCentering(lastHeroSetting);
  const ready = library && home && hero;
  const report = JSON.stringify({ square, coverRecents, hero: lastHeroSetting, library, home, ready });
  if (report !== lastReport) {
    lastReport = report;
    log(ready ? 'layout applied' : 'layout pending: waiting for Steam UI', {
      settings: { square, coverRecents, centerHomeHero: lastHeroSetting },
      squareLibrary: library, home, heroCentering: hero, homeDetail: homeDiagnostics,
    });
  }
  return ready;
};

export const applyCachedLayout = (): boolean => {
  applyCachedHomeRecentCover();
  const cached = readCachedLayout();
  if (!cached) return false;
  remember(cached);
  try { return apply(true); }
  catch (error) { log('cached layout pending', error); return false; }
};

export const refreshLayoutPatches = async (mounting = false): Promise<void> => {
  const generation = lifecycle;
  const request = ++latestRequest;
  let ready = false;
  let backendReady = false;
  try {
    // A failed RPC is NOT an explicit request to reset the user's settings.
    const [format, recents, hero] = await Promise.all([
      call<[string, string], LibraryCoverFormat>('get_setting', 'library_cover_format', 'portrait'),
      call<[string, string], HomeRecentFormat>('get_setting', 'home_recent_format', 'banner'),
      call<[string, boolean], boolean>('get_setting', 'home_hero_center', false),
    ]);
    if (generation !== lifecycle || request !== latestRequest) return;
    if (!['portrait', 'square'].includes(format) || !['banner', 'cover'].includes(recents) || typeof hero !== 'boolean') {
      throw new Error('Invalid layout settings response');
    }
    const value: CachedLayout = { square: format === 'square', recents, hero };
    remember(value);
    backendReady = true;
    try { findSteamUI()?.window.localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* Backend remains authoritative. */ }
    ready = apply(mounting);
  } catch (error) {
    if (generation !== lifecycle || request !== latestRequest) return;
    if (!knownSettings) {
      const cached = readCachedLayout();
      if (cached) remember(cached);
    }
    try { if (knownSettings) ready = apply(true); } catch { /* Retry when the document is ready. */ }
    if (retries === 0) log('layout refresh deferred; preserving last settings', error);
  } finally {
    if (generation === lifecycle && request === latestRequest) {
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
      if (ready && backendReady) retries = 0;
      else {
        retries += 1;
        // Slow retry after the first minute; login/Big Picture can open much later.
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          void refreshLayoutPatches(true);
        }, retries <= 30 ? 2000 : 15000);
      }
    }
  }
};

export const stopLayoutPatches = () => {
  lifecycle += 1;
  latestRequest += 1;
  if (retryTimer !== undefined) window.clearTimeout(retryTimer);
  retryTimer = undefined;
  try { removeHomePatch(true); } catch (error) { log('home cleanup failed', error); }
  try { removeSquareLibraryPatch(true, true); } catch (error) { log('library cleanup failed', error); }
  try { applyHomeHeroCentering(false); } catch (error) { log('hero cleanup failed', error); }
};
