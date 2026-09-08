import { call } from '@decky/api';
import { findSP } from '@decky/ui';

import { appportraitClasses, gamepadLibraryClasses, sel } from '../static-classes';
import log from '../utils/log';
import { isSquareLibraryRoute } from '../utils/steamRoute';

const SETTING_KEY = 'instant_library_scroll';
const CACHE_KEY = 'playhub_artworks_instant_library_scroll';
const REBIND_INTERVAL_MS = 2000;
const VIEWPORT_MARGIN_PX = 10;
const SETTLE_DURATION_MS = 350;

let enabled = false;
let boundDocument: Document | null = null;
let pendingFrame: number | undefined;
let pendingView: Window | null = null;
let rebindTimer: number | undefined;
let lastFocusedGame: HTMLElement | null = null;
let bottomAlignedGame: HTMLElement | null = null;
const extendedScrollers = new Map<HTMLElement, { value: string; priority: string }>();

const currentView = (): Window | null => {
  try {
    return findSP()?.window ?? null;
  } catch (_) {
    return null;
  }
};

const readCachedSetting = (): boolean | null => {
  try {
    const value = currentView()?.localStorage?.getItem(CACHE_KEY);
    return value === null || value === undefined ? null : value === 'true';
  } catch (_) {
    return null;
  }
};

const writeCachedSetting = (value: boolean) => {
  try {
    currentView()?.localStorage?.setItem(CACHE_KEY, String(value));
  } catch (_) {
    // The backend setting remains authoritative when Steam storage is unavailable.
  }
};

const gameFromFocus = (target: EventTarget | null): HTMLElement | null => {
  if (!enabled || !isSquareLibraryRoute()) return null;
  const element = target as HTMLElement | null;
  if (!element?.closest) return null;

  const librarySelector = sel(gamepadLibraryClasses, 'GamepadLibrary');
  const gameSelector = sel(appportraitClasses, 'LibraryItemBox');
  if (!librarySelector || !gameSelector) return null;

  const game = element.closest(gameSelector) as HTMLElement | null;
  return game?.closest(librarySelector) ? game : null;
};

const verticalScrollers = (element: HTMLElement): HTMLElement[] => {
  const found: HTMLElement[] = [];
  const view = element.ownerDocument.defaultView;
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflow = view?.getComputedStyle(parent).overflowY;
    if (parent.scrollHeight > parent.clientHeight + 1 && (
      overflow === 'auto' || overflow === 'scroll'
      || (overflow === 'hidden' && Object.prototype.hasOwnProperty.call(parent, 'scrollTo'))
      || parent === element.ownerDocument.scrollingElement
    )) found.push(parent);
  }
  return found;
};

