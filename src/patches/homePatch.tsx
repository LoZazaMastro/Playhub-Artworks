import { RoutePatch, routerHook } from '@decky/api';

import { libraryAssetImageClasses, appportraitClasses, homeCarouselClasses, sel } from '../static-classes';
import { removeStyle, updateStyle } from '../utils/styleInjector';
import log from '../utils/log';
import { steamPath } from '../utils/steamRoute';

import { addCarouselWidthPatch, removeCarouselWidthPatch, setCarouselWidthSquare } from './carouselWidthPatch';
import { rerenderAfterPatchUpdate } from './patchUtils';

let patch: RoutePatch | undefined;

/* Square geometry uses the native carousel methods, not React element.type.
 * Route callbacks must never turn memo/forwardRef objects into callable functions.
 */

const HOME_FIT_STYLE_ID = 'playhub-artworks-home-fit';
const HOME_SQUARE_STYLE_ID = 'sgdb-square-capsules-home';

/*
  The Home is scoped by route when Steam's class is missing.

  `appportraitClasses.InRecentGames` is looked up in Steam's webpack modules, and on some
  builds it simply is not there. The consequence was the worst possible one: the CSS that
  turns the capsule into a square silently produced an EMPTY selector, while the carousel
  patch went on forcing the square COLUMN WIDTH - so every portrait cover was drawn at
  square width, kept its 2:3 shape, and grew off the bottom of the screen.

  Two defences now. First, this fallback: on the Home route the capsule rule can be scoped
  to the route itself instead of to Steam's class. Second, and more important, the square
  column width is only ever applied when the matching CSS is actually in place - see
  `squareCells` below.
*/
let onHomeRoute = steamPath().includes('/library/home');
/* Re-run when the user (or the test) walks back into the Home. */
let attachCarousel: (() => void) | undefined;

export const attachHomeCarousel = () => attachCarousel?.();
let routeScoped = false;

/** True when the styles are scoped to the Home ROUTE because Steam's class was missing. */
export const homeUsesRouteScope = () => routeScoped;

/*
  What the last application actually did, for the log.

  The enormous portrait covers on the Home came from a HALF applied square layout - the
  column width was squared while the CSS that squares the capsule never landed, because
  Steam's recents class could not be found. Nothing in the log said so, so it took a
  screenshot to notice. It says so now.
*/
export let homeDiagnostics: Record<string, unknown> = { applied: false };

/** @returns true when the Home route was entered or left, so the caller can re-apply. */
export const updateHomeRoute = (): boolean => {
  const active = steamPath().includes('/library/home');
  if (active === onHomeRoute) return false;
  onHomeRoute = active;
  return true;
};

/**
 * Cover-shaped recents letterbox with black bands; heroes must be left alone.
 *
 * Steam draws heroes its own way on the Home and on the game page, and every rule ever
 * added here made the two disagree. So this only ever runs for cover-shaped recents.
 */
const applyHomeFitStyle = (coverShaped: boolean, recentsScope: string) => {
  const container = sel(libraryAssetImageClasses, 'Container');
  const portrait = sel(libraryAssetImageClasses, 'PortraitImage');
  const recents = recentsScope || (onHomeRoute ? '' : null);
  if (!coverShaped || !container || !portrait || recents === null) {
    removeStyle(HOME_FIT_STYLE_ID);
    return;
  }
  const prefix = recents ? `${recents} ` : '';

  /*
    Scoped to PORTRAIT capsules only.

    Without `${portrait}` this matched every image inside the recents row - the featured
    hero included - so the plugin was still deciding how the Home hero is drawn. The rule
    exists for cover-shaped capsules, which letterbox with black bands; the hero is
    Steam's business and is now unreachable from here.
  */
  updateStyle(HOME_FIT_STYLE_ID, `
    ${prefix}${container}${portrait} img,
    ${prefix}${container}${portrait} > img {
      object-fit: cover !important;
      object-position: center center !important;
      width: 100% !important;
      height: 100% !important;
    }
  `);
};

