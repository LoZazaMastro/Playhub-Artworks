import { DialogButton, DropdownItem, Focusable, GamepadButton, GamepadEvent } from '@decky/ui';
import { call, toaster } from '@decky/api';
import {
  FC, useCallback, useEffect, useMemo, useRef, useState,
} from 'react';
import {
  MdImage, MdOutlineBrandingWatermark, MdRefresh, MdVisibility, MdVisibilityOff, MdZoomIn, MdZoomOut,
} from 'react-icons/md';
import { HiArrowDown, HiArrowLeft, HiArrowRight, HiArrowUp } from 'react-icons/hi2';

import getAppOverview from '../utils/getAppOverview';
import { artworkSources, steamOwnArtworkSources, useArtworkPreview } from '../utils/artworkSources';
import MenuIcon from '../components/Icons/MenuIcon';
import log from '../utils/log';
import { getPerfectSource, isPerfectArtwork, savePerfectSource } from '../utils/perfectArtwork';

export type ComposerTarget = 'hero' | 'grid_l';

type Layer = 'background' | 'logo';
type Transform = { x: number; y: number; scale: number };

/*
  Fixed output sizes.

  Composing at a single canonical size means Steam never has to re-crop an odd
  source: the plugin hands over one finished picture, so the game page and the
  Home always show exactly what the editor previewed.

  The banner keeps Steam's 920:430 shape but is rendered at 900px tall
  (1926 x 900) so the artwork stays sharp instead of being a 430px upscale.
*/
const TARGETS: Record<ComposerTarget, {
  width: number;
  height: number;
  title: string;
  intro: string;
  format: 'png' | 'jpg';
}> = {
  hero: {
    width: 3840,
    height: 1240,
    title: 'Crea Perfect Hero',
    intro: 'Sfondo e logo fusi in un unico hero 3840 × 1240.',
    format: 'jpg',
  },
  grid_l: {
    width: 1926,
    height: 900,
    title: 'Crea Perfect Banner',
    intro: 'Sfondo e logo fusi in un unico banner 1926 × 900, stesse proporzioni di Steam ad alta risoluzione.',
    format: 'jpg',
  },
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const BOUNDS: Record<Layer, [number, number]> = {
  background: [40, 300],
  logo: [5, 95],
};

const normalize = (layer: Layer, value: Transform): Transform => ({
  x: clamp(value.x, 0, 100),
  y: clamp(value.y, 0, 100),
  scale: clamp(value.scale, BOUNDS[layer][0], BOUNDS[layer][1]),
});

/*
  A background whose aspect ratio is not Steam's own opens CENTRED, horizontally and
  vertically. Anything else means a picture that arrives pre-cropped from a corner and the
  user has to undo that before they can start.

  The logo defaults differ per target because the two canvases are shaped differently: the
  hero is very wide, the banner much closer to square, so the same logo needs to be larger
  on the banner to read at the same size.
*/
const BACKGROUND_DEFAULT: Transform = { x: 50, y: 50, scale: 100 };

export const LOGO_DEFAULTS: Record<ComposerTarget, Transform> = {
  hero: { x: 25, y: 50, scale: 28 },
  grid_l: { x: 25, y: 50, scale: 40 },
};

const REFERENCE_WIDTH = 1920;

const percentOptions = Array.from({ length: 11 }, (_item, index) => index * 10)
  .map((value) => ({ data: value, label: `${value}%` }));

/**
 * Same shadow recipe Launch Curtain uses, expressed once so the CSS preview and the
 * canvas output stay identical. `scale` is the rendered width over the reference width.
 */
const shadowGeometry = (blurPercent: number, scale: number) => ({
  blur: Math.round((3 + (clamp(blurPercent, 0, 100) / 100) * 55) * scale),
  offset: Math.max(1, Math.round(8 * scale)),
});

const logoShadowFilter = (opacityPercent: number, blurPercent: number, scale: number) => {
  const opacity = clamp(opacityPercent, 0, 100) / 100;
  if (!(opacity > 0)) return 'none';
  const { blur, offset } = shadowGeometry(blurPercent, scale);
  const one = `drop-shadow(0 ${offset}px ${blur}px rgba(0,0,0,${opacity}))`;
  return `${one} ${one}`;
};

/** Reads an image the UI can already display and returns its raw base64 payload. */
const loadImage = (source: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error('Immagine non disponibile.'));
  image.src = source;
});

