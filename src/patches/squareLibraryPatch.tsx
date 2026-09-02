import { routerHook } from '@decky/api';
import { findModuleExport, findSP } from '@decky/ui';

import { appportraitClasses, gamepadLibraryClasses, libraryAssetImageClasses, sel } from '../static-classes';
import { addStyle, removeStyle } from '../utils/styleInjector';
import { markWork } from '../utils/work';
import log from '../utils/log';
import { isSquareLibraryRoute, steamPath } from '../utils/steamRoute';

const STYLE_ID = 'sgdb-square-capsules-library';
const GAME_INFO_STYLE_ID = 'playhub-artworks-square-game-info';

/*
  Square library capsules, done at the only place that actually decides the cell shape.

  Steam's grid is a class component (webpack module 59298 in `chunk~2dcc5aaf7.js`) and its
  row height comes from one prototype getter:

      get fScaledChildHeight(){ return this.props.childHeight * this.props.scaleGridItems }

  `render()` feeds that value into `gridAutoRows`, and `ComputeLayout()` uses it for every
  row offset. Returning the WIDTH from that getter is therefore all it takes to make the
  cells square - the same trick Steam itself uses for the all-collections showcase
  (`"all-collections" == strCollectionId && (n.childHeight = n.childWidth)`).

  Why a prototype getter and not the React tree: reaching the grid's props means walking
  down `props.children.type` -> `ret1.type` -> `ret2.type`, and that chain belongs to
  TabMaster, which wraps it, caches its own memo, and unpatches it from a `useEffect` with
  no dependency array - so it re-runs on every render. Two owners of that chain is what
  killed the library on the first tab change. A prototype getter touches none of it: one
  configurable property, applied to every grid in the client at once (TabMaster's
  included), put back exactly as it was on unmount.

  The prototype is reached through the React fiber of Steam's own `.CSSGrid_Measure`
  marker rather than through webpack exports - those are defined non-configurable, so they
  cannot be patched at all.
*/

type GridPrototype = any;

const PATCH_MARKER = '__playhubArtworksGridHeightPatch';

let patchedPrototype: GridPrototype | null = null;
let lastDecision: boolean | undefined;
let squareEnabled = false;
let findTimer: number | undefined;

/*
  The patch state lives ON THE PROTOTYPE, not in this module.

  Steam's JS context outlives the plugin bundle: Decky reloads the plugin on every deploy
  and on every Decky restart, but the grid class stays exactly where it was. A module-level
  `patchedPrototype` is `null` in the fresh bundle, so each reload wrapped the getter
  AGAIN, over the previous wrapper, which closed over the previous bundle's dead state.

  After a few reloads `fScaledChildHeight` was a chain of getters - and that getter is read
  on every render, every layout pass and every scroll event of a grid holding thousands of
  capsules. That is where the library slowdown came from, and why stale layers kept
  producing portrait rows with square capsules in them.

  The marker below holds the ORIGINAL descriptor. Any bundle can find it, put the getter
  back exactly as Steam wrote it, and install a single fresh wrapper.
*/
const takeOverPrototype = (prototype: any): PropertyDescriptor | undefined => {
  const previous = prototype?.[PATCH_MARKER];
  if (previous?.original) {
    try {
      Object.defineProperty(prototype, 'fScaledChildHeight', previous.original);
    } catch (_) {
      // Leave whatever is there; the check below will refuse to stack on top of it.
    }
    try {
      delete prototype[PATCH_MARKER];
    } catch (_) {
      // Non-configurable marker: nothing else to undo.
    }
    return previous.original;
  }
  return undefined;
};

