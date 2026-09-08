import { findModule, findSP } from '@decky/ui';
import { collectionGridClasses, showcaseGridClasses } from '../static-classes';
import { isSquareLibraryRoute } from '../utils/steamRoute';

export function desktopLibraryDocument(): Document | undefined {
  try {
    return (window as any).SteamUIStore?.WindowStore?.SteamUIWindows
      ?.find((entry: any) => entry.IsMainDesktopWindow?.())?.BrowserWindow?.document;
  } catch { return undefined; }
}

let recentClasses: Record<string, string> | undefined;
export function desktopRecentGamesClasses(): Record<string, string> {
  if (!recentClasses) {
    try {
      recentClasses = findModule((value: any) => typeof value?.RecentGames === 'string'
        && typeof value?.RecentGameMediaContainer === 'string'
        && typeof value?.CarouselExtraHeight === 'string') as Record<string, string> | undefined;
    } catch { /* Retry after Steam loads the desktop library. */ }
  }
  return recentClasses ?? {};
}

export function mountedDesktopRecentCarousels(): Map<any, Element> {
  const result = new Map<any, Element>();
  const doc = desktopLibraryDocument();
  const className = desktopRecentGamesClasses().RecentGames;
  if (!doc || !className) return result;
  // Desktop's recent-games shelf uses BoxCarousel (26271), not CSSGrid (59298).
  for (const root of doc.querySelectorAll(`.${className}`)) {
    const key = Object.keys(root).find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
    let fiber = key ? (root as any)[key] : undefined;
    for (let depth = 0; fiber && depth < 6; depth++, fiber = fiber.return) {
      const instance = fiber.stateNode;
      if (typeof instance?.render === 'function' && typeof instance?.UpdateScrollArrows === 'function'
        && instance.m_elScrollingDiv?.ownerDocument === doc
        && String(instance.props?.className ?? '').split(/\s+/).includes(className)) {
        result.set(instance, root);
        break;
      }
    }
  }
  return result;
}

type Surface = 'desktop' | 'gamepad';
const scopes = new WeakMap<object, { className: string; doc: Document; surface: Surface }>();

export function libraryGridScope(grid: any, checkRoute = true): Surface | undefined {
  const props = grid?.props;
  const doc = grid?.m_elGrid?.current?.ownerDocument ?? props?.scrollElement?.ownerDocument;
  if (!doc) return undefined;
  const cached = scopes.get(grid);
  if (cached && cached.doc === doc && cached.className === props.gridClassName) {
    return cached.surface === 'gamepad' && checkRoute && !isSquareLibraryRoute() ? undefined : cached.surface;
  }
  const classes = typeof props?.gridClassName === 'string' ? props.gridClassName.split(/\s+/) : [];
  const collection = !!collectionGridClasses.YourCollection && classes.includes(collectionGridClasses.YourCollection);
  const showcase = !!showcaseGridClasses.ShowcaseGrid && classes.includes(showcaseGridClasses.ShowcaseGrid);
  if (!collection && !showcase) return undefined;
  if (doc === desktopLibraryDocument()) {
    scopes.set(grid, { className: props.gridClassName, doc, surface: 'desktop' });
    return 'desktop';
  }
  try {
    if (collection && doc === findSP()?.window?.document) {
      scopes.set(grid, { className: props.gridClassName, doc, surface: 'gamepad' });
      return !checkRoute || isSquareLibraryRoute() ? 'gamepad' : undefined;
    }
  } catch { /* Steam is rebuilding its window. */ }
  return undefined;
}

export function mountedLibraryGrids(): any[] {
  const documents = new Set<Document>();
  const desktop = desktopLibraryDocument();
  if (desktop) documents.add(desktop);
  try { const doc = findSP()?.window?.document; if (doc) documents.add(doc); } catch { /* Not ready. */ }
  const result = new Set<any>();
  for (const doc of documents) {
    for (const marker of doc.querySelectorAll('.CSSGrid_Measure')) {
      const key = Object.keys(marker).find((name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
      const fiber = key ? (marker as any)[key] : undefined;
      let child = fiber?.return?.child ?? fiber;
      for (let step = 0; child && step < 12; step++, child = child.sibling) {
        const grid = child.stateNode;
        if (typeof grid?.ComputeLayout === 'function' && typeof grid?.GetChildren === 'function'
          && libraryGridScope(grid)) result.add(grid);
      }
    }
  }
  return [...result];
}
