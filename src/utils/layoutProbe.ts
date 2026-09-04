import { findSP } from '@decky/ui';

import { appportraitClasses, gamepadLibraryClasses, libraryAssetImageClasses, sel } from '../static-classes';

import log from './log';

/*
  Measuring instead of guessing.

  Every layout bug in this plugin so far - the capsules that came out enormous, the library
  rows that stayed portrait until a tab change, the Home that "looked wrong" - was
  diagnosed from screenshots, one round trip per hypothesis. The browser already knows the
  answer: it knows how big each capsule ended up, and which CSS rule decided it.

  So this reads it back. It reports the real geometry of the capsules on screen and, when
  the shape is not what it should be, WHICH stylesheet won - a Steam rule, this plugin's
  own injected style, or a CSS Loader theme. Naming the file that set the height turns
  "guarda che schifo" into a fact.
*/

/*
  Flat strings, not objects.

  The logger serialises nested objects as "[object:Object]", so a measurement buried in an
  object is a measurement nobody can read.
*/
const rectOf = (node: Element, viewportHeight: number): string => {
  const box = node.getBoundingClientRect();
  const ratio = box.height > 0 ? box.width / box.height : 0;
  const overflow = Math.round(box.bottom - viewportHeight);
  return `${Math.round(box.width)}x${Math.round(box.height)} r${ratio.toFixed(2)}`
    + (overflow > 1 ? ` OLTRE IL BORDO di ${overflow}px` : '');
};

const ratioOf = (node: Element): number => {
  const box = node.getBoundingClientRect();
  return box.height > 0 ? box.width / box.height : 0;
};

/** Which stylesheet set a property on this element, by name. */
const ruleSources = (view: Window, node: Element, properties: string[]): string[] => {
  const found: string[] = [];
  const sheets = Array.from(view.document.styleSheets ?? []);
  for (const sheet of sheets) {
    let rules: CSSRuleList | undefined;
    try {
      rules = (sheet as CSSStyleSheet).cssRules;
    } catch (_) {
      continue; // cross-origin sheet
    }
    if (!rules) continue;
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index] as CSSStyleRule;
      if (!rule?.selectorText || !rule.style) continue;
      const touches = properties.some((property) => rule.style.getPropertyValue(property));
      if (!touches) continue;
      let matches = false;
      try {
        matches = node.matches(rule.selectorText);
      } catch (_) {
        continue; // selector Steam's engine cannot parse
      }
      if (!matches) continue;
      const owner = (sheet.ownerNode as HTMLElement | null);
      const name = owner?.id
        || owner?.getAttribute?.('data-name')
        || owner?.getAttribute?.('data-theme')
        || sheet.href?.split('/').pop()
        || 'steam';
      const declared = properties
        .map((property) => {
          const value = rule.style.getPropertyValue(property);
          return value ? `${property}: ${value}${rule.style.getPropertyPriority(property) ? ' !important' : ''}` : '';
        })
        .filter(Boolean)
        .join('; ');
      found.push(`${name} :: ${rule.selectorText} { ${declared} }`);
      if (found.length >= 12) return found;
    }
  }
  return found;
};

const sample = (view: Window, selector: string, label: string, expected: 'square' | 'portrait' | 'any') => {
  const nodes = Array.from(view.document.querySelectorAll(selector)).slice(0, 3);
  if (nodes.length === 0) return { label, selector, found: 0 };

  const viewportHeight = Math.round(view.innerHeight);
  const rects = nodes.map((node) => rectOf(node, viewportHeight));
  const ratio = ratioOf(nodes[0]);
  const shape = ratio >= 0.9 && ratio <= 1.1
    ? 'square'
    : ratio < 0.9 ? 'portrait' : 'landscape';
  const wrong = expected !== 'any' && shape !== expected;

  return {
    label,
    selector,
    found: nodes.length,
    rects,
    shape,
    expected,
    wrong,
    viewportHeight,
    // Only when the shape is wrong: which rules decided it, most expensive part.
    culprits: wrong
      ? ruleSources(view, nodes[0], ['height', 'padding-top', 'transform', 'width', 'max-height'])
      : undefined,
  };
};

let lastRun = 0;

/**
 * Reads back what the layout actually became and writes it to the log.
 *
 * @param reason what triggered the probe, so the log entries can be told apart.
 * @param expectSquare what the current settings SHOULD have produced.
 */
export const probeLayout = (reason: string, expectSquare: boolean) => {
  const now = performance.now();
  if (now - lastRun < 3000) return;
  lastRun = now;

  try {
    const view = findSP()?.window;
    if (!view) return;

    const container = sel(libraryAssetImageClasses, 'Container');
    const portrait = sel(libraryAssetImageClasses, 'PortraitImage');
    const recents = sel(appportraitClasses, 'InRecentGames');
    const library = sel(gamepadLibraryClasses, 'GamepadLibrary');
    if (!container || !portrait) return;

    const shape = expectSquare ? 'square' : 'portrait';
    const report: Record<string, unknown> = { reason, expect: shape, path: view.location?.pathname };

    if (recents) report.homeCapsule = sample(view, `${recents} ${container}${portrait}`, 'home recents capsule', shape);
    if (library) report.libraryCapsule = sample(view, `${library} ${container}${portrait}`, 'library capsule', shape);

    log('layout probe', report);
  } catch (error) {
    log('layout probe failed', error);
  }
};
