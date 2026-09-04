import { findSP, GamepadButton, Router } from '@decky/ui';
import { call } from '@decky/api';

import {
  appportraitClasses, gamepadLibraryClasses, homeCarouselClasses, libraryAssetImageClasses, sel,
} from '../static-classes';
import { aspectModesForProvider, coverShapesForProvider, providerForId } from '../constants';
import { refreshLayoutPatches } from '../patches/layoutPatchController';

import { artworkSources, steamOwnArtworkSources } from './artworkSources';
import getAppOverview from './getAppOverview';
import { isPerfectArtwork } from './perfectArtwork';
import log from './log';

/*
  The plugin checks its own work.

  Until now every layout claim was verified by asking Andrea to open a page and send a
  screenshot: slow, and it made him the test harness for mistakes that are perfectly
  measurable. Steam's own DOM knows the answer - what shape the capsules ended up, how far
  apart the grid rows are, whether anything runs off the bottom of the screen - so the
  plugin goes and looks.

  It navigates the way a person would (`Router.Navigate`), waits for Steam to lay the page
  out, measures, and writes one PASS/FAIL line per check. It runs only when explicitly
  asked for, and it puts the user back where they were when it is done.
*/

const wait = (ms: number) => new Promise((resolve) => { window.setTimeout(resolve, ms); });

/**
 * Asks the backend for a picture of the screen, right now.
 *
 * A number tells you the capsule is 244x244; only the picture tells you the row is behind
 * the footer, or the editor is showing the wrong artwork.
 */
const shot = async (name: string) => {
  try {
    const path = await call<[string], string>('capture_screen', name);
    log('screenshot', { name, path: path || 'non riuscito' });
  } catch (error) {
    log('screenshot failed', { name, error });
  }
};

type Check = { name: string; pass: boolean; detail: string };

const capsules = (view: Window, scope: string): HTMLElement[] => {
  const container = sel(libraryAssetImageClasses, 'Container');
  const portrait = sel(libraryAssetImageClasses, 'PortraitImage');
  if (!container || !portrait || !scope) return [];
  return Array.from(view.document.querySelectorAll(`${scope} ${container}${portrait}`)) as HTMLElement[];
};

const shapeOf = (node: Element): { w: number; h: number; ratio: number } => {
  const box = node.getBoundingClientRect();
  return {
    w: Math.round(box.width),
    h: Math.round(box.height),
    ratio: box.height > 0 ? Number((box.width / box.height).toFixed(2)) : 0,
  };
};

/**
 * The vertical distance between one row of capsules and the next.
 *
 * This is the check that would have caught "square capsules sitting in portrait rows"
 * without a single screenshot: the capsule can be perfectly square while the row pitch is
 * still the tall one, which is exactly what the grid did when its layout had been computed
 * before the patch applied.
 */
const rowPitch = (nodes: HTMLElement[], capsuleHeight: number): number => {
  /*
    Capsules on the SAME row differ by a few pixels, so distinct `top` values are not
    distinct rows: the first version of this compared two capsules sitting side by side and
    reported a 6px "row pitch", a number that means nothing. Tops are grouped with half a
    capsule of tolerance, and the pitch is the gap between the first two real rows.
  */
  const tolerance = Math.max(8, capsuleHeight / 2);
  const tops = nodes.map((node) => node.getBoundingClientRect().top).sort((a, b) => a - b);
  const rows: number[] = [];
  tops.forEach((top) => {
    if (rows.length === 0 || top - rows[rows.length - 1] > tolerance) rows.push(top);
  });
  return rows.length >= 2 ? Math.round(rows[1] - rows[0]) : 0;
};

/**
 * The whole box chain of a recents item, from the capsule up.
 *
 * Steam sizes the row from `nItemWidth`/`nItemHeight`, capped at 175x262.5 in its own code,
 * and hands those down as inline styles. When the capsule on screen measures far more than
 * that, some box in between is the one growing - and only a walk up the chain says which.
 */
