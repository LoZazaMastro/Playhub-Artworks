import { findSP } from '@decky/ui';

import { appportraitClasses, gamepadLibraryClasses, homeCarouselClasses, libraryAssetImageClasses, sel } from '../static-classes';
import { restoreStyles, restoreStylesTo } from '../utils/styleInjector';
import { markWork } from '../utils/work';
import log from '../utils/log';
import { isCollectionsOverview, isHomeRoute, isSquareLibraryRoute, steamPath } from '../utils/steamRoute';

import { ensureCarouselWidthPatch } from './carouselWidthPatch';
import { attachHomeCarousel } from './homePatch';
import { applyCachedLayout, currentLayoutSettings, refreshLayoutPatches } from './layoutPatchController';
import { remeasureGrids } from './squareLibraryPatch';

/*
  The safety net for a cold start.

  Applying the layout is a race the plugin does not control: at a fresh Big Picture start
  Steam builds its UI, loads its class modules, renders the Home and mounts the library
  grid on its own schedule, and the plugin mounts somewhere in the middle of that. When a
  piece is not there yet the patch that needed it silently does nothing, and the result is
  the state reported after every restart - portrait covers, taller than they should be,
  until the setting is applied again BY HAND.

  So instead of trusting that the application worked, this reads back what the covers
  actually became and re-applies the setting when the shape does not match. It is the same
  thing the user was doing manually, done automatically and within a second.
*/

const TOLERANCE = 0.08;
const MIN_INTERVAL_MS = 2500;
const MAX_REPAIRS = 12;

let lastRepair = -Infinity;
let repairs = 0;
let timers: number[] = [];
let heartbeat: number | undefined;
let knownDocument: Document | null = null;
let knownView: Window | null = null;
let transitionTimer: number | undefined;
let popupRegistration: any;
let carouselObserver: MutationObserver | undefined;

type Verdict = 'ok' | 'wrong' | 'unknown';

const ratioOf = (node: Element): number => {
  const box = node.getBoundingClientRect();
  return box.height > 0 ? box.width / box.height : 0;
};

/**
 * The first few capsules of a row, ignoring anything that has not been laid out yet.
 *
 * The order of `slice` and `filter` is the whole point. The first version filtered FIRST -
 * `getBoundingClientRect()` on every match - and in the library that is one forced layout
 * per capsule across a grid that holds thousands of them, every single beat. That is a
 * stutter the plugin was causing while looking for stutters. Now at most four elements are
 * ever measured.
 */
const capsules = (view: Window, scope: string): Element[] => {
  const container = sel(libraryAssetImageClasses, 'Container');
  const portrait = sel(libraryAssetImageClasses, 'PortraitImage');
  if (!scope || !container || !portrait) return [];
  const found: Element[] = [];
  const nodes = view.document.querySelectorAll(`${scope} ${container}${portrait}`);
  for (let index = 0; index < nodes.length && found.length < 4; index += 1) {
    const node = nodes[index];
    if (node.getBoundingClientRect().height > 1) found.push(node);
  }
  return found;
};

/**
 * Reads the covers on screen and says whether they match the setting.
 *
 * `unknown` is not a failure: it means nothing is rendered to look at (the Home is not
 * open, the library was never visited), and a repair on `unknown` would fire forever.
 */
export const verifyLayout = (): { verdict: Verdict; detail: string } => {
  try {
    const view = findSP()?.window;
    if (!view) return { verdict: 'unknown', detail: 'nessuna finestra' };

    const path = steamPath();
    if (isCollectionsOverview(path)) {
      return { verdict: 'unknown', detail: 'panoramica collezioni gestita da Steam' };
    }

    const { square } = currentLayoutSettings();
    const wanted = square ? 1 : 2 / 3;
    const seen: string[] = [];
    let wrong = 0;
    let measured = 0;

    const rows: Array<[string, string]> = [];
    if (isHomeRoute(path)) rows.push(['home', sel(appportraitClasses, 'InRecentGames')]);
    if (isSquareLibraryRoute(path)) rows.push(['libreria', sel(gamepadLibraryClasses, 'GamepadLibrary')]);

    for (const [name, scope] of rows) {
      const nodes = capsules(view, scope);
      if (nodes.length === 0) continue;
      const box = nodes[0].getBoundingClientRect();
      const ratio = ratioOf(nodes[0]);
      measured += 1;
      const off = Math.abs(ratio - wanted) > TOLERANCE;
      if (off) wrong += 1;
      seen.push(`${name} ${Math.round(box.width)}x${Math.round(box.height)} r${ratio.toFixed(2)}${off ? ' NO' : ''}`);
    }

    if (measured === 0) return { verdict: 'unknown', detail: 'nessuna cover sullo schermo' };
    return {
      verdict: wrong > 0 ? 'wrong' : 'ok',
      detail: `${seen.join(' · ')} (attesa ${square ? 'quadrata' : 'verticale'})`,
    };
  } catch (error: any) {
    return { verdict: 'unknown', detail: String(error?.message ?? error) };
  }
};