/*
  The carousel props object survives across renders, so it is the one place that still
  needs an explicit once-guard: patching it twice would rebuild the very chain the tree
  patcher exists to prevent.
*/
/*
  The registry lives on `window`, not in this module.

  Steam's JS context outlives the plugin bundle: Decky replaces the bundle on every deploy
  and on every restart, but Steam's carousel props object stays exactly where it is. With
  the list of applied patches held in module scope, a fresh bundle started with an EMPTY
  list and could neither see nor undo what the previous bundle had installed - so the old
  `fnGetColumnWidth` replacement kept running, with the old settings baked into its
  closure. That is where "the banner is gone and the portrait covers are ENORMOUS" came
  from: a dead bundle still forcing square column widths while the new one, reading a
  backend that was down, believed it had nothing to do.

  On `window` any bundle can find the previous one's patches and take them down first.
*/
type CarouselRegistry = { patches: Array<{ unpatch: () => void }>; props: WeakSet<object>; generation: number; lastProps?: any };
const REGISTRY_KEY = '__playhubArtworksHomeCarousel';

const registry = (): CarouselRegistry => {
  const host = window as any;
  if (!host[REGISTRY_KEY]) host[REGISTRY_KEY] = { patches: [], props: new WeakSet<object>(), generation: 0 };
  return host[REGISTRY_KEY] as CarouselRegistry;
};

const ORIGINAL_WIDTH_KEY = '__playhubOriginalColumnWidth';

/*
  Steam's own column width, put back.

  Turning square covers off used to leave the widened slot in place - the props object
  survives, and with no route patch registered nothing ever restored it - so portrait covers
  were drawn 232 wide in a 155 slot and ran past the bottom of the row. The original is
  stashed on the object, so it can be restored from anywhere, at any time.
*/
/*
  One patch, one switch.

  Restoring the original function when square covers are turned off looked right and did
  nothing: the row had already computed its widths, and nothing asked it to recompute, so
  portrait covers kept being drawn 232 wide in a 155 slot. The override is installed once
  and reads a flag instead - exactly how the library grid getter works. Flipping the setting
  flips the answer, and the next layout pass is correct whether or not anything re-renders.
*/
let squareColumns = false;

export const setSquareColumns = (value: boolean) => { squareColumns = value; };

const restoreColumnWidth = () => {
  const store = registry();
  const props = store.lastProps;
  if (!props?.[ORIGINAL_WIDTH_KEY]) return;
  try {
    props.fnGetColumnWidth = props[ORIGINAL_WIDTH_KEY];
    delete props.__playhubGeneration;
    log('home: column width restored');
  } catch (_) {
    // Steam dropped the object; nothing to restore.
  }
};

const releaseCarouselPatches = () => {
  const store = registry();
  const count = store.patches.length;
  store.patches.forEach((entry) => {
    try {
      entry.unpatch();
    } catch (_) {
      // Steam already dropped the object.
    }
  });
  store.patches = [];
  /*
    A generation number, not a set.

    The WeakSet said "already patched" forever: Steam keeps the same props object across
    settings changes, and handlers installed by earlier applications of this patch are still
    attached to Steam's component types, so they re-added the object to the fresh set before
    the current handler ever saw it. The result was that every change of setting reported
    "carousel already patched, skip" and nothing was ever applied again. A generation stamped
    ON the object cannot be confused: an older stamp means re-patch.
  */
  store.generation += 1;
  store.props = new WeakSet<object>();
  if (count) log('home carousel patches released', { count });
};