const fiberOf = (node: any): any => {
  if (!node) return null;
  const key = Object.keys(node).find((name) =>
    name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
  return key ? (node as any)[key] : null;
};

const isGridInstance = (candidate: any): boolean =>
  Boolean(candidate)
  && typeof candidate === 'object'
  && typeof candidate.props === 'object'
  && typeof candidate.props.childWidth === 'number'
  && typeof candidate.props.childHeight === 'number'
  && typeof candidate.ComputeLayout === 'function';

/**
 * The grid class, straight out of webpack - no DOM, no rendered library needed.
 *
 * This is what lets the setting be right the moment Steam opens: waiting for the
 * `.CSSGrid_Measure` marker meant the first library view was always laid out with
 * portrait cells, which then visibly snapped to square a moment later.
 */
const findGridClassFromModules = (): GridPrototype | null => {
  try {
    const found = findModuleExport((exported: any) => {
      const prototype = exported?.prototype;
      if (!prototype) return false;
      return typeof prototype.ComputeLayout === 'function'
        && Object.getOwnPropertyDescriptor(prototype, 'fScaledChildHeight')?.get !== undefined;
    });
    return found?.prototype ?? null;
  } catch (error) {
    log('square library: module lookup failed', error);
    return null;
  }
};

/*
  The class is remembered on `window`, because finding it is the slow part.

  Module lookup CANNOT find this class: webpack module 59298 exports only the wrapper
  function (`r.d(t,{i:()=>A})`), and the grid itself is a local class inside it. So the
  only way to reach the prototype is through a grid that is already mounted - which means
  the FIRST library view of a Steam session is laid out before the patch exists, and then
  snaps. Remembering the class the first time it is seen means that happens at most once
  per Steam run instead of on every visit and every settings change.
*/
const PROTOTYPE_KEY = '__playhubArtworksGridPrototype';

const rememberPrototype = (prototype: GridPrototype) => {
  try {
    (window as any)[PROTOTYPE_KEY] = prototype;
  } catch (_) {
    // Nothing to do; the DOM lookup still works.
  }
};

const rememberedPrototype = (): GridPrototype | null => {
  try {
    return (window as any)[PROTOTYPE_KEY] ?? null;
  } catch (_) {
    return null;
  }
};

/** Fallback: Steam renders a `.CSSGrid_Measure` marker as a sibling of the grid. */
const findGridPrototype = (): GridPrototype | null => {
  try {
    const doc = findSP()?.window?.document;
    const marker = doc?.querySelector('.CSSGrid_Measure');
    if (!marker) return null;

    const own = fiberOf(marker);
    let child = own?.return?.child ?? own;
    for (let step = 0; child && step < 12; step += 1) {
      if (isGridInstance(child.stateNode)) return Object.getPrototypeOf(child.stateNode);
      child = child.sibling;
    }
  } catch (error) {
    log('square library: grid lookup failed', error);
  }
  return null;
};

/*
  The route answer is cached, but never for longer than a frame or two.

  It used to be refreshed ONLY by the 500 ms route watcher, and that is what made the
  library open wrong every single time: Steam mounts the grid and runs `ComputeLayout()`
  immediately after the route changes, up to half a second before the watcher noticed - so
  the very first layout was computed with "not in the library" and produced PORTRAIT rows
  holding square capsules. Changing tab or hovering the active tab forced a recompute, by
  which time the flag had caught up, and everything snapped into place. That is exactly the
  bug being described.

  Reading `location.pathname` on every property read is not an option either: this getter
  runs thousands of times per scroll. So the answer is cached with a short expiry - one
  `performance.now()` comparison per read, and a real check at most every 150 ms.
*/
const ROUTE_TTL_MS = 150;
let libraryRouteActive = false;
let routeCheckedAt = -Infinity;

const readRoute = () => {
  const path = steamPath();
  const active = isSquareLibraryRoute(path);
  if (active !== libraryRouteActive) log('square library: route flag', { path, active });
  libraryRouteActive = active;
  routeCheckedAt = performance.now();
};

const routeIsLibrary = (): boolean => {
  if (performance.now() - routeCheckedAt > ROUTE_TTL_MS) readRoute();
  return libraryRouteActive;
};

export const updateSquareLibraryRoute = () => readRoute();

/*
  The flag is refreshed BY THE ROUTE ITSELF, not by a timer.

  The 150 ms expiry above is a safety net, not a mechanism: Steam mounts the library grid
  and runs `ComputeLayout()` in the same tick the route renders, so a flag that catches up
  even one frame later produces one portrait layout that then snaps to square - the
  "morphing" visible for well under a second when entering the library.

  A router patch on `/library` runs during that route's render, before its children mount,
  so the getter already knows where it is the first time the grid asks.
*/
let routePatch: any;
let routePatchSeen = false;

const watchLibraryRoute = () => {
  if (routePatch) return;
  try {
    routePatch = routerHook.addPatch('/library', (props: any) => {
      readRoute();
      if (!routePatchSeen) {
        routePatchSeen = true;
        log('square library: route patch attivo');
      }
      return props;
    });
  } catch (error) {
    log('square library: route patch failed', error);
  }
};

const unwatchLibraryRoute = () => {
  if (!routePatch) return;
  try {
    routerHook.removePatch('/library', routePatch);
  } catch (_) {
    // Decky already tore it down.
  }
  routePatch = undefined;
};

const patchPrototype = (prototype: GridPrototype): boolean => {
  if (patchedPrototype === prototype) return true;

  // Undo anything a previous bundle left behind before installing our own.
  takeOverPrototype(prototype);

  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'fScaledChildHeight');
  if (!descriptor?.get || !descriptor.configurable) {
    log('square library: grid height is not patchable on this Steam build');
    return false;
  }

  const original = descriptor.get;
  Object.defineProperty(prototype, 'fScaledChildHeight', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get(this: any) {
      /*
        This runs on every layout pass and every scroll event, so it stays as close to
        free as possible: one boolean, one cached route check, two property reads.
      */
      const portraitCell = this.props.childHeight > this.props.childWidth;
      if (squareEnabled && portraitCell) {
        const inLibrary = routeIsLibrary();
        /*
          One line per change of answer, not per read: this getter runs on every layout
          pass and every scroll frame. It is here because the shape that a grid computes
          the moment it mounts is decided by this branch, and the "morphing" bug is
          exactly this branch answering `false` for the first layout.
        */
        if (inLibrary !== lastDecision) {
          lastDecision = inLibrary;
          log('square library: decisione altezza', { quadrata: inLibrary, path: steamPath() });
        }
        if (inLibrary) return this.props.childWidth * this.props.scaleGridItems;
      }
      return original.call(this);
    },
  });

  try {
    Object.defineProperty(prototype, PATCH_MARKER, {
      value: { original: descriptor },
      configurable: true,
      enumerable: false,
      writable: true,
    });
  } catch (_) {
    // Without the marker a later reload cannot undo this, but nothing breaks now.
  }

  patchedPrototype = prototype;
  log('square library: grid height patched');
  return true;
};

