import { findSP } from '@decky/ui';

import { homeCarouselClasses, sel } from '../static-classes';
import log from '../utils/log';

/*
  Square slots for EVERY cover carousel, not just the recents row.

  The Home is not one carousel. "Gioca ad un titolo della tua libreria" in the Consigliati
  tab is the same component as the recents row - Steam builds it with
  `jsx(di, {name: "#LibraryHome_PlayNext", games, showFeaturedItem: false})` in
  `chunk~2dcc5aaf7.js` - and so are the other shelves. Squaring only the row the plugin had
  descended to left every other shelf with square ARTWORK inside PORTRAIT slots, which is
  why those covers looked crammed against each other.

  Rather than descend the React tree once per shelf - each descent a new chance to break
  focus or remount a subtree - this patches the one method every carousel goes through:

      GetCellColumnWidth(e) {
        let {fnGetColumnWidth: t} = this.props;
        let r = t(e.index) + this.props.nItemMarginX;
        return e.index == this.props.nNumItems - 1 ? r + this.state.nRightPadding : r;
      }

  It touches no React identity at all: no wrapper component, no new type, nothing to
  remount - the thing that caused the black flash when this was done by tree descent.

  WHICH carousels are affected is decided by shape, not by name. A slot whose width is two
  thirds of its item height is holding a portrait cover; that is the one to make square. The
  featured banner (2.14:1), the thin separator (10px) and every carousel of screenshots,
  news or friends fail that test and are handed Steam's own width untouched.
*/

const PATCH_MARKER = '__playhubArtworksCarouselWidthPatch';
const WIDTH_FN_MARKER = '__playhubArtworksColumnWidthSource';
const PORTRAIT_RATIO = 2 / 3;
const TOLERANCE = 6;

let patchedPrototype: any = null;
let squareColumns = false;

const labelHeight = (): number => {
  const raw = homeCarouselClasses?.LabelHeight;
  const value = parseInt(String(raw ?? '0'), 10);
  return Number.isFinite(value) ? value : 0;
};