const boxChain = (view: Window, scope: string): Check => {
  const nodes = capsules(view, scope);
  if (nodes.length === 0) return { name: 'home: catena dei box', pass: true, detail: 'nessuna capsula' };

  /* Horizontal pitch: how far apart consecutive capsules sit, versus how wide they are. */
  const lefts = nodes.slice(0, 5).map((n) => Math.round(n.getBoundingClientRect().left)).sort((a, b) => a - b);
  const width = Math.round(nodes[0].getBoundingClientRect().width);
  const pitch = lefts.length >= 2 ? lefts[1] - lefts[0] : 0;

  const parts: string[] = [`passo orizzontale ${pitch}px su capsula ${width}px (spazio ${pitch - width}px)`];
  let node: HTMLElement | null = nodes[Math.min(2, nodes.length - 1)];
  for (let step = 0; node && step < 6; step += 1) {
    const box = node.getBoundingClientRect();
    const style = view.getComputedStyle(node);
    const name = String(node.className || node.tagName).split(' ').slice(0, 2).join('.').slice(0, 34);
    parts.push(`${name} ${Math.round(box.width)}x${Math.round(box.height)}`
      + (style.position !== 'static' ? ` pos=${style.position}` : '')
      + (style.marginRight !== '0px' ? ` mr=${style.marginRight}` : '')
      + (style.paddingTop !== '0px' ? ` pt=${style.paddingTop}` : ''));
    node = node.parentElement;
  }
  return { name: 'home: catena dei box', pass: true, detail: parts.join(' ← ') };
};

/**
 * Does the row redraw itself while nobody is touching it?
 *
 * The black flash every few seconds is React unmounting and remounting the subtree, and a
 * remount replaces the DOM nodes. Holding on to one capsule and looking again a few seconds
 * later says whether it survived - the same element means a stable tree, a different one
 * means the flash is back.
 */
const checkStability = async (view: Window, scope: string, label: string): Promise<Check> => {
  const before = capsules(view, scope)[0];
  if (!before) return { name: `${label}: stabilita`, pass: false, detail: 'nessuna capsula' };
  await wait(4000);
  const after = capsules(view, scope)[0];
  const same = before === after && before.isConnected;
  return {
    name: `${label}: nessun rimontaggio da fermo`,
    pass: same,
    detail: same ? 'la riga e rimasta la stessa per 4 secondi' : 'la riga si e rimontata: e il flash nero',
  };
};

/**
 * The name and playtime under a recents cover: are they as wide as the cover?
 *
 * Steam sizes that label from the item's own width, which is the portrait one. With a square
 * capsule the text ends up centred on a narrower box than the artwork above it - it reads as
 * misaligned even though nothing is broken.
 */
const checkLabelWidth = (view: Window, scope: string): Check => {
  const nodes = capsules(view, scope);
  const wrapper = sel(homeCarouselClasses, 'CarouselGameLabelWrapper');
  if (nodes.length === 0) return { name: 'home: etichetta allineata alla cover', pass: true, detail: 'nessuna capsula' };

  const cover = nodes[0].getBoundingClientRect();
  /*
    The label must be the one belonging to THIS capsule.

    Asking the document for the first label wrapper returns the banner's, which starts at
    the left edge of the carousel - a 500 px "drift" that says nothing. The label lives in
    the same carousel item as the capsule, so the item is the scope.
  */
  const item = sel(homeCarouselClasses, 'BasicGameCarouselItem');
  const owner = (item ? nodes[0].closest(item) : null) ?? nodes[0].parentElement;
  const found = wrapper ? (owner?.querySelector(wrapper) ?? null) : null;
  if (!found) {
    return {
      name: 'home: etichetta allineata alla cover',
      pass: true,
      detail: `etichetta non trovata (${wrapper || 'classe assente'})`,
    };
  }
  const label = found.getBoundingClientRect();
  /*
    Steam's label is deliberately WIDER than the cover - it runs from the item's left edge
    to the end of the carousel - so the width says nothing. What must line up is the LEFT
    edge, and that is what looked wrong when the square rule was also squaring the label.
  */
  const drift = Math.round(label.left - cover.left);
  return {
    name: 'home: etichetta allineata alla cover',
    pass: Math.abs(drift) <= 4,
    detail: `etichetta x${Math.round(label.left)} larga ${Math.round(label.width)} · cover x${Math.round(cover.left)} larga ${Math.round(cover.width)} · scarto ${drift}px`,
  };
};