const restorePrototype = () => {
  if (!patchedPrototype) return;
  takeOverPrototype(patchedPrototype);
  patchedPrototype = null;
};

const stopSearching = () => {
  if (findTimer) {
    window.clearTimeout(findTimer);
    findTimer = undefined;
  }
};

let markerObserver: MutationObserver | undefined;

const stopObserving = () => {
  markerObserver?.disconnect();
  markerObserver = undefined;
};

/**
 * Watches for Steam's `.CSSGrid_Measure` marker and patches the class the moment a grid
 * exists, instead of on the next two-second tick.
 */
const observeForGrid = () => {
  if (markerObserver) return;
  const view = findSP()?.window;
  const body = view?.document?.body;
  if (!body || typeof view.MutationObserver !== 'function') return;

  markerObserver = new view.MutationObserver(() => {
    if (!squareEnabled || patchedPrototype) {
      stopObserving();
      return;
    }
    if (!view.document.querySelector('.CSSGrid_Measure')) return;
    /*
      The marker renders one commit before the grid, so the instance is not there yet.
      Trying now AND on the next frame covers both commits.
    */
    if (!tryPatchNow()) view.requestAnimationFrame(() => tryPatchNow());
  });
  markerObserver.observe(body, { childList: true, subtree: true });
};

/** One attempt at finding and patching, with no retry scheduling of its own. */
const tryPatchNow = (): boolean => {
  if (!squareEnabled) return false;
  if (patchedPrototype) return true;
  const prototype = rememberedPrototype() ?? findGridPrototype();
  if (!prototype || !patchPrototype(prototype)) return false;
  rememberPrototype(prototype);
  stopSearching();
  stopObserving();
  remeasureGrids();
  applyCapsuleStyle();
  return true;
};