/**
 * Checks, and puts the setting back on when what is on screen does not match it.
 *
 * @param reason what asked for the check, so the log can be read back.
 */
let logged = 0;

export const guardLayout = async (reason: string): Promise<Verdict> => {
  const { verdict, detail } = verifyLayout();
  /*
    The first few answers are written down even when nothing is wrong: a guard that never
    says anything is a guard nobody can tell is running.
  */
  if (verdict !== 'wrong' && logged < 4) {
    logged += 1;
    log('layout guard: verifica', { reason, esito: verdict, detail });
  }
  if (verdict === 'ok') repairs = 0;
  if (verdict !== 'wrong') return verdict;

  const now = performance.now();
  if (now - lastRepair < MIN_INTERVAL_MS) return verdict;
  if (repairs >= MAX_REPAIRS) {
    log('layout guard: troppe correzioni, mi fermo', { reason, detail });
    return verdict;
  }

  lastRepair = now;
  repairs += 1;
  log('layout guard: forma sbagliata, riapplico', { reason, detail, tentativo: repairs });
  await reapply();
  return verdict;
};

/** Re-runs the whole layout setup and reads the result back into the log. */
const reapply = async () => {
  try {
    markWork('riapplicazione layout');
    restoreStyles();
    await refreshLayoutPatches(true);
    attachHomeCarousel();
    remeasureGrids();
  } catch (error) {
    log('layout guard: riapplicazione fallita', error);
  } finally {
    markWork('');
  }

  window.setTimeout(() => {
    const after = verifyLayout();
    if (after.verdict === 'ok') repairs = 0;
    log('layout guard: dopo la correzione', { esito: after.verdict, detail: after.detail });
  }, 1200);
};

const later = (delay: number, reason: string) => {
  timers.push(window.setTimeout(() => { void guardLayout(reason); }, delay));
};

/**
 * The startup schedule.
 *
 * Steam can take several seconds to finish building the Home after a cold start, and the
 * library grid does not exist at all until it is opened - so the checks are spread out
 * instead of being done once at mount.
 */
export const startLayoutGuard = () => {
  stopLayoutGuard();
  logged = 0;
  /*
    Spread over two minutes, not one: a cold Big Picture start can still be settling long
    after the plugin has mounted, and a check that costs two `getBoundingClientRect` calls
    is worth repeating.
  */
  [400, 1200, 3000, 8000]
    .forEach((delay) => later(delay, `avvio +${delay}ms`));

  bindView(currentView());
  bindPopupCreation();
  if (heartbeat) window.clearInterval(heartbeat);
  heartbeat = window.setInterval(() => { void beat(); }, HEARTBEAT_MS);
};

const bindPopupCreation = () => {
  if (popupRegistration) return;
  try {
    const manager = (window as any).g_PopupManager;
    popupRegistration = manager?.AddPopupCreatedCallback?.((popup: any) => {
      const name = String(popup?.m_strName ?? '');
      const title = String(popup?.m_strTitle ?? '');
      if (!name.startsWith('SP BPM') && !title.includes('Big Picture')) return;
      const doc = popup?.m_popup?.document as Document | undefined;
      const restored = restoreStylesTo(doc);
      log('layout guard: stili inseriti alla creazione della finestra', { restored: restored.join(', ') });
    });
  } catch (error) {
    log('layout guard: registro finestre non disponibile', error);
  }
};

/*
  The beat that catches a rebuilt interface.

  Closing and reopening Big Picture leaves this javascript running while REPLACING the
  document it had written its styles into: the patches stay alive, the CSS does not, and
  the covers come back portrait at square width until the setting is applied again by
  hand. Neither the startup schedule nor the route checks see it, because the plugin never
  reloads and the route never changes - so something has to keep looking.

  Two `getBoundingClientRect` calls and one `getElementById` every eight seconds.
*/
const HEARTBEAT_MS = 20000;

const currentView = (): Window | null => {
  try {
    return findSP()?.window ?? null;
  } catch (_) {
    return null;
  }
};