const visibleBottomEdge = (
  scroller: HTMLElement,
  game: HTMLElement,
  scrollRect: DOMRect,
): number => {
  const doc = game.ownerDocument;
  const view = doc.defaultView;
  if (!view) return scrollRect.bottom - VIEWPORT_MARGIN_PX;

  const viewport = view.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width ?? view.innerWidth;
  const viewportHeight = viewport?.height ?? view.innerHeight;
  const viewportBottom = viewportTop + viewportHeight;
  let bottom = Math.min(scrollRect.bottom, viewportBottom) - VIEWPORT_MARGIN_PX;

  // Native Footer is authoritative: themes can change its positioning and width,
  // so it must not pass the generic overlay heuristics below.
  const nativeFooters = doc.querySelectorAll<HTMLElement>('#Footer, [class*="BasicFooter"]');
  let nativeFooterFound = false;
  nativeFooters.forEach((footer) => {
    const style = view.getComputedStyle(footer);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
    const rect = footer.getBoundingClientRect();
    if (rect.height <= 0 || rect.top < viewportTop + viewportHeight * 0.5 || rect.top >= viewportBottom) return;
    bottom = Math.min(bottom, rect.top - VIEWPORT_MARGIN_PX);
    nativeFooterFound = true;
  });
  if (nativeFooterFound) return bottom;

  // Steam publishes the measured footer height on BasicUiRoot, including when
  // the footer is rendered in an overlay unavailable to this document's hit test.
  const footerHeight = parseFloat(view.getComputedStyle(game)
    .getPropertyValue('--gamepadui-current-footer-height')) || 40;
  if (Number.isFinite(footerHeight) && footerHeight > 0 && footerHeight < viewportHeight * 0.3) {
    bottom = Math.min(bottom, viewportBottom - footerHeight - VIEWPORT_MARGIN_PX);
  }

  /*
    Steam's Basic UI footer overlays the library instead of reducing its scroll area's
    client height. Inspecting the rendered stack at the bottom edge keeps this working
    across stable/beta class-name changes and also respects custom footer themes.
  */
  const sampleY = Math.max(viewportTop + 1, bottom - 1);
  const scrollLeft = Math.max(viewportLeft, scrollRect.left);
  const scrollRight = Math.min(viewportLeft + viewportWidth, scrollRect.right);
  const sampleXs = [0.16, 0.5, 0.84].map((ratio) => (
    Math.max(viewportLeft + 1, Math.min(viewportLeft + viewportWidth - 2, scrollLeft + (scrollRight - scrollLeft) * ratio))
  ));
  const candidates = new Set<HTMLElement>();
  // Verified id in Steam's chunk~2dcc5aaf7.js; also works with pointer-events:none.
  const footer = doc.getElementById('Footer');
  if (footer) candidates.add(footer);
  for (const sampleX of sampleXs) {
    for (const hit of doc.elementsFromPoint(sampleX, sampleY)) {
      let element = hit as HTMLElement | null;
      for (let depth = 0; element && depth < 10; depth += 1, element = element.parentElement) {
        candidates.add(element);
      }
    }
  }

  const lowerContentTop = Math.max(scrollRect.top, viewportTop) + viewportHeight * 0.5;
  const visibleFloor = Math.min(scrollRect.bottom, viewportBottom);
  for (const element of candidates) {
    if (
      !element?.getBoundingClientRect
      || element === scroller
      || element === game
      || element.contains(game)
      || game.contains(element)
    ) continue;
    const rect = element.getBoundingClientRect();
    const overlapWidth = Math.max(0, Math.min(rect.right, scrollRight) - Math.max(rect.left, scrollLeft));
    const horizontalCoverage = overlapWidth / Math.max(1, scrollRight - scrollLeft);
    const bottomAnchored = rect.bottom >= visibleFloor - Math.max(8, viewportHeight * 0.03);
    const plausibleFooter = (
      rect.height >= 20
      && rect.height <= viewportHeight * 0.3
      && rect.top >= lowerContentTop
      && rect.top < visibleFloor
      && bottomAnchored
      && horizontalCoverage >= 0.45
    );
    if (!plausibleFooter) continue;

    const style = view.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const identity = `${String(element.id ?? '')} ${String(element.className ?? '')}`;
    const anchored = style.position === 'fixed' || style.position === 'sticky' || style.position === 'absolute';
    const footerLike = /footer|bottom.*bar|action.*bar/i.test(identity);
    if ((anchored || footerLike) && plausibleFooter) {
      bottom = Math.min(bottom, rect.top - VIEWPORT_MARGIN_PX);
    }
  }
  return bottom;
};

const settleFocusedGame = (game: HTMLElement) => {
  const view = game.ownerDocument.defaultView;
  if (!enabled || !view || !game.isConnected || gameFromFocus(game) !== game
    || lastFocusedGame !== game || gameFromFocus(game.ownerDocument.activeElement) !== game) return;

  try {
    /*
      Steam wraps each scroll container with its own 200 ms animator. Calling the
      container's installed `scrollTo` with `auto` cancels that animator. Only `top` is
      recalculated here: horizontal library navigation keeps Steam's original behavior.
    */
    verticalScrollers(game).forEach((scroller) => {
      const gameRect = game.getBoundingClientRect();
      const scrollRect = scroller.getBoundingClientRect();
      const style = view.getComputedStyle(scroller);
      const scaleY = scroller.offsetHeight > 0 ? scrollRect.height / scroller.offsetHeight : 1;
      if (!Number.isFinite(scaleY) || scaleY <= 0) return;
      const topEdge = scrollRect.top + (parseFloat(style.scrollPaddingTop) || 0) * scaleY;
      // Keep one cover-height of breathing room above the footer. Use an
      // absolute viewport edge, not an accumulated row step or native padding.
      const bottomEdge = Math.max(topEdge + gameRect.height,
        visibleBottomEdge(scroller, game, scrollRect) - gameRect.height);
      let top = scroller.scrollTop;
      if (gameRect.top < topEdge) top += (gameRect.top - topEdge) / scaleY;
      else if (gameRect.bottom > bottomEdge || bottomAlignedGame === game) {
        bottomAlignedGame = game;
        top += (gameRect.bottom - bottomEdge) / scaleY;
      }

      // The last row needs actual scroll range, not just scroll-padding.
      const missingRange = top - (scroller.scrollHeight - scroller.clientHeight);
      if (missingRange > 0.5) {
        if (!extendedScrollers.has(scroller)) extendedScrollers.set(scroller, {
          value: scroller.style.getPropertyValue('padding-bottom'),
          priority: scroller.style.getPropertyPriority('padding-bottom'),
        });
        scroller.style.setProperty('padding-bottom', `${(parseFloat(style.paddingBottom) || 0) + Math.ceil(missingRange)}px`, 'important');
      }

      if (Math.abs(top - scroller.scrollTop) < 0.5) return;
      scroller.scrollTo({
        top,
        left: scroller.scrollLeft,
        behavior: 'auto',
      });
    });
  } catch (error) {
    log('instant library scroll failed', error);
  }
};