/**
 * The grid class only exists once the library has actually been rendered, which may be
 * long after the plugin mounts - so this keeps looking (one `querySelector` every two
 * seconds) until it finds it, and stops for good once it has.
 */
const searchForGrid = () => {
  stopSearching();
  if (!squareEnabled || patchedPrototype) return;

  const prototype = rememberedPrototype() ?? findGridClassFromModules() ?? findGridPrototype();
  if (prototype && patchPrototype(prototype)) {
    rememberPrototype(prototype);
    stopObserving();
    /*
      A grid that was already on screen keeps the layout it computed BEFORE the patch
      existed. Steam recomputes on resize, so one resize event is all it takes - it is what
      changing tab was doing by accident.
    */
    remeasureGrids();
    /*
      The capsule style goes on only once the CELL is square.

      Applying it earlier is what produced the second of tall rows holding square
      capsules every time the library opened: the CSS landed immediately while the grid
      was still laying out portrait cells.
    */
    applyCapsuleStyle();
    return;
  }

  /*
    Not found yet: that means no grid has ever been rendered in this Steam session.

    Waiting two seconds for the next attempt is what made the first library view morph -
    the grid mounted, laid itself out portrait, and only ~900 ms later did the retry find
    the class. Steam renders a `.CSSGrid_Measure` marker one commit BEFORE the grid itself
    (module 59298 renders the grid only once the marker has been measured), so watching the
    DOM for that marker gets the patch in within a frame instead of within a second.
  */
  observeForGrid();
  findTimer = window.setTimeout(searchForGrid, 2000);
};

/** Every grid component currently mounted, reached through Steam's own measure marker. */
const mountedGrids = (view: Window): any[] => {
  const found: any[] = [];
  try {
    view.document.querySelectorAll('.CSSGrid_Measure').forEach((marker) => {
      const own = fiberOf(marker);
      let child = own?.return?.child ?? own;
      for (let step = 0; child && step < 12; step += 1) {
        if (isGridInstance(child.stateNode)) {
          found.push(child.stateNode);
          break;
        }
        child = child.sibling;
      }
    });
  } catch (error) {
    log('square library: grid scan failed', error);
  }
  return found;
};

/**
 * Makes every mounted grid recompute its layout, for real.
 *
 * The first version dispatched a `resize` event and called it done - but Steam's grid
 * watches its own container with a ResizeObserver, not the window, so nothing recomputed
 * and the rows kept the geometry they had been given before the patch applied. That is why
 * the library came up wrong at every Big Picture start and only fixed itself when the
 * setting was toggled by hand: the toggle re-rendered the grid with new props, which is the
 * only thing that ever forced a recompute.
 *
 * `ComputeLayout()` is the method the grid itself calls; `forceUpdate()` paints the result.
 */