const toBase64 = async (source: string): Promise<{ data: string; ext: string } | null> => {
  try {
    const response = await fetch(source);
    if (!response.ok) return null;
    const blob = await response.blob();
    const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
    const data: string = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? '').split(',', 2)[1] ?? '');
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(blob);
    });
    return data ? { data, ext } : null;
  } catch (_) {
    return null;
  }
};

/**
 * Reads a source into a `data:` URL.
 *
 * Anything drawn onto the canvas has to come from one. An image fetched straight from a
 * remote URL taints the canvas, and a tainted canvas throws on `toDataURL` - which is a
 * save that fails at the very last step, after the preview has looked perfect all along.
 */
const asDataUrl = async (source: string): Promise<string> => {
  if (!source || source.startsWith('data:')) return source;
  try {
    const response = await fetch(source);
    if (!response.ok) return source;
    const blob = await response.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? '') || source);
      reader.onerror = () => resolve(source);
      reader.readAsDataURL(blob);
    });
  } catch (_) {
    return source;
  }
};

/** Same as `loadImage`, but guaranteed not to taint whatever it is drawn onto. */
const loadDrawableImage = async (source: string) => loadImage(await asDataUrl(source));

/**
 * Shrinks the kept-aside original before it is handed to the backend.
 *
 * The untouched background is stored so later edits never compose on top of an already
 * composed picture. A 6000 px wallpaper base64-encodes to something far larger than the
 * plugin bridge is meant to carry, and losing that call used to take the whole save with
 * it. It only ever has to be big enough to recompose from, so it is capped.
 */
const PRISTINE_MAX_WIDTH = 4096;

const boundedSource = async (source: string): Promise<{ data: string; ext: string } | null> => {
  try {
    const image = await loadDrawableImage(source);
    if (image.naturalWidth <= PRISTINE_MAX_WIDTH) return toBase64(await asDataUrl(source));

    const scale = PRISTINE_MAX_WIDTH / image.naturalWidth;
    const canvas = document.createElement('canvas');
    canvas.width = PRISTINE_MAX_WIDTH;
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return toBase64(await asDataUrl(source));
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return { data: canvas.toDataURL('image/jpeg', 0.95).split(',', 2)[1] ?? '', ext: 'jpg' };
  } catch (_) {
    return null;
  }
};

/**
 * Placement of the background, in percentages of the frame.
 * The canvas draw below uses the exact same numbers, so the preview is the result.
 *
 * At 100% the whole source is visible (contain), whatever its aspect ratio: an odd-shaped
 * hero has to be seen in full here, because this is the one place where the user decides
 * what part of it survives. Above 100% it fills and then overflows, and x/y choose which
 * part of the overflow is kept.
 */
const backgroundPlacement = (
  natural: { width: number; height: number },
  transform: Transform,
  frame: { width: number; height: number }
) => {
  if (!natural.width || !natural.height) return { width: 100, height: 100, left: 0, top: 0 };
  const base = Math.min(frame.width / natural.width, frame.height / natural.height);
  const ratio = base * (transform.scale / 100);
  const drawWidth = natural.width * ratio;
  const drawHeight = natural.height * ratio;
  /*
    x/y slide the picture through whatever slack there is, in BOTH directions.

    Centring the image whenever it did not overflow made the background impossible to move
    at the default scale: contained means no overflow, so the directional keys did
    nothing at all. With a single formula, 50% is still dead centre, 0% pins it to the
    left/top edge and 100% to the right/bottom - whether the image is larger than the
    frame or smaller than it.
  */
  const spaceX = drawWidth - frame.width;
  const spaceY = drawHeight - frame.height;
  const offsetX = -(spaceX * transform.x) / 100;
  const offsetY = -(spaceY * transform.y) / 100;
  return {
    width: (drawWidth / frame.width) * 100,
    height: (drawHeight / frame.height) * 100,
    left: (offsetX / frame.width) * 100,
    top: (offsetY / frame.height) * 100,
  };
};