const onFocusIn = (event: FocusEvent) => {
  if (pendingFrame !== undefined) pendingView?.cancelAnimationFrame(pendingFrame);
  pendingFrame = undefined;
  pendingView = null;
  const game = gameFromFocus(event.target);
  if (game !== lastFocusedGame) bottomAlignedGame = null;
  lastFocusedGame = game;
  if (!game) return;
  const view = game.ownerDocument.defaultView;
  if (!view) return;

  // Run after focus handlers and through Steam's 200 ms scroll/focus animation.
  // First focus and same-row focus can also start below the overlay.
  const deadline = view.performance.now() + SETTLE_DURATION_MS;
  pendingView = view;
  const settle = () => {
    pendingFrame = undefined;
    if (lastFocusedGame !== game || gameFromFocus(game.ownerDocument.activeElement) !== game) {
      pendingView = null;
      return;
    }
    settleFocusedGame(game);
    if (view.performance.now() < deadline) pendingFrame = view.requestAnimationFrame(settle);
    else pendingView = null;
  };
  pendingFrame = view.requestAnimationFrame(settle);
};

// Native scrolling can finish after the focus animation, particularly in themed
// libraries. Recheck its final position without polling an idle library.
const onLibraryScroll = (event: Event) => {
  if (pendingFrame !== undefined) return;
  const doc = boundDocument;
  const game = gameFromFocus(doc?.activeElement ?? null);
  const scroller = event.target as HTMLElement | null;
  if (!game || !scroller?.contains?.(game)) return;
  onFocusIn({ target: game } as unknown as FocusEvent);
};

const unbindDocument = () => {
  if (pendingFrame !== undefined) pendingView?.cancelAnimationFrame(pendingFrame);
  pendingFrame = undefined;
  pendingView = null;
  for (const [scroller, original] of extendedScrollers) {
    if (original.value) scroller.style.setProperty('padding-bottom', original.value, original.priority);
    else scroller.style.removeProperty('padding-bottom');
  }
  extendedScrollers.clear();
  boundDocument?.removeEventListener('focusin', onFocusIn, true);
  boundDocument?.removeEventListener('scroll', onLibraryScroll, true);
  boundDocument = null;
  lastFocusedGame = null;
  bottomAlignedGame = null;
};

const bindCurrentDocument = () => {
  const doc = currentView()?.document ?? null;
  if (doc === boundDocument) return;
  unbindDocument();
  if (!enabled || !doc) return;
  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('scroll', onLibraryScroll, true);
  boundDocument = doc;
};

const start = () => {
  bindCurrentDocument();
  if (rebindTimer !== undefined) window.clearInterval(rebindTimer);
  rebindTimer = window.setInterval(bindCurrentDocument, REBIND_INTERVAL_MS);
};

export const setInstantLibraryScroll = (value: boolean) => {
  enabled = value;
  writeCachedSetting(value);
  if (value) {
    start();
    return;
  }
  stopInstantLibraryScroll();
};

export const applyCachedInstantLibraryScroll = (): boolean => {
  const cached = readCachedSetting();
  if (cached === null) return false;
  setInstantLibraryScroll(cached);
  return true;
};

export const refreshInstantLibraryScroll = async () => {
  let stored = false;
  try {
    stored = Boolean(await call<[string, boolean], boolean>('get_setting', SETTING_KEY, false));
  } catch (error) {
    log('instant library scroll setting unavailable', error);
    const cached = readCachedSetting();
    if (cached !== null) stored = cached;
  }
  setInstantLibraryScroll(stored);
};

export const stopInstantLibraryScroll = () => {
  enabled = false;
  unbindDocument();
  if (pendingFrame !== undefined) {
    pendingView?.cancelAnimationFrame(pendingFrame);
    pendingFrame = undefined;
  }
  pendingView = null;
  if (rebindTimer !== undefined) {
    window.clearInterval(rebindTimer);
    rebindTimer = undefined;
  }
};