/**
 * Does the library morph from portrait to square after it opens?
 *
 * A shape that settles a beat after the page appears is visible, and it means the layout was
 * computed once before the patch answered. Three samples say whether it happens and when.
 */
const checkMorph = async (view: Window, scope: string, wantSquare: boolean): Promise<Check> => {
  const samples: string[] = [];
  const ratios: number[] = [];
  let elapsed = 0;
  for (const at of [150, 400, 900, 1500, 2500]) {
    // eslint-disable-next-line no-await-in-loop
    await wait(at - elapsed);
    elapsed = at;
    const nodes = capsules(view, scope);
    const box = nodes[0]?.getBoundingClientRect();
    if (!box || box.height === 0) {
      samples.push(`${at}ms nessuna`);
      continue;
    }
    ratios.push(box.width / box.height);
    samples.push(`${at}ms ${Math.round(box.width)}x${Math.round(box.height)}`);
  }

  /*
    The SHAPE is what must never change, not the number of pixels.

    A focused capsule is scaled up by Steam's own hover animation, so 172x172 and 181x181
    are the same layout half a beat apart. What the user reported is a capsule that is
    PORTRAIT when the page opens and square a moment later - a change of ratio, and that is
    what this compares.
  */
  const wanted = wantSquare ? 1 : 2 / 3;
  const offShape = ratios.filter((ratio) => Math.abs(ratio - wanted) > 0.06);
  return {
    name: 'libreria: nessun morphing all\'apertura',
    pass: ratios.length > 0 && offShape.length === 0,
    detail: `${samples.join(' → ')}${offShape.length ? ` (${offShape.length} campioni fuori forma, attesa ${wantSquare ? 'quadrata' : 'verticale'})` : ''}`,
  };
};

const checkCapsules = (view: Window, scope: string, label: string, wantSquare: boolean): Check[] => {
  const nodes = capsules(view, scope);
  if (nodes.length === 0) {
    return [{ name: `${label}: presenti`, pass: false, detail: 'nessuna capsula trovata' }];
  }

  const first = shapeOf(nodes[0]);
  const square = first.ratio >= 0.95 && first.ratio <= 1.05;
  const checks: Check[] = [{
    name: `${label}: forma`,
    pass: wantSquare ? square : !square,
    detail: `${first.w}x${first.h} r${first.ratio} (attesa ${wantSquare ? 'quadrata' : 'verticale'})`,
  }];

  /*
    Only the FIRST row is asked to fit on screen.

    The library scrolls, so of course capsules further down are past the bottom edge -
    measuring all of them reported "sfora di 720px" on a perfectly healthy grid. What must
    never happen is the first row itself running off the screen, which is the shape of the
    "cover giganti tagliate" bug.
  */
  const firstTop = Math.min(...nodes.map((node) => node.getBoundingClientRect().top));
  const firstRow = nodes.filter((node) => node.getBoundingClientRect().top - firstTop < Math.max(8, first.h / 2));
  const bottom = Math.max(...firstRow.map((node) => node.getBoundingClientRect().bottom));
  const overflow = Math.round(bottom - view.innerHeight);
  checks.push({
    name: `${label}: prima riga dentro lo schermo`,
    pass: overflow <= 2,
    detail: overflow > 2 ? `sfora di ${overflow}px` : `ok (${firstRow.length} capsule in riga)`,
  });

  const pitch = rowPitch(nodes, first.h);
  if (pitch > 0) {
    // The row must be about as tall as the capsule; a taller pitch is the stale-layout bug.
    const slack = pitch - first.h;
    checks.push({
      name: `${label}: passo delle righe`,
      pass: slack <= Math.max(40, first.h * 0.25),
      detail: `passo riga ${pitch}px, capsula ${first.h}px, spazio morto ${slack}px`,
    });
  }

  return checks;
};