const ArtworkComposerModal: FC<{
  closeModal?: () => void;
  appId: number;
  target: ComposerTarget;
  onSave: (data: string, format: 'png' | 'jpg', withLogo: boolean) => Promise<void>;
}> = ({ closeModal, appId, target, onSave }) => {
  const spec = TARGETS[target];
  const [app, setApp] = useState<AppStoreAppOverview | null>(null);
  // The logo is what people come here to place, so it is selected first.
  const [layer, setLayer] = useState<Layer>('logo');
  const [background, setBackground] = useState<Transform>(BACKGROUND_DEFAULT);
  const [logo, setLogo] = useState<Transform>(LOGO_DEFAULTS[target]);
  const [backgroundOpacity, setBackgroundOpacity] = useState(100);
  /*
    The logo can be left out of the composition altogether.

    Asked for directly: a Perfect Hero whose background is the whole point, with Steam's
    own logo layer left alone on top of it. The choice is remembered as a setting, because
    someone who wants clean heroes wants them for every game, not one at a time.
  */
  const [logoHidden, setLogoHidden] = useState(false);
  const [logoShadowOpacity, setLogoShadowOpacity] = useState(50);
  const [logoShadowBlur, setLogoShadowBlur] = useState(40);
  const [frameWidth, setFrameWidth] = useState(0);
  const [backgroundSource, setBackgroundSource] = useState('');
  const [inlineLogo, setInlineLogo] = useState('');
  const [sourceReady, setSourceReady] = useState(false);

  const [backgroundNatural, setBackgroundNatural] = useState({ width: 0, height: 0 });
  const [, setSaving] = useState(false);

  useEffect(() => { void getAppOverview(appId).then(setApp); }, [appId]);

  useEffect(() => {
    void (async () => {
      try {
        const stored = await call<[string, boolean], boolean>('get_setting', 'perfect_hide_logo', false);
        setLogoHidden(Boolean(stored));
      } catch (_) {
        // The default (logo included) is the safe one.
      }
    })();
  }, []);

  const assetKind: SGDBAssetType = target === 'hero' ? 'hero' : 'grid_l';

  /*
    Two candidate lists, because the right one depends on what is already applied.

    `current` is what the game shows now (custom artwork first). `original` is only what
    Steam itself would show. A game that already carries a Perfect composition has that
    composition as its custom artwork - logo baked in - so re-editing it from `current`
    would draw a second logo on top of the first. That was still happening on Perfect
    Banners; it is now handled the same way for both targets.
  */
  const currentCandidates = useMemo(() => (app ? artworkSources(app, assetKind) : []), [app, assetKind]);
  const originalCandidates = useMemo(() => (app ? steamOwnArtworkSources(app, assetKind) : []), [app, assetKind]);

  const [composed, setComposed] = useState<boolean | null>(null);
  const [zazaBackground, setZazaBackground] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.all([
      isPerfectArtwork(appId, target),
      target === 'hero'
        ? Promise.all([
          call<[string, boolean], boolean>('get_setting', `manual_zazamastro_hero_${appId}`, false),
          call<[string, Record<string, unknown>], Record<string, unknown>>('get_setting', `zazamastro_hero_${appId}`, {}),
        ])
        : Promise.resolve([false, {}] as [boolean, Record<string, unknown>]),
    ]).then(([perfect, [manualZaza, batchMarker]]) => {
      if (!active) return;
      setComposed(perfect);
      setZazaBackground(Boolean(manualZaza || Object.keys(batchMarker ?? {}).length));
    }).catch(() => {
      if (active) setComposed(false);
    });
    return () => { active = false; };
  }, [appId, target]);

  /*
    While `composed` is unknown nothing is fetched: picking a list too early would resolve
    the composed picture and adopt it a moment before the answer arrives.
  */
  const backgroundCandidates = useMemo(() => {
    if (composed === null) return [];
    // A LoZazaMastro hero is a valid manual background: only bulk keeps treating it as final.
    if (composed && !zazaBackground && originalCandidates.length > 0) return originalCandidates;
    return currentCandidates;
  }, [composed, currentCandidates, originalCandidates, zazaBackground]);

  const steamBackground = useArtworkPreview(backgroundCandidates);
  const logoCandidates = useMemo(() => (app ? artworkSources(app, 'logo') : []), [app]);
  const logoSource = useArtworkPreview(logoCandidates);

  /*
    The logo stays selected unless the game genuinely has none.

    Falling back the moment `logoSource` was empty switched to the background on every
    open, because the preview resolves asynchronously and is empty for the first frame.
    The candidate list is known straight away, so it is what decides.
  */
  useEffect(() => {
    if (app && logoCandidates.length === 0) setLayer('background');
  }, [app, logoCandidates.length]);

  /* What actually gets drawn: nothing at all while the logo is switched off. */
  const activeLogo = logoHidden ? '' : inlineLogo;

  const modalRef = useRef<HTMLDivElement | null>(null);
  const dirty = useRef(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef({
    background, logo, backgroundSource, logoSource: activeLogo,
    backgroundOpacity, logoShadowOpacity, logoShadowBlur,
  });
  const persistOnExit = useRef<() => Promise<void>>(async () => undefined);

  useEffect(() => {
    latest.current = {
      background, logo, backgroundSource, logoSource: activeLogo,
      backgroundOpacity, logoShadowOpacity, logoShadowBlur,
    };
  }, [background, logo, backgroundSource, activeLogo, backgroundOpacity, logoShadowOpacity, logoShadowBlur]);

  // Measuring the frame keeps the preview shadow the same size as the exported one.
  useEffect(() => {
    const node = frameRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setFrameWidth(entry.contentRect.width));
    observer.observe(node);
    setFrameWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [app]);

  /*
    A previous Perfect composition has already replaced Steam's artwork, logo and all.
    Composing again on top of it would stack a second logo, so the first untouched
    background is stored once and reused for every later edit.
  */
  /*
    Both sources are copied into `data:` URLs the moment they are adopted.

    `useArtworkPreview` hands back a `blob:` object URL and REVOKES it when its inputs
    change or the component unmounts. Holding on to that string meant the compose step
    could reach a URL that no longer pointed at anything, and the save died with
    "Immagine non disponibile." on a game whose artwork was perfectly present. A data URL
    cannot be revoked out from under us.
  */
  useEffect(() => {
    let active = true;
    void (async () => {
      const stored = await getPerfectSource(appId, target);
      if (!active) return;
      if (stored) {
        /*
          Which picture the editor started from, in the log.

          "Non ci deve essere un altro perfect hero nell'editor" cannot be judged from a
          screenshot - the logo layer sits exactly where a baked-in logo would be. The
          source is named here so it can be checked instead of guessed.
        */
        log('composer source', { target, origine: 'originale messo da parte', bytes: stored.length });
        setBackgroundSource(stored);
        setSourceReady(true);
        return;
      }
      if (!steamBackground) return;
      const inlined = await asDataUrl(steamBackground);
      if (!active) return;
      const adopted = inlined || steamBackground;
      log('composer source', {
        target,
        origine: composed ? 'artwork di Steam (il gioco ha gia una composizione)' : 'artwork attuale del gioco',
        candidati: (composed ? originalCandidates : currentCandidates).slice(0, 3),
      });
      setBackgroundSource(adopted);
      setSourceReady(true);

      /*
        The untouched original is kept aside NOW, not after the save.

        Storing it only once the composition had been written meant a failure there (a
        tainted canvas, an oversized picture, a save that never got that far) left nothing
        behind, and the next edit fell back to the composed artwork. The backend keeps the
        first file it is given, so writing it here is free and idempotent.
      */
      // Never freeze a composed picture as the original: that is the bug this prevents.
      if (composed && originalCandidates.length === 0) return;
      try {
        const pristine = await boundedSource(adopted);
        if (pristine?.data) await savePerfectSource(appId, target, pristine.data, pristine.ext);
      } catch (_) {
        // Not fatal: the post-save attempt is still there as a backstop.
      }
    })();
    return () => { active = false; };
  }, [appId, target, steamBackground, composed, currentCandidates, originalCandidates]);

  useEffect(() => {
    let active = true;
    void (async () => {
      if (!logoSource) {
        setInlineLogo('');
        return;
      }
      const inlined = await asDataUrl(logoSource);
      if (active) setInlineLogo(inlined || logoSource);
    })();
    return () => { active = false; };
  }, [logoSource]);

  const placement = useMemo(
    () => backgroundPlacement(backgroundNatural, background, spec),
    [background, backgroundNatural, spec]
  );

  const compose = useCallback(async (state = latest.current) => {
    if (!state.backgroundSource) return null;
    const backgroundImage = await loadDrawableImage(state.backgroundSource);
    const canvas = document.createElement('canvas');
    canvas.width = spec.width;
    canvas.height = spec.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Compositing non disponibile.');
    context.fillStyle = '#000';
    context.fillRect(0, 0, spec.width, spec.height);

    const box = backgroundPlacement(
      { width: backgroundImage.naturalWidth, height: backgroundImage.naturalHeight },
      state.background,
      spec
    );
    context.globalAlpha = clamp(state.backgroundOpacity, 0, 100) / 100;
    context.drawImage(
      backgroundImage,
      (box.left / 100) * spec.width,
      (box.top / 100) * spec.height,
      (box.width / 100) * spec.width,
      (box.height / 100) * spec.height
    );
    context.globalAlpha = 1;

    if (state.logoSource) {
      const logoImage = await loadDrawableImage(state.logoSource);
      const width = (spec.width * state.logo.scale) / 100;
      const height = (width * logoImage.naturalHeight) / logoImage.naturalWidth;
      const left = (spec.width * state.logo.x) / 100 - width / 2;
      const top = (spec.height * state.logo.y) / 100 - height / 2;
      const opacity = clamp(state.logoShadowOpacity, 0, 100) / 100;
      if (opacity > 0) {
        const { blur, offset } = shadowGeometry(state.logoShadowBlur, spec.width / REFERENCE_WIDTH);
        context.shadowColor = `rgba(0,0,0,${opacity})`;
        context.shadowBlur = blur;
        context.shadowOffsetY = offset;
        // Drawn twice to match the doubled CSS drop-shadow used in the preview.
        context.drawImage(logoImage, left, top, width, height);
        context.drawImage(logoImage, left, top, width, height);
        context.shadowColor = 'transparent';
        context.shadowBlur = 0;
        context.shadowOffsetY = 0;
      }
      context.drawImage(logoImage, left, top, width, height);
    }
    return canvas;
  }, [spec]);

  /*
    Saving happens exactly once, even though it is asked for twice.

    Pressing B calls `persist()` and then closes the modal, and the unmount effect calls
    `persist()` again on the way out. The old guard read `saving` from React state, which
    is set asynchronously and is captured in the closure - so the second call saw
    `saving === false` and `dirty === true` (dirty is only cleared after the write) and
    started a SECOND save on top of the first. `changeAsset` clears the artwork before
    writing it, so the second attempt's clear could land after the first attempt's write
    and leave the game with no hero at all. That is the "sometimes it does not save".

    The in-flight save is now kept in a ref and reused: a second caller awaits the same
    promise instead of starting its own.
  */
  const inFlight = useRef<Promise<void> | null>(null);

  const persist = useCallback(async (): Promise<void> => {
    /*
      The self test drives this editor with real presses, and a real press makes it dirty -
      so closing it wrote a composition the user never asked for. A test must never change
      the user's artwork.
    */
    if ((window as any).__playhubSelfTest) {
      log('composer: salvataggio saltato (autotest)');
      return;
    }
    if (inFlight.current) return inFlight.current;
    if (!dirty.current) return;
    const state = latest.current;
    if (!state.backgroundSource) return;

    const run = (async () => {
      setSaving(true);
      try {
        const canvas = await compose(state);
        if (!canvas) throw new Error('Composizione non riuscita.');

        const data = spec.format === 'jpg'
          ? canvas.toDataURL('image/jpeg', 0.95).replace(/^data:image\/jpeg;base64,/, '')
          : canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
        if (!data) throw new Error('Immagine vuota.');

        await onSave(data, spec.format, Boolean(state.logoSource));
        dirty.current = false;
        log('composer saved', {
          target,
          bytes: data.length,
          canvas: `${canvas.width}x${canvas.height}`,
        });

        /*
          Only now, and never in a way that can take the save down with it: the artwork
          is already applied, and the kept-aside original is a convenience for the NEXT
          edit.
        */
        try {
          const pristine = await boundedSource(state.backgroundSource);
          if (pristine?.data) await savePerfectSource(appId, target, pristine.data, pristine.ext);
          else log('composer pristine source not stored', { target });
        } catch (sourceError: any) {
          log('composer pristine source failed', { target, message: sourceError?.message });
        }
        toaster.toast({
          title: app?.display_name ?? 'Playhub Artworks',
          body: `${spec.title.replace('Crea ', '')} creato.`,
          icon: <MenuIcon />,
          duration: 1800,
        });
      } catch (error: any) {
        log('composer save failed', { target, message: error?.message, stack: error?.stack });
        toaster.toast({
          title: `${spec.title.replace('Crea ', '')} non salvato`,
          body: error?.message ?? 'Riprova.',
          icon: <MenuIcon fill="#ff5d5d" />,
        });
      } finally {
        setSaving(false);
        inFlight.current = null;
      }
    })();

    inFlight.current = run;
    return run;
  }, [app?.display_name, appId, compose, onSave, spec, target]);

  /*
    B closes IMMEDIATELY; the save carries on behind it.

    This used to `await persist()` before calling `closeModal`, and a save is not quick:
    it fetches the source, composes a 3840 x 1240 canvas and hands Steam a couple of
    megabytes, with a deliberate pause while the old artwork is cleared. For those seconds
    B did nothing at all and the editor looked stuck. The save is started here and the
    unmount effect below picks up the very same in-flight promise, so it still runs
    exactly once and still finishes.
  */
  const close = useCallback(() => {
    void persist();
    closeModal?.();
  }, [closeModal, persist]);

  useEffect(() => { persistOnExit.current = persist; }, [persist]);

  useEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;
    const onGamepadCancel = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    modal.addEventListener('vgp_oncancel', onGamepadCancel);
    return () => modal.removeEventListener('vgp_oncancel', onGamepadCancel);
  }, [app, close]);

  useEffect(() => () => { void persistOnExit.current(); }, []);

  const activeTransform = layer === 'background' ? background : logo;
  const setActiveTransform = useCallback((change: (value: Transform) => Transform) => {
    dirty.current = true;
    if (layer === 'background') setBackground((value) => normalize('background', change(value)));
    else setLogo((value) => normalize('logo', change(value)));
  }, [layer]);

  /*
    One press has to move the same visible distance for both layers.

    The logo is placed by its centre across the whole frame, so 1% of the frame is a
    visible jump. The background is panned through its OVERFLOW, which at normal scales is
    a small fraction of the frame - so the same 1% moved it by about a millimetre. The
    background therefore steps five times as far.
  */
  const stepFor = (target: Layer) => (target === 'background' ? 5 : 1);

  const move = (dx: number, dy: number) => setActiveTransform((value) => ({
    ...value,
    x: value.x + dx * stepFor(layer),
    y: value.y + dy * stepFor(layer),
  }));

  const resize = (delta: number) => setActiveTransform((value) => ({
    ...value,
    scale: value.scale + delta * (layer === 'background' ? 2 : 1),
  }));

  const reset = () => {
    dirty.current = true;
    if (layer === 'background') setBackground(BACKGROUND_DEFAULT);
    else setLogo(LOGO_DEFAULTS[target]);
  };

  /* LB/RB stay available everywhere; the d-pad keeps navigating the controls. */
  const handleButton = (event: GamepadEvent) => {
    const { button } = event.detail;
    if (button !== GamepadButton.BUMPER_LEFT && button !== GamepadButton.BUMPER_RIGHT) return;
    event.stopPropagation();
    resize(button === GamepadButton.BUMPER_LEFT ? -2 : 2);
  };

  const canEditLogo = Boolean(activeLogo);

  /*
    Switching the logo off has to move the selection too: the move and scale buttons would
    otherwise be driving a layer that is not being drawn.
  */
  const toggleLogo = () => {
    const hidden = !logoHidden;
    dirty.current = true;
    setLogoHidden(hidden);
    if (hidden) setLayer('background');
    else if (inlineLogo) setLayer('logo');
    void call<[string, boolean], void>('set_setting', 'perfect_hide_logo', hidden).catch(() => undefined);
  };

  return (
    <Focusable
      ref={modalRef}
      className="pa-editor"
      data-pa-modal="composer"
      flow-children="vertical"
      onButtonDown={handleButton}
      onCancel={close}
      onCancelButton={close}
      onCancelActionDescription="Salva ed esci"
      actionDescriptionMap={{
        [GamepadButton.BUMPER_LEFT]: 'Rimpicciolisci',
        [GamepadButton.BUMPER_RIGHT]: 'Ingrandisci',
      }}
    >
      <div className="pa-editor-backdrop" />

      <div className="pa-editor-shell">
        <div className="pa-editor-head">
          <div>
            <strong>{spec.title}</strong>
            <span>{spec.intro}</span>
          </div>
        </div>

        <div className="pa-editor-layout">
          <div className="pa-editor-preview" aria-hidden="true">
            <div ref={frameRef} className="pa-editor-frame" style={{ aspectRatio: `${spec.width} / ${spec.height}` }}>
              {backgroundSource ? (
                <img
                  className="pa-editor-bg"
                  src={backgroundSource}
                  alt=""
                  onLoad={(event) => setBackgroundNatural({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })}
                  style={{
                    width: `${placement.width}%`,
                    height: `${placement.height}%`,
                    left: `${placement.left}%`,
                    top: `${placement.top}%`,
                    opacity: backgroundOpacity / 100,
                  }}
                />
              ) : (
                <div className="pa-editor-empty">
                  {sourceReady ? 'Nessuno sfondo installato per questo gioco.' : 'Carico lo sfondo…'}
                </div>
              )}

              <div className="pa-editor-clip">
                {canEditLogo && activeLogo && (
                  <img
                    className="pa-editor-logo"
                    src={activeLogo}
                    alt=""
                    style={{
                      left: `${logo.x}%`,
                      top: `${logo.y}%`,
                      width: `${logo.scale}%`,
                      filter: logoShadowFilter(logoShadowOpacity, logoShadowBlur, (frameWidth || REFERENCE_WIDTH) / REFERENCE_WIDTH),
                    }}
                  />
                )}
              </div>

              <div className="pa-editor-frame-edge" />
            </div>
            <span className="pa-editor-size">{spec.width} × {spec.height}</span>
          </div>

          <Focusable className="pa-editor-controls" flow-children="vertical">
            <span className="pa-editor-label">Cosa vuoi modificare?</span>
            {/* Logo first, on the left: it is what the editor is opened for. */}
            <Focusable className="pa-editor-row" flow-children="horizontal">
              <DialogButton
                data-pa-layer="logo"
                data-pa-active={layer === 'logo' ? 'true' : 'false'}
                className={layer === 'logo' ? 'active' : ''}
                disabled={!canEditLogo}
                onClick={() => setLayer('logo')}
              >
                <MdOutlineBrandingWatermark /><span>Logo</span>
              </DialogButton>
              <DialogButton
                data-pa-layer="background"
                data-pa-active={layer === 'background' ? 'true' : 'false'}
                className={layer === 'background' ? 'active' : ''}
                onClick={() => setLayer('background')}
              >
                <MdImage /><span>Sfondo</span>
              </DialogButton>
            </Focusable>

            {!inlineLogo && (
              <span className="pa-editor-hint">Questo gioco non ha un logo: verrà composto solo lo sfondo.</span>
            )}

            {Boolean(inlineLogo) && (
              <Focusable className="pa-editor-row" flow-children="horizontal">
                <DialogButton
                  data-pa-logo-visible={logoHidden ? 'false' : 'true'}
                  onClick={toggleLogo}
                >
                  {logoHidden ? <MdVisibilityOff /> : <MdVisibility />}
                  <span>{logoHidden ? 'Logo escluso' : 'Logo incluso'}</span>
                </DialogButton>
              </Focusable>
            )}

            {logoHidden && Boolean(inlineLogo) && (
              <span className="pa-editor-hint">
                {'Il logo non viene fuso nell’immagine: resta quello di Steam, sopra lo sfondo.'}
              </span>
            )}

            {/* Marked so the self test can read the values back instead of eyeballing them. */}
            <span className="pa-editor-label" data-pa-readout="transform">
              Posizione · {Math.round(activeTransform.x)}% / {Math.round(activeTransform.y)}% · scala {Math.round(activeTransform.scale)}%
            </span>

            <Focusable className="pa-editor-row pa-editor-row-center" flow-children="horizontal">
              <DialogButton data-pa-move="up" onClick={() => move(0, -1)}><HiArrowUp /></DialogButton>
            </Focusable>
            <Focusable className="pa-editor-row" flow-children="horizontal">
              <DialogButton data-pa-move="left" onClick={() => move(-1, 0)}><HiArrowLeft /></DialogButton>
              <DialogButton onClick={reset}><MdRefresh /><span>Reimposta</span></DialogButton>
              <DialogButton data-pa-move="right" onClick={() => move(1, 0)}><HiArrowRight /></DialogButton>
            </Focusable>
            <Focusable className="pa-editor-row pa-editor-row-center" flow-children="horizontal">
              <DialogButton data-pa-move="down" onClick={() => move(0, 1)}><HiArrowDown /></DialogButton>
            </Focusable>

            <Focusable className="pa-editor-row" flow-children="horizontal">
              <DialogButton data-pa-scale="down" onClick={() => resize(-2)}><MdZoomOut /><span>Riduci</span></DialogButton>
              <DialogButton data-pa-scale="up" onClick={() => resize(2)}><MdZoomIn /><span>Ingrandisci</span></DialogButton>
            </Focusable>

            <span className="pa-editor-label">Rifinitura</span>
            <DropdownItem
              label="Opacità dello sfondo"
              rgOptions={percentOptions}
              selectedOption={backgroundOpacity}
              onChange={(option) => { dirty.current = true; setBackgroundOpacity(Number(option.data)); }}
            />
            <DropdownItem
              label="Opacità ombra del logo"
              disabled={!canEditLogo}
              rgOptions={percentOptions}
              selectedOption={logoShadowOpacity}
              onChange={(option) => { dirty.current = true; setLogoShadowOpacity(Number(option.data)); }}
            />
            <DropdownItem
              label="Sfocatura ombra del logo"
              disabled={!canEditLogo}
              rgOptions={percentOptions}
              selectedOption={logoShadowBlur}
              onChange={(option) => { dirty.current = true; setLogoShadowBlur(Number(option.data)); }}
            />

            <span className="pa-editor-hint">
              LB e RB regolano la dimensione da qualsiasi punto.
              Uscendo con B la composizione viene salvata.
            </span>
          </Focusable>
        </div>
      </div>

    </Focusable>
  );
};

export default ArtworkComposerModal;