const fiberOf = (node: any): any => {
  if (!node) return null;
  const key = Object.keys(node).find((name) =>
    name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
  return key ? (node as any)[key] : null;
};

/*
  The class is reached through a carousel that is on screen.

  Webpack module 78688 exports `Xd`, and `Xd` is a `forwardRef` WRAPPER
  (`r.d(t,{Xd:()=>f}); const f = s.forwardRef(...)`) - the class itself is a local called
  `y` inside it. So there is nothing to find among the exports, exactly like the library
  grid: the only way in is a mounted instance, found by walking up the React fiber of a
  rendered carousel.

  Once found it is remembered on `window`, so a plugin reload or a switch back to square
  covers does not have to wait for a carousel to be on screen again.
*/
const PROTOTYPE_KEY = '__playhubArtworksCarouselPrototype';

const remembered = (): any => {
  try {
    return (window as any)[PROTOTYPE_KEY] ?? null;
  } catch (_) {
    return null;
  }
};

const remember = (prototype: any) => {
  try {
    (window as any)[PROTOTYPE_KEY] = prototype;
  } catch (_) {
    // Not fatal: it is looked up again next time.
  }
};

const findCarouselPrototype = (): any => {
  const known = remembered();
  if (known) return known;
  try {
    const doc = findSP()?.window?.document;
    if (!doc) return null;
    const selectors = [
      sel(homeCarouselClasses, 'BasicGameCarousel'),
      sel(homeCarouselClasses, 'VirtualizedBoxCarousel'),
      sel(homeCarouselClasses, 'BasicGameCarouselItem'),
    ].filter(Boolean) as string[];

    for (const selector of selectors) {
      const node = doc.querySelector(selector);
      let fiber = fiberOf(node);
      for (let step = 0; fiber && step < 24; step += 1) {
        const instance = fiber.stateNode;
        if (instance && typeof instance.GetCellColumnWidth === 'function') {
          const prototype = Object.getPrototypeOf(instance);
          remember(prototype);
          return prototype;
        }
        fiber = fiber.return;
      }
    }
  } catch (error) {
    log('carousel width: ricerca classe fallita', error);
  }
  return null;
};

/** Undoes whatever an earlier bundle installed, so two layers can never stack. */
const takeOver = (prototype: any) => {
  const previous = prototype?.[PATCH_MARKER];
  if (previous?.original) {
    try {
      Object.defineProperty(prototype, 'GetCellColumnWidth', previous.original);
    } catch (_) {
      // Leave what is there; installing again would only stack another layer.
    }
    if (previous.scrollOriginal) {
      try {
        Object.defineProperty(prototype, 'SendScrollNotification', previous.scrollOriginal);
      } catch (_) {
        // A newer Steam build may have made the method immutable.
      }
    }
    try {
      delete prototype[PATCH_MARKER];
    } catch (_) {
      // Non-configurable marker; nothing else to undo.
    }
  }
};

/** The square-slot rule, shared by the prototype patch and the instance sweep. */
const squareWidth = (instance: any, width: number, cell: any): number => {
  if (!squareColumns) return width;
  try {
    const props = instance?.props ?? {};
    const margin = Number(props.nItemMarginX) || 0;
    const last = cell?.index === Number(props.nNumItems) - 1;
    const padding = last ? (Number(instance?.state?.nRightPadding) || 0) : 0;
    /* Steam's own additions come off, so the comparison is slot against cover. */
    const bare = width - margin - padding;
    const itemHeight = Number(props.nItemHeight) || 0;
    /*
      Two candidates: carousels that draw a name and playtime under the cover count that
      label inside `nItemHeight`, the ones that do not, do not.
    */
    const candidates = [itemHeight - labelHeight(), itemHeight];
    for (const height of candidates) {
      if (height > 40 && Math.abs(bare - height * PORTRAIT_RATIO) <= TOLERANCE) {
        return height + margin + padding;
      }
    }
  } catch (_) {
    // Anything unexpected: Steam's own width, unchanged.
  }
  return width;
};

/*
  Why this is an ACCESSOR patch and not an assignment.

  `GetCellColumnWidth` is decorated - `Cg([o.oI], y.prototype, "GetCellColumnWidth", null)`
  in `chunk~2dcc5aaf7.js` - so what sits on the prototype is a GETTER that mints the bound
  method for each instance and caches it ON the instance. Assigning to it throws
  `Cannot set property GetCellColumnWidth of #<y> which has only a getter`, which is
  exactly what the first attempt did.

  So the getter is replaced by one that asks the original for the bound method, wraps it,
  and caches the WRAPPED one on the instance the same way mobx would.
*/
const install = (prototype: any): boolean => {
  if (patchedPrototype === prototype) return true;
  takeOver(prototype);

  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'GetCellColumnWidth');
  const scrollDescriptor = Object.getOwnPropertyDescriptor(prototype, 'SendScrollNotification');
  if (!descriptor || !descriptor.configurable) {
    log('carousel width: metodo non modificabile su questa build di Steam');
    return false;
  }

  const define = (target: any, method: string, value: any) => {
    Object.defineProperty(target, method, {
      value,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  };

  Object.defineProperty(prototype, 'GetCellColumnWidth', {
    configurable: true,
    enumerable: Boolean(descriptor.enumerable),
    get(this: any) {
      const bound = descriptor.get ? descriptor.get.call(this) : descriptor.value;
      const wrapped = (cell: any) => squareWidth(this, bound.call(this, cell), cell);
      try {
        /* Cached on the instance, exactly as the original getter does. */
        define(this, 'GetCellColumnWidth', wrapped);
      } catch (_) {
        // Read-only instance: the getter still returns the wrapped function every time.
      }
      return wrapped;
    },
    set(this: any, value: any) {
      define(this, 'GetCellColumnWidth', value);
    },
  });

  if (scrollDescriptor?.configurable) {
    Object.defineProperty(prototype, 'SendScrollNotification', {
      configurable: true,
      enumerable: Boolean(scrollDescriptor.enumerable),
      get(this: any) {
        const bound = scrollDescriptor.get
          ? scrollDescriptor.get.call(this)
          : scrollDescriptor.value;
        const wrapped = (offset: number) => {
          const focusedNavigation = this.m_activeScrollTo !== null
            && this.m_activeScrollTo !== undefined;
          if (!squareColumns || focusedNavigation) bound.call(this, offset);
        };
        (wrapped as any).__playhubScrollWrapped = true;
        try {
          define(this, 'SendScrollNotification', wrapped);
        } catch (_) {
          // The prototype wrapper remains active when the instance is read-only.
        }
        return wrapped;
      },
      set(this: any, value: any) {
        define(this, 'SendScrollNotification', value);
      },
    });
  } else {
    log('carousel width: notifica scroll non modificabile su questa build di Steam');
  }

  try {
    Object.defineProperty(prototype, PATCH_MARKER, {
      value: { original: descriptor, scrollOriginal: scrollDescriptor },
      configurable: true,
      enumerable: false,
      writable: true,
    });
  } catch (_) {
    // Without the marker a later reload cannot undo this, but nothing breaks now.
  }

  patchedPrototype = prototype;
  log('carousel width: patch installata');
  patchMountedInstances();
  return true;
};

/**
 * Carousels that are ALREADY on screen keep the bound method they cached before the patch
 * existed, so the prototype getter is never asked again for them. Their own copy is
 * replaced here, once.
 */
const patchMountedInstances = () => {
  try {
    const doc = findSP()?.window?.document;
    if (!doc) return;
    const selector = sel(homeCarouselClasses, 'BasicGameCarousel');
    if (!selector) return;
    let touched = 0;
    let skipped = 0;
    doc.querySelectorAll(selector).forEach((node) => {
      let fiber = fiberOf(node);
      for (let step = 0; fiber && step < 24; step += 1) {
        const instance = fiber.stateNode;
        if (instance && typeof instance.GetCellColumnWidth === 'function') {
          const scroll = Object.getOwnPropertyDescriptor(instance, 'SendScrollNotification');
          if (scroll?.value && scroll.configurable && !(scroll.value as any).__playhubScrollWrapped) {
            const originalScroll = scroll.value;
            const wrappedScroll: any = (offset: number) => {
              const focusedNavigation = instance.m_activeScrollTo !== null
                && instance.m_activeScrollTo !== undefined;
              if (!squareColumns || focusedNavigation) originalScroll.call(instance, offset);
            };
            wrappedScroll.__playhubScrollWrapped = true;
            Object.defineProperty(instance, 'SendScrollNotification', {
              value: wrappedScroll,
              configurable: true,
              writable: true,
              enumerable: false,
            });
          }
          const own = Object.getOwnPropertyDescriptor(instance, 'GetCellColumnWidth');
          let changed = false;

          /*
            MobX caches GetCellColumnWidth as a non-configurable bound method before the
            carousel reaches the DOM. Its implementation still reads props.fnGetColumnWidth
            on every call, so an already-mounted row can be corrected without replacing the
            method or remounting React.
          */
          const props = instance.props;
          const currentWidth = props?.fnGetColumnWidth as any;
          if (typeof currentWidth === 'function' && !currentWidth[WIDTH_FN_MARKER]) {
            const source = currentWidth;
            const wrapped: any = (index: number, ...rest: any[]) => {
              const width = source.call(props, index, ...rest);
              if (!squareColumns) return width;
              const itemHeight = Number(instance.props?.nItemHeight) || 0;
              for (const height of [itemHeight - labelHeight(), itemHeight]) {
                if (height > 40 && Math.abs(width - height * PORTRAIT_RATIO) <= TOLERANCE) return height;
              }
              return width;
            };
            wrapped[WIDTH_FN_MARKER] = source;
            props.fnGetColumnWidth = wrapped;
            changed = true;
          }

          if (own?.value && !(own.value as any).__playhubWrapped) {
            const bound = own.value as any;
            const wrapped: any = (cell: any) => squareWidth(instance, bound.call(instance, cell), cell);
            wrapped.__playhubWrapped = true;
            if (own.configurable) {
              Object.defineProperty(instance, 'GetCellColumnWidth', {
                value: wrapped, configurable: true, writable: true, enumerable: false,
              });
              changed = true;
            } else if (!props?.fnGetColumnWidth) {
              skipped += 1;
            }
          }

          if (changed) {
            touched += 1;
            try {
              instance.m_refGrid?.recomputeGridSize?.({ columnIndex: 0, rowIndex: 0 });
            } catch (_) { /* unmounting */ }
          }
          break;
        }
        fiber = fiber.return;
      }
    });
    if (touched || skipped) {
      log('carousel width: caroselli già montati', { aggiornati: touched, daRimontare: skipped });
    }
  } catch (error) {
    log('carousel width: aggiornamento montati fallito', error);
  }
};

export const remeasureCarousels = (seen?: WeakSet<object>): number => {
  try {
    const doc = findSP()?.window?.document;
    const selector = sel(homeCarouselClasses, 'BasicGameCarousel');
    if (!doc || !selector) return 0;
    let refreshed = 0;
    doc.querySelectorAll(selector).forEach((node) => {
      let fiber = fiberOf(node);
      for (let step = 0; fiber && step < 24; step += 1) {
        const instance = fiber.stateNode;
        if (instance && typeof instance.GetCellColumnWidth === 'function') {
          if (seen?.has(instance)) break;
          seen?.add(instance);
          try { instance.m_refGrid?.recomputeGridSize?.(); } catch (_) { /* unmounting */ }
          try { instance.OnResize?.(); } catch (_) { /* unmounting */ }
          try { instance.forceUpdate?.(); } catch (_) { /* unmounting */ }
          refreshed += 1;
          break;
        }
        fiber = fiber.return;
      }
    });
    return refreshed;
  } catch (_) {
    return 0;
  }
};

/**
 * @param square whether covers are square right now.
 * @returns true when the patch is in place.
 */
export const addCarouselWidthPatch = (square: boolean): boolean => {
  squareColumns = square;
  if (patchedPrototype) {
    if (square) patchMountedInstances();
    return true;
  }
  const prototype = findCarouselPrototype();
  if (!prototype) return false;
  return install(prototype);
};

/**
 * One cheap attempt, for callers that run periodically.
 *
 * A carousel has to be on screen for the class to be reachable, so the first attempt can
 * easily happen before Steam has drawn the Home. This is a single `querySelector` when the
 * patch is still missing, and nothing at all once it is in place.
 */
export const ensureCarouselWidthPatch = (): boolean => {
  if (patchedPrototype) return true;
  if (!squareColumns) return false;
  const prototype = findCarouselPrototype();
  return prototype ? install(prototype) : false;
};

/**
 * Portrait covers switch the patch OFF rather than uninstalling it: the first line of the
 * patched method hands back Steam's value, and keeping it installed means the next switch
 * to square does not have to find the class again. Steam gets its method back on unmount.
 */
export const setCarouselWidthSquare = (square: boolean) => {
  squareColumns = square;
  if (patchedPrototype) patchMountedInstances();
};

export const removeCarouselWidthPatch = () => {
  squareColumns = false;
  if (!patchedPrototype) return;
  takeOver(patchedPrototype);
  patchedPrototype = null;
};