/*
  The sources that only ever have square covers.

  Offering "Solo verticali" on them is a button whose only outcome is an empty grid, and it
  has been reported as broken more than once - so it is asserted, not remembered.
*/
const checkSquareOnlyProviders = (): Check[] =>
  ['playstation', 'nintendo', 'ign'].map((id) => {
    const config = providerForId(id);
    const shapes = coverShapesForProvider(config);
    const options = aspectModesForProvider(config, 'grid_p');
    return {
      name: `${config.label}: nessuna opzione verticale`,
      pass: shapes.length === 1 && shapes[0] === 'square' && options.length === 0,
      detail: `forme=[${shapes.join(',')}] opzioni=${options.length}`,
    };
  });

/**
 * A game carrying a Perfect composition must have a clean starting point.
 *
 * The editor may never re-open on the artwork it produced - that is what bakes a second
 * logo into the picture - so this asserts that the "Steam's own artwork" list contains no
 * custom asset at all.
 */
const checkPerfectSources = async (): Promise<Check[]> => {
  const store = (window as any).appStore;
  const apps: any[] = Array.isArray(store?.allApps) ? store.allApps.slice(0, 400) : [];
  const checks: Check[] = [];

  for (const app of apps) {
    const appId = Number(app?.appid ?? 0);
    if (!appId) continue;

    const composed = await isPerfectArtwork(appId, 'hero');
    if (!composed) continue;

    const overview = await getAppOverview(appId);
    if (!overview) continue;
    const sources = steamOwnArtworkSources(overview, 'hero');
    const dirty = sources.filter((url) => /steamloopback\.host|\/library\/\d{6,}\//.test(url));
    checks.push({
      name: `perfect hero ${overview.display_name ?? appId}: sorgente pulita`,
      pass: sources.length > 0 && dirty.length === 0,
      detail: dirty.length ? `contiene artwork custom: ${dirty[0]}` : `${sources.length} candidati, nessuno custom`,
    });
    if (checks.length >= 3) break;
  }

  if (checks.length === 0) {
    checks.push({ name: 'perfect hero: sorgente pulita', pass: true, detail: 'nessun gioco con perfect hero da controllare' });
  }
  return checks;
};

/**
 * Is the first thing in the recents row a wide banner, or another cover?
 *
 * "Il banner non funziona mai" was reported over and over and never had a number attached
 * to it. The first item of the row is measured directly: a banner is wide, a cover is not.
 */
const checkBanner = (view: Window, wantBanner: boolean): Check[] => {
  const name = `home: primo elemento ${wantBanner ? 'banner' : 'cover'}`;
  const nodes = capsules(view, sel(appportraitClasses, 'InRecentGames'));
  if (nodes.length === 0) {
    return [{ name, pass: false, detail: 'riga recenti non trovata' }];
  }

  const capsuleBox = nodes[0].getBoundingClientRect();

  /* Walk up to the element that spans the row, then read it in DOM order. */
  let row: HTMLElement | null = nodes[0];
  for (let step = 0; row && step < 8; step += 1) {
    if (row.getBoundingClientRect().width > capsuleBox.width * 2.5) break;
    row = row.parentElement;
  }
  if (!row) return [{ name, pass: false, detail: 'contenitore della riga non trovato' }];

  /*
    DOM order, not screen position.

    The first attempt took the leftmost image on screen and got a clipped item from a
    scrolled carousel - a measurement of the wrong element, which is worse than no
    measurement. The featured banner is the FIRST item of the row, wherever the row happens
    to be scrolled to.
  */
  const images = Array.from(row.querySelectorAll('img')).filter((image) => {
    const box = image.getBoundingClientRect();
    return box.width > 40 && box.height > 40;
  });
  if (images.length === 0) return [{ name, pass: false, detail: 'nessuna immagine nella riga' }];

  const describe = (image: HTMLImageElement) => {
    const box = image.getBoundingClientRect();
    const ratio = box.height > 0 ? box.width / box.height : 0;
    return `${Math.round(box.width)}x${Math.round(box.height)} r${ratio.toFixed(2)}`;
  };

  const firstBox = images[0].getBoundingClientRect();
  const ratio = firstBox.height > 0 ? firstBox.width / firstBox.height : 0;
  const isBanner = ratio >= 1.3;

  return [
    {
      /* Steam's own banner: reported, never failed - the plugin does not decide this. */
      name: 'home: primo elemento (banner di Steam)',
      pass: isBanner,
      detail: `${describe(images[0])} → ${isBanner ? 'banner' : 'cover'}`,
    },
    {
      /* Informative, never a failure: it is what tells us what the row is actually made of. */
      name: 'home: primi elementi della riga',
      pass: true,
      detail: images.slice(0, 4).map(describe).join(' | '),
    },
  ];
};

/** A game that actually has a hero, so the editors have something to open on. */
const gameWithHero = async (): Promise<any> => {
  const store = (window as any).appStore;
  const apps: any[] = Array.isArray(store?.allApps) ? store.allApps.slice(0, 120) : [];
  for (const app of apps) {
    const appId = Number(app?.appid ?? 0);
    if (!appId) continue;

    const overview = await getAppOverview(appId);
    if (overview && artworkSources(overview, 'hero').length > 0) return overview;
  }
  return null;
};

/** Everything clickable on screen, with the text Steam actually shows on it. */
const buttons = (view: Window): HTMLElement[] =>
  Array.from(view.document.querySelectorAll('button, [class*="DialogButton"], [role="button"]')) as HTMLElement[];

/*
  Steam's tabs are not <button> elements.

  Looking only at buttons reported "tab non trovata" on a Home that plainly has Novita,
  Amici and Consigliati on screen. Anything visible whose own text matches is a candidate,
  and the smallest such element is the label itself rather than a container around half the
  page.
*/
const clickableWithText = (view: Window, text: string): HTMLElement | null => {
  const wanted = text.toLowerCase();
  const matches = (Array.from(view.document.querySelectorAll('div, span, button, a')) as HTMLElement[])
    .filter((node) => {
      const own = (node.textContent ?? '').trim().toLowerCase();
      if (!own || own.length > wanted.length + 6 || !own.includes(wanted)) return false;
      const box = node.getBoundingClientRect();
      return box.width > 20 && box.height > 10 && box.top >= 0 && box.top < view.innerHeight;
    });
  if (matches.length === 0) return null;
  return matches.reduce((best, node) =>
    (node.getBoundingClientRect().width < best.getBoundingClientRect().width ? node : best));
};

const buttonWithText = (view: Window, text: string): HTMLElement | null => {
  const wanted = text.toLowerCase();
  return buttons(view).find((node) => (node.textContent ?? '').toLowerCase().includes(wanted))
    ?? clickableWithText(view, text);
};

/*
  Pressing a button the way the gamepad does.

  Steam drives its interface with `vgp_*` DOM events, so this dispatches them on the
  element that has the focus. Clicking is the A button; the direction and shoulder events
  are the only way to test an editor that has no on-screen controls at all - which is the
  whole design of the logo positioner.
*/
const press = (view: Window, kind: 'ok' | 'cancel', target?: Element | null) => {
  const node = target ?? view.document.activeElement;
  if (!node) return;
  const event = new (view as any).CustomEvent(`vgp_on${kind}`, { bubbles: true, detail: {} });
  node.dispatchEvent(event);
};

const pressDirection = (view: Window, button: number, target?: Element | null) => {
  const node = target ?? view.document.activeElement;
  if (!node) return;
  const detail = { button, is_repeat: false };
  /*
    Two names are tried because Steam has used both; the test judges by the EFFECT, so the
    one that does nothing simply costs nothing.
  */
  ['vgp_ondirection', 'vgp_onbuttondown'].forEach((name) => {
    node.dispatchEvent(new (view as any).CustomEvent(name, { bubbles: true, detail }));
  });
};

/** The readout text of the logo editor, used to tell whether a press did anything. */
const logoReadout = (view: Window): string =>
  (view.document.querySelector('.pa-logo-readout')?.textContent ?? '').trim();

/**
 * The real journey: game page, the right tab, the real button.
 *
 * Opening the editors by calling `showModal` from the test looked like a shortcut and was
 * a lie: the panel that came up had none of the page's styling and none of its props, so
 * the screenshots showed a layout nobody ever sees. An editor is only the real editor when
 * it is opened the way a person opens it.
 */
const openEditorFromPage = async (
  view: Window,
  appId: number,
  assetType: string,
  buttonText: string,
  modal: string,
  shotName: string
): Promise<Check[]> => {
  const checks: Check[] = [];

  Router.Navigate(`/playhub-artworks/${appId}/${assetType}`);
  await wait(2600);
  await shot(`pagina_${assetType}`);

  const opener = buttonWithText(view, buttonText);
  checks.push({
    name: `pagina ${assetType}: pulsante "${buttonText}"`,
    pass: Boolean(opener),
    detail: opener ? 'presente' : 'non trovato nella pagina',
  });
  if (!opener) return checks;

  opener.click();
  await wait(2200);
  await shot(shotName);

  const root = view.document.querySelector(`[data-pa-modal="${modal}"]`);
  checks.push({
    name: `editor ${modal}: si apre dalla pagina`,
    pass: Boolean(root),
    detail: root ? 'pannello montato' : 'pannello non trovato',
  });

  if (root) {
    const active = view.document.activeElement;
    const inside = Boolean(active && root.contains(active));
    checks.push({
      name: `editor ${modal}: ha il focus`,
      pass: inside,
      detail: inside ? 'focus dentro il pannello' : `focus fuori (${active?.className || 'niente'}) → i tasti non arrivano`,
    });

    if (modal === 'logo') {
      /* Does the d-pad actually move anything? Judged by the readout, not by hope. */
      const before = logoReadout(view);
      pressDirection(view, GamepadButton.DIR_UP);
      await wait(500);
      const after = logoReadout(view);
      checks.push({
        name: 'editor logo: i direzionali fanno qualcosa',
        pass: before !== after && after.length > 0,
        detail: before === after ? `nessun cambiamento (${before || 'vuoto'})` : `${before} → ${after}`,
      });
    }

    if (modal === 'composer') {
      const logoButton = root.querySelector('[data-pa-layer="logo"]');
      checks.push({
        name: `editor ${assetType}: parte dal logo`,
        pass: logoButton?.getAttribute('data-pa-active') === 'true',
        detail: logoButton ? `logo attivo=${logoButton.getAttribute('data-pa-active')}` : 'selettore non trovato',
      });

      /*
        Both layers are actually driven, with real presses.

        "Gli sfondi non si muovono" and "si muovono di un millimetro" were reported more
        than once and never had a number attached: now the readout is read before and after
        pressing, and the check fails if nothing moved.
      */
      const readout = () => (root.querySelector('[data-pa-readout="transform"]')?.textContent ?? '').trim();
      const tap = async (selector: string) => {
        (root.querySelector(selector) as HTMLElement | null)?.click();
        await wait(350);
      };

      for (const layer of ['logo', 'background']) {

        await tap(`[data-pa-layer="${layer}"]`);
        const before = readout();

        await tap('[data-pa-move="right"]');
        const moved = readout();

        await tap('[data-pa-scale="up"]');
        const scaled = readout();
        checks.push({
          name: `editor ${assetType}: ${layer === 'logo' ? 'il logo' : 'lo sfondo'} si muove`,
          pass: moved !== before,
          detail: `${before} → ${moved}`,
        });
        checks.push({
          name: `editor ${assetType}: ${layer === 'logo' ? 'il logo' : 'lo sfondo'} si ridimensiona`,
          pass: scaled !== moved,
          detail: `${moved} → ${scaled}`,
        });
      }

      await shot(`${shotName}_dopo_movimenti`);
    }

    /* B has to close it. A window you cannot leave is the bug reported most often. */
    press(view, 'cancel', root);
    await wait(1200);
    const stillOpen = Boolean(view.document.querySelector(`[data-pa-modal="${modal}"]`));
    checks.push({
      name: `editor ${modal}: B chiude`,
      pass: !stillOpen,
      detail: stillOpen ? 'il pannello e ancora aperto' : 'chiuso',
    });
    if (stillOpen) {
      press(view, 'cancel', view.document.activeElement);
      await wait(800);
    }
  }

  return checks;
};

/** Steam's own crash page, which is what a bad patch produces. */
const crashed = (view: Window): boolean =>
  (view.document.body?.textContent ?? '').includes('error occurred while rendering');

/**
 * Changing tab in the library must not take the page down.
 *
 * Two owners of the `/library` chain is what killed it the first time, with TabMaster
 * crashing on the very first tab change.
 */
const checkLibraryTabs = async (view: Window): Promise<Check[]> => {
  const before = capsules(view, sel(gamepadLibraryClasses, 'GamepadLibrary')).length;
  /* The library tab strip sits at the top of the page, whatever elements Steam builds it from. */
  const tabs = (Array.from(view.document.querySelectorAll('div, span, button')) as HTMLElement[])
    .filter((node) => {
      const text = (node.textContent ?? '').trim();
      if (text.length < 3 || text.length > 24) return false;
      const box = node.getBoundingClientRect();
      return box.top > 20 && box.top < 200 && box.width > 50 && box.width < 400 && box.height > 15 && box.height < 90;
    })
    .filter((node, index, all) => all.findIndex((other) => other.textContent === node.textContent) === index);
  if (tabs.length < 2) {
    return [{ name: 'libreria: cambio tab', pass: false, detail: 'tab non trovate' }];
  }

  tabs[1].click();
  await wait(1800);
  const after = capsules(view, sel(gamepadLibraryClasses, 'GamepadLibrary')).length;
  const ok = !crashed(view);
  const result: Check[] = [{
    name: 'libreria: il cambio tab non fa crashare',
    pass: ok,
    detail: ok ? `capsule ${before} → ${after}` : 'pagina di errore dopo il cambio tab',
  }];
  tabs[0].click();
  await wait(1200);
  return result;
};

/**
 * Drives the UI through the states that keep breaking and reports what it measured.
 */
export const runLayoutSelfTest = async () => {
  const started = Date.now();
  const view = findSP()?.window;
  if (!view) {
    log('self test aborted', 'Steam UI non raggiungibile');
    return;
  }

  /* Whatever the user had is restored at the end, whatever happens in between. */
  const originalCover = String(await call<[string, string], string>('get_setting', 'library_cover_format', 'portrait'));
  const originalRecents = String(await call<[string, string], string>('get_setting', 'home_recent_format', 'banner'));
  const back = window.location.pathname;
  const checks: Check[] = [];
  /* Nothing this run does may end up saved: it drives real editors with real presses. */
  (window as any).__playhubSelfTest = true;

  const apply = async (cover: string, recents: string) => {
    await call<[string, string], void>('set_setting', 'library_cover_format', cover);
    await call<[string, string], void>('set_setting', 'home_recent_format', recents);
    await refreshLayoutPatches(false);
    await wait(1200);
  };

  try {
    /*
      Every combination the user can actually choose, applied for real.

      Testing only the one state that happened to be set is how "le verticali non vanno
      bene" and "il banner non funziona mai" survived a dozen builds: nothing ever put the
      plugin into those states and looked.
    */
    /*
      Two states, not four: the first game of the Home is Steam's banner and the plugin no
      longer offers to turn it into a cover, so there is nothing of ours to test there.
    */
    const matrix = [
      { cover: 'square', recents: 'banner' },
      { cover: 'portrait', recents: 'banner' },
    ];

    for (const combo of matrix) {
      const wantSquare = combo.cover === 'square';
      const tag = `${combo.cover}/${combo.recents}`;

      await apply(combo.cover, combo.recents);

      Router.Navigate('/library/home');

      await wait(1500);
      checks.push(...checkCapsules(view, sel(appportraitClasses, 'InRecentGames'), `home ${tag}`, wantSquare));
      checks.push(...checkBanner(view, combo.recents === 'banner'));
      checks.push(boxChain(view, sel(appportraitClasses, 'InRecentGames')));

      checks.push(await checkStability(view, sel(appportraitClasses, 'InRecentGames'), `home ${tag}`));
      checks.push(checkLabelWidth(view, sel(appportraitClasses, 'InRecentGames')));
      Router.Navigate('/library');

      checks.push({
        ...await checkMorph(view, sel(gamepadLibraryClasses, 'GamepadLibrary'), wantSquare),
        name: `libreria ${tag}: nessun morphing all'apertura`,
      });
      checks.push(...checkCapsules(view, sel(gamepadLibraryClasses, 'GamepadLibrary'), `libreria ${tag}`, wantSquare));

      await shot(`libreria_${combo.cover}_${combo.recents}`);

      checks.push(...(await checkLibraryTabs(view)).map((check) => ({ ...check, name: `${tag} · ${check.name}` })));
    }

    checks.push(...checkSquareOnlyProviders());
    checks.push(...await checkPerfectSources());

    /*
      The editors are left alone unless asked for: they are working, and driving them on
      every run is slow and touches the user's artwork for nothing.
    */
    const wantEditors = await call<[string, boolean], boolean>('get_setting', 'self_test_editors', false);
    if (wantEditors) {
      const game = await gameWithHero();
      if (game) {
        checks.push(...await openEditorFromPage(view, game.appid, 'logo', 'Posiziona logo', 'logo', 'editor_logo_reale'));
        checks.push(...await openEditorFromPage(view, game.appid, 'hero', 'Crea Perfect Hero', 'composer', 'editor_perfect_hero_reale'));
        checks.push(...await openEditorFromPage(view, game.appid, 'grid_l', 'Crea Perfect Banner', 'composer', 'editor_perfect_banner_reale'));
      }
    }
  } catch (error: any) {
    checks.push({ name: 'esecuzione', pass: false, detail: String(error?.message ?? error) });
  } finally {
    try {
      await apply(originalCover, originalRecents);
      Router.Navigate(back);
    } catch (_) {
      // The user can navigate back themselves; not worth failing the run over.
    }
  }

  (window as any).__playhubSelfTest = false;

  const failed = checks.filter((check) => !check.pass);
  const lines = checks.map((check) => `${check.pass ? 'PASS' : 'FAIL'} · ${check.name} · ${check.detail}`);

  log('SELF TEST', {
    impostazioniRipristinate: { cover: originalCover, recents: originalRecents },
    esito: failed.length === 0 ? 'TUTTO OK' : `${failed.length} FALLITI su ${checks.length}`,
    durataMs: Date.now() - started,
    falliti: failed.map((check) => `${check.name} · ${check.detail}`),
  });

  /*
    In blocks of eight, because the logger truncates an array at twelve entries - and a
    report that silently loses two thirds of its rows is how a run of 38 checks came back
    showing 12.
  */
  for (let index = 0; index < lines.length; index += 8) {
    log(`SELF TEST ${Math.floor(index / 8) + 1}`, lines.slice(index, index + 8));
  }
};

/**
 * Runs the self test when the setting asks for it, then clears the request.
 *
 * The flag is a plain setting, so the test can be started without touching the interface -
 * which is what makes it usable while nobody is watching.
 */
export const maybeRunSelfTest = async () => {
  try {
    const requested = await call<[string, boolean], boolean>('get_setting', 'run_self_test', false);
    if (!requested) return;
    await call<[string, boolean], void>('set_setting', 'run_self_test', false);
    await wait(2500);
    await runLayoutSelfTest();
  } catch (error) {
    log('self test check failed', error);
  }
};
