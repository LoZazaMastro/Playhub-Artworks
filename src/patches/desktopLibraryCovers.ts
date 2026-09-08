import { afterPatch } from '@decky/ui';
import { cloneElement, isValidElement } from 'react';
import { appportraitClasses, libraryAssetImageClasses, sel } from '../static-classes';
import { desktopLibraryDocument, desktopRecentGamesClasses, libraryGridScope, mountedDesktopRecentCarousels, mountedLibraryGrids } from './libraryGridScope';

const STYLE_ID = 'playhub-artworks-desktop-library';
const ATTRIBUTE = 'data-playhub-artworks-square';
const patches = new Map<any, { element: Element; restore: () => void }>();
const recentPatches = new Map<any, { element: Element; unpatch: () => void }>();
let timer: ReturnType<typeof setInterval> | undefined;
let documentInUse: Document | undefined;
let observer: MutationObserver | undefined;
let frame: number | undefined;
let enabled = false;

function squareRecentCarousel(rendered: any): any {
  if (!enabled || !isValidElement<any>(rendered)) return rendered;
  const list = rendered.props.children;
  if (!isValidElement<any>(list) || !Array.isArray(list.props.children)) return rendered;
  const cards = list.props.children;
  let changed = false;
  const children = cards.map((card: any) => {
    if (!isValidElement<any>(card) || !card.props.app || card.props.bFeatured !== false) return card;
    const width = Number(card.props.nWidth);
    const height = Number(card.props.nHeight);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= width) return card;
    // Keep Steam's row height and featured banner; only widen ordinary portrait slots.
    changed = true;
    return cloneElement(card, { nWidth: height });
  });
  if (!changed) return rendered;
  return cloneElement(rendered, {
    [ATTRIBUTE]: '',
  }, cloneElement(list, {}, children));
}

function restoreRecentCarousels() {
  recentPatches.forEach((patch, instance) => {
    patch.unpatch();
    if (patch.element.isConnected) instance.forceUpdate();
  });
  recentPatches.clear();
}

function scanRecentCarousels() {
  const mounted = mountedDesktopRecentCarousels();
  recentPatches.forEach((patch, instance) => {
    if (mounted.get(instance) !== patch.element) {
      patch.unpatch(); recentPatches.delete(instance);
      if (patch.element.isConnected) instance.forceUpdate();
    }
  });
  mounted.forEach((element, instance) => {
    if (recentPatches.has(instance)) return;
    const patch = afterPatch(instance, 'render', (_args: any[], result: any) => squareRecentCarousel(result));
    recentPatches.set(instance, { element, unpatch: () => patch.unpatch() });
    instance.forceUpdate();
  });
}

function remeasure(grid: any) {
  try { if (grid.m_elGrid?.current?.isConnected) { grid.ComputeLayout(); grid.forceUpdate(); } }
  catch { /* A grid may be unmounting. */ }
}

function scan() {
  if (!enabled) return;
  const doc = desktopLibraryDocument();
  if (doc !== documentInUse) {
    restoreRecentCarousels();
    observer?.disconnect();
    observer = undefined;
    patches.forEach((patch) => patch.restore());
    patches.clear();
    documentInUse?.getElementById(STYLE_ID)?.remove();
    documentInUse = doc;
  }
  if (!observer && doc?.body) {
    observer = new MutationObserver((records) => {
      // Image loads and ordinary card updates do not require a full grid scan.
      const recent = desktopRecentGamesClasses().RecentGames;
      const selector = `.CSSGrid_Measure${recent ? `,.${recent}` : ''}`;
      const hasMarker = (node: Node) => node.nodeType === 1 &&
        ((node as Element).matches(selector) || !!(node as Element).querySelector(selector));
      if (frame === undefined && records.some((r) => [...r.addedNodes, ...r.removedNodes].some(hasMarker))) {
        frame = window.requestAnimationFrame(() => { frame = undefined; safelyScan(); });
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true });
  }
  const game = sel(appportraitClasses, 'LibraryItemBox');
  const container = sel(libraryAssetImageClasses, 'Container');
  const portrait = sel(libraryAssetImageClasses, 'PortraitImage');
  if (!doc?.head || !game || !container || !portrait) return;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    const cover = `[${ATTRIBUTE}] ${game} ${container}${portrait}`;
    style.textContent = `${cover}{padding-top:100%!important;height:0!important}` +
      `${cover} img{object-fit:cover!important;object-position:center center!important}`;
    doc.head.append(style);
  }
  scanRecentCarousels();
  const grids = new Set(mountedLibraryGrids().filter((grid) => libraryGridScope(grid) === 'desktop'
    && grid.props.childHeight > grid.props.childWidth && grid.props.childWidth > 0));
  patches.forEach((patch, grid) => {
    if (!grids.has(grid) || patch.element !== grid.m_elGrid?.current) {
      patch.restore(); patches.delete(grid); remeasure(grid);
    }
  });
  for (const grid of grids) {
    if (patches.has(grid)) continue;
    const element = grid.m_elGrid?.current as Element | undefined;
    if (!element?.isConnected) continue;
    const own = Object.getOwnPropertyDescriptor(grid, 'fScaledChildHeight');
    if (own) continue;
    let prototype = Object.getPrototypeOf(grid);
    let original: PropertyDescriptor | undefined;
    while (prototype && !original) {
      original = Object.getOwnPropertyDescriptor(prototype, 'fScaledChildHeight');
      prototype = Object.getPrototypeOf(prototype);
    }
    if (!original?.get) continue;
    const getter = function(this: any) {
      if (enabled && libraryGridScope(this) === 'desktop' && this.props.childHeight > this.props.childWidth) {
        return this.props.childWidth * this.props.scaleGridItems;
      }
      return original!.get!.call(this);
    };
    Object.defineProperty(grid, 'fScaledChildHeight', { configurable: true, get: getter });
    element.setAttribute(ATTRIBUTE, '');
    patches.set(grid, { element, restore: () => {
      if (Object.getOwnPropertyDescriptor(grid, 'fScaledChildHeight')?.get === getter) delete grid.fScaledChildHeight;
      element.removeAttribute(ATTRIBUTE);
    } });
    remeasure(grid);
  }
}

function safelyScan() { try { scan(); } catch { /* Retry when Steam's document is ready. */ } }

export function setDesktopLibrarySquare(square: boolean) {
  if (!square) { stopDesktopLibraryCovers(); return; }
  enabled = true;
  safelyScan();
  if (!timer) timer = setInterval(safelyScan, 2000);
}

export function stopDesktopLibraryCovers() {
  enabled = false;
  restoreRecentCarousels();
  if (timer) clearInterval(timer);
  timer = undefined;
  observer?.disconnect(); observer = undefined;
  if (frame !== undefined) window.cancelAnimationFrame(frame);
  frame = undefined;
  patches.forEach((patch, grid) => { patch.restore(); remeasure(grid); });
  patches.clear();
  documentInUse?.getElementById(STYLE_ID)?.remove();
  documentInUse = undefined;
}