const currentDocument = (): Document | null => {
  return currentView()?.document ?? null;
};

const watchCarouselMount = (view: Window | null) => {
  carouselObserver?.disconnect();
  carouselObserver = undefined;
  if (!view?.document?.documentElement || !currentLayoutSettings().square) return;

  const selector = sel(homeCarouselClasses, 'BasicGameCarousel');
  const Observer = (view as any).MutationObserver as typeof MutationObserver | undefined;
  if (!selector || !Observer) return;

  const installWhenReady = () => {
    if (!view.document.querySelector(selector) || !ensureCarouselWidthPatch()) return false;
    carouselObserver?.disconnect();
    carouselObserver = undefined;
    return true;
  };

  if (installWhenReady()) return;
  const observer = new Observer(() => { installWhenReady(); });
  carouselObserver = observer;
  observer.observe(view.document.documentElement, { childList: true, subtree: true });
};

/*
  A soft Big Picture exit announces the teardown before the replacement document exists.
  During that short gap we watch at frame speed, then put the remembered CSS and patches
  onto the new document before its first useful carousel has time to settle in portrait.
  There is no permanent fast poll: the normal ten-second heartbeat remains the fallback.
*/
const onViewLeaving = () => {
  if (transitionTimer) return;
  const started = performance.now();
  transitionTimer = window.setInterval(() => {
    const view = currentView();
    const doc = view?.document ?? null;
    if (view && doc?.head && doc !== knownDocument) {
      window.clearInterval(transitionTimer);
      transitionTimer = undefined;
      bindView(view);
      const restored = restoreStyles();
      log('layout guard: nuova interfaccia intercettata subito', { restored: restored.join(', ') });
      applyCachedLayout();
      attachHomeCarousel();
      remeasureGrids();
      const until = performance.now() + 2500;
      const findNewCarousel = () => {
        if (ensureCarouselWidthPatch()) return;
        if (performance.now() < until) window.requestAnimationFrame(findNewCarousel);
      };
      findNewCarousel();
      window.setTimeout(() => {
        void refreshLayoutPatches(true);
      }, 80);
      return;
    }
    if (performance.now() - started > 8000) {
      window.clearInterval(transitionTimer);
      transitionTimer = undefined;
    }
  }, 16);
};

const bindView = (view: Window | null) => {
  if (knownView && knownView !== view) {
    try {
      knownView.removeEventListener('pagehide', onViewLeaving);
      knownView.removeEventListener('unload', onViewLeaving);
    } catch (_) { /* The old document is already gone. */ }
  }
  knownView = view;
  knownDocument = view?.document ?? null;
  if (!view) return;
  view.addEventListener('pagehide', onViewLeaving);
  view.addEventListener('unload', onViewLeaving);
  watchCarouselMount(view);
};

const beat = async () => {
  /*
    The carousel class can only be found while a carousel is on screen, so the attempt is
    repeated here until it succeeds - one `querySelector`, and nothing once it is patched.
  */
  ensureCarouselWidthPatch();

  const doc = currentDocument();
  if (doc && knownDocument !== doc) {
    const rebuilt = knownDocument !== null;
    knownDocument = doc;
    if (rebuilt) {
      log('layout guard: interfaccia ricostruita, riapplico tutto');
      bindView(currentView());
      await reapply();
      return;
    }
  }

  const restored = restoreStyles();
  if (restored.length > 0) {
    log('layout guard: stili spariti, rimessi', { restored: restored.join(', ') });
    await reapply();
    return;
  }

  void guardLayout('battito');
};

/** Two checks after a page that shows covers has had time to draw. */
export const guardAfterRoute = (path: string) => {
  if (path.includes('/library/home')) watchCarouselMount(currentView());
  later(700, `rotta ${path}`);
};

export const stopLayoutGuard = () => {
  timers.forEach((timer) => window.clearTimeout(timer));
  timers = [];
  if (heartbeat) window.clearInterval(heartbeat);
  heartbeat = undefined;
  if (transitionTimer) window.clearInterval(transitionTimer);
  transitionTimer = undefined;
  carouselObserver?.disconnect();
  carouselObserver = undefined;
  try { popupRegistration?.Unregister?.(); } catch (_) { /* already removed */ }
  popupRegistration = undefined;
  if (knownView) {
    try {
      knownView.removeEventListener('pagehide', onViewLeaving);
      knownView.removeEventListener('unload', onViewLeaving);
    } catch (_) { /* Already gone. */ }
  }
  knownView = null;
  knownDocument = null;
};