/*
  With portrait covers the plugin does nothing at all.

  Portrait is Steam's own layout and it is correct: 155x232 capsules in a 232 row, the
  banner Steam puts first, everything inside the screen. The only thing worth changing is
  the square format, so that is the only thing this touches - anything else was the plugin
  becoming a limitation instead of an addition.
*/
export const addHomePatch = (mounting = false, square = false): boolean => {
  if (!patch) releaseCarouselPatches();

  const container = sel(libraryAssetImageClasses, 'Container');
  const portrait = sel(libraryAssetImageClasses, 'PortraitImage');
  const inRecents = sel(appportraitClasses, 'InRecentGames');

  /*
    Without the capsule selector there is nothing to square, so the square layout is not
    applied at all - neither the CSS nor the column width. A half-applied square layout is
    what produced the enormous portrait covers running off the bottom of the Home.
  */
  const scope = inRecents || (onHomeRoute ? '' : null);
  const canSquare = Boolean(square && container && portrait && scope !== null);

  const applySquareStyle = () => {
    if (!canSquare) {
      removeStyle(HOME_SQUARE_STYLE_ID);
      return false;
    }
    const prefix = scope ? `${scope} ` : '';
    /*
      The slot is as wide as the row is tall, so the capsule simply fills it.

      The featured first item is excluded everywhere: that one is Steam's banner.
    */
    const media = sel(homeCarouselClasses, 'BasicGameCarouselItemMediaContainer');
    const featured = sel(homeCarouselClasses, 'Featured');
    const notFeatured = featured ? `:not(${featured})` : '';
    /*
      Only the ARTWORK child is squared, never the label.

      `BasicGameCarouselItemMediaContainer` has exactly two children (Steam's
      `chunk~2dcc5aaf7.js`): the unnamed wrapper holding the capsule and its glow, and
      `CarouselGameLabelWrapper` - the name and playtime that appear on hover. The rule
      used to say `> div`, so it squared the label too: its inline width, which Steam
      computes as "from this item's left edge to the end of the carousel", was replaced by
      `auto` and an `aspect-ratio: 1 / 1`, and the text ended up laid out on a box that had
      nothing to do with the cover above it. That is the misalignment being reported.

      `:first-child` targets the artwork wrapper; the `:not()` is there in case a future
      build adds another child before it.
    */
    const labelWrapper = sel(homeCarouselClasses, 'CarouselGameLabelWrapper');
    const notLabel = labelWrapper ? `:not(${labelWrapper})` : '';
    const slotRule = media
      ? `
      ${media}${notFeatured} {
        width: auto !important;
      }
      ${media}${notFeatured} > div:first-child${notLabel} {
        width: auto !important;
        aspect-ratio: 1 / 1;
      }
    `
      : '';

    return updateStyle(HOME_SQUARE_STYLE_ID, `
      ${slotRule}
      ${prefix}${container}${portrait} {
        padding-top: 100% !important;
        height: 0 !important;
      }
    `);
  };

  const squareCells = canSquare && applySquareStyle();

  routeScoped = canSquare && !inRecents;
  homeDiagnostics = {
    wantSquare: square,
    squareCells,
    routeScoped,
    onHomeRoute,
    classes: {
      container: Boolean(container),
      portrait: Boolean(portrait),
      inRecents: Boolean(inRecents),
      carouselLabelHeight: homeCarouselClasses?.LabelHeight ?? null,
    },
  };

  applyHomeFitStyle(squareCells, inRecents);

  const wasSquare = squareColumns;
  squareColumns = squareCells;
  if (squareCells) addCarouselWidthPatch(true);
  else setCarouselWidthSquare(false);

  if (!patch) {
    // Keep route bookkeeping but return the original tree untouched. Native
    // carousel methods already supply square widths; a second tree patch both
    // duplicated that work and could call a memo object as a function.
    patch = routerHook.addPatch('/library/home', (props) => props);
  } else {
    if (!mounting && wasSquare !== squareCells) rerenderAfterPatchUpdate();
    return square ? squareCells : true;
  }

  if (!mounting) rerenderAfterPatchUpdate();
  return square ? squareCells : true;
};

export function removeHomePatch(unmounting = false, keepCarouselPrototype = false): void {
  /*
    The carousel patches are undone here.

    They used to be left in place: every rebuild of the Home patch added another
    `replacePatch` layer on `fnGetColumnWidth`, and after a handful of rebuilds the
    carousel was computing widths through a stack of stale closures. That is what turned
    the Home into the mess with the giant featured hero.
  */
  releaseCarouselPatches();
  squareColumns = false;
  /*
    The shared-carousel patch is only switched OFF here, not uninstalled: it hands back
    Steam's own width the moment the switch is down, and keeping it in place means the next
    switch to square does not have to find the class again. It is removed for real when the
    plugin unmounts.
  */
  if (unmounting && !keepCarouselPrototype) removeCarouselWidthPatch();
  else setCarouselWidthSquare(false);
  restoreColumnWidth();
  removeStyle(HOME_SQUARE_STYLE_ID);
  removeStyle('sgdb-carousel-logo');
  removeStyle(HOME_FIT_STYLE_ID);
  if (patch) {
    removeStyle(HOME_SQUARE_STYLE_ID);
    routerHook.removePatch('/library/home', patch);
    patch = undefined;

    if (!unmounting) rerenderAfterPatchUpdate();
  }
}