export const remeasureGrids = () => {
  try {
    if (!isSquareLibraryRoute()) return;
    const view = findSP()?.window;
    if (!view) return;
    /*
      This is the most expensive thing the plugin does: `ComputeLayout()` walks every cell
      of a grid that can hold thousands of capsules, and `forceUpdate()` repaints it. It is
      timed, so a stutter can be attributed to it instead of guessed at.
    */
    const started = performance.now();
    markWork('rimisurazione griglie');
    const grids = mountedGrids(view);
    grids.forEach((grid) => {
      try {
        grid.ComputeLayout?.();
        grid.forceUpdate?.();
      } catch (_) {
        // A grid unmounting mid-scan is not worth failing over.
      }
    });
    markWork('');
    const spent = Math.round(performance.now() - started);
    if (grids.length) log('square library: grids remeasured', { count: grids.length, ms: spent });
    if (spent > 24) log('square library: rimisurazione LENTA', { count: grids.length, ms: spent });
  } catch (error) {
    log('square library: remeasure failed', error);
  }
};

/** Makes the capsule fill the now-square cell. */
const applyCapsuleStyle = () => {
  const library = sel(gamepadLibraryClasses, 'GamepadLibrary');
  const game = sel(appportraitClasses, 'LibraryItemBox');
  const container = sel(libraryAssetImageClasses, 'Container');
  const portrait = sel(libraryAssetImageClasses, 'PortraitImage');
  if (!library || !game || !container || !portrait) return;

  addStyle(STYLE_ID, `
    ${library} ${game} ${container}${portrait} {
      padding-top: 100% !important;
      height: 0 !important;
    }
    ${library} ${game} ${container}${portrait} img {
      object-fit: cover !important;
      object-position: center center !important;
    }
  `);

  /*
    Steam reuses portrait capsule markup in the game's Info tab, both for the large cover
    and for every cover layered inside a collection tile. The surrounding collection tile
    is already square; only the image container still insists on 2:3 and spills outside it.
    The tab panel id has a generated prefix but a stable suffix across Steam builds.
  */
  addStyle(GAME_INFO_STYLE_ID, `
    [id$="GameInfo_Content"] ${container}${portrait} {
      padding-top: 100% !important;
      height: 0 !important;
    }
    [id$="GameInfo_Content"] ${container}${portrait} img {
      object-fit: cover !important;
      object-position: center center !important;
    }
  `);
};

/**
 * @returns true when the selectors resolved, so the caller can stop retrying.
 */
export const addSquareLibraryPatch = (mounting = false): boolean => {
  const library = sel(gamepadLibraryClasses, 'GamepadLibrary');
  const game = sel(appportraitClasses, 'LibraryItemBox');
  const container = sel(libraryAssetImageClasses, 'Container');
  const portrait = sel(libraryAssetImageClasses, 'PortraitImage');
  if (!library || !game || !container || !portrait) return false;

  squareEnabled = true;
  updateSquareLibraryRoute();
  watchLibraryRoute();
  if (patchedPrototype) {
    /*
      The getter is still installed from an earlier square session (it is only removed on
      unmount), so there is nothing to look for - the capsule style is what has to come
      back, and the grids have to recompute with the getter answering square again.
    */
    applyCapsuleStyle();
  } else {
    searchForGrid();
  }
  if (!mounting) remeasureGrids();

  return true;
};

/**
 * @param quiet skips the re-render, for callers that are about to render anyway.
 * @param unmounting true only when the plugin itself is going away - see below.
 */
export function removeSquareLibraryPatch(_quiet = false, unmounting = false): void {
  squareEnabled = false;
  stopSearching();
  stopObserving();
  unwatchLibraryRoute();
  /*
    Switching back to portrait does NOT uninstall the getter.

    The getter's first line is `if (squareEnabled ...)`, so an idle patch hands back
    Steam's own value and costs one boolean. Uninstalling it meant the class had to be
    found again on the next switch to square - through a mounted grid, which is only there
    once the library is already on screen. That is a second visible morph, paid every
    time the setting changes. Steam gets its own getter back on unmount.
  */
  if (unmounting) restorePrototype();
  removeStyle(STYLE_ID);
  removeStyle(GAME_INFO_STYLE_ID);
  remeasureGrids();
}
