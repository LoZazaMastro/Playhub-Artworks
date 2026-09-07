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
import t, { localizeError } from '../utils/i18n';
import { getPerfectSource, isPerfectArtwork, preservePerfectSource } from '../utils/perfectArtwork';
import {
  canvasToBase64,
  loadSafeImage,
  releaseCanvas,
  releaseImage,
  withCompositionLock,
} from '../utils/imageSafety';

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
    title: t('PA_CREATE_PERFECT_HERO', 'Create Perfect Hero'),
    intro: t('PA_PERFECT_HERO_DESC', 'Background and logo merged into a single 3840 × 1240 hero.'),
    format: 'jpg',
  },
  grid_l: {
    width: 1926,
    height: 900,
    title: t('PA_CREATE_PERFECT_BANNER', 'Create Perfect Banner'),
    intro: t('PA_PERFECT_BANNER_DESC', 'Background and logo merged into a single 1926 × 900 banner, matching Steam proportions at high resolution.'),
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

/** Preview sources are object/data URLs, so canvas reads stay local and untainted. */
const loadDrawableImage = async (source: string) => loadSafeImage(source);

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
  const [sourceReady, setSourceReady] = useState(false);

  const [backgroundNatural, setBackgroundNatural] = useState({ width: 0, height: 0 });
  const [saving, setSaving] = useState(false);

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
  const activeLogo = logoHidden ? '' : logoSource;

  const modalRef = useRef<HTMLDivElement | null>(null);
  const dirty = useRef(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const latest = useRef({
    background, logo, backgroundSource, logoSource: activeLogo,
    backgroundOpacity, logoShadowOpacity, logoShadowBlur,
  });

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
    "The image is unavailable." on a game whose artwork was perfectly present. A data URL
    cannot be revoked out from under us.
  */
  const sourceBackup = useRef<Promise<unknown> | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const stored = await getPerfectSource(appId, target);
      if (!active) return;
      if (stored) {
        /*
          Which picture the editor started from, in the log.

          Whether another Perfect Hero is present in the editor cannot be judged from a
          screenshot - the logo layer sits exactly where a baked-in logo would be. The
          source is named here so it can be checked instead of guessed.
        */
        log('composer source', { target, source: 'original preserved', bytes: stored.length });
        setBackgroundSource(stored);
        setSourceReady(true);
        return;
      }
      if (!steamBackground) return;
      const adopted = steamBackground;
      log('composer source', {
        target,
        source: composed ? 'Steam artwork (the game already has a composition)' : 'current game artwork',
        candidates: (composed ? originalCandidates : currentCandidates).slice(0, 3),
      });
      setBackgroundSource(adopted);
      setSourceReady(true);

      // Never freeze a composed picture as the original: that is the bug this prevents.
      if (composed && originalCandidates.length === 0) return;
      if (!sourceBackup.current) {
        const candidates = composed && !zazaBackground ? originalCandidates : currentCandidates;
        sourceBackup.current = preservePerfectSource(
          appId,
          target,
          candidates,
          !(composed && !zazaBackground)
        ).then((result) => {
          log('composer source preserved', { target, result });
          return result;
        });
      }
    })();
    return () => { active = false; };
  }, [appId, target, steamBackground, composed, currentCandidates, originalCandidates, zazaBackground]);

  const placement = useMemo(
    () => backgroundPlacement(backgroundNatural, background, spec),
    [background, backgroundNatural, spec]
  );

  const compose = useCallback(async (state = latest.current) => {
    if (!state.backgroundSource) return null;
    return await withCompositionLock(async () => {
      let backgroundImage: HTMLImageElement | null = null;
      let logoImage: HTMLImageElement | null = null;
      let canvas: HTMLCanvasElement | null = null;
      try {
        backgroundImage = await loadDrawableImage(state.backgroundSource);
        canvas = document.createElement('canvas');
        canvas.width = spec.width;
        canvas.height = spec.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('PA_ERROR_COMPOSITING_UNAVAILABLE');
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
          logoImage = await loadDrawableImage(state.logoSource);
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
            context.drawImage(logoImage, left, top, width, height);
            context.drawImage(logoImage, left, top, width, height);
            context.shadowColor = 'transparent';
            context.shadowBlur = 0;
            context.shadowOffsetY = 0;
          }
          context.drawImage(logoImage, left, top, width, height);
        }

        const data = await canvasToBase64(canvas, spec.format, 0.92);
        return { data, width: canvas.width, height: canvas.height };
      } finally {
        releaseImage(backgroundImage);
        releaseImage(logoImage);
        releaseCanvas(canvas);
      }
    });
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
      log('composer: save skipped (autotest)');
      return;
    }
    if (inFlight.current) return inFlight.current;
    if (!dirty.current) return;
    const state = latest.current;
    if (!state.backgroundSource) return;

    const run = (async () => {
      setSaving(true);
      try {
        const composition = await compose(state);
        if (!composition) throw new Error('PA_ERROR_COMPOSITION_FAILED');

        if (sourceBackup.current) {
          await Promise.race([
            sourceBackup.current,
            new Promise((resolve) => window.setTimeout(resolve, 500)),
          ]);
        }

        await onSave(composition.data, spec.format, Boolean(state.logoSource));
        dirty.current = false;
        log('composer saved', {
          target,
          bytes: composition.data.length,
          canvas: `${composition.width}x${composition.height}`,
        });

        toaster.toast({
          title: app?.display_name ?? 'Playhub Artworks',
          body: target === 'hero' ? t('PA_PERFECT_HERO_CREATED', 'Perfect Hero created.') : t('PA_PERFECT_BANNER_CREATED', 'Perfect Banner created.'),
          icon: <MenuIcon />,
          duration: 1800,
        });
      } catch (error: any) {
        log('composer save failed', { target, message: error?.message, stack: error?.stack });
        toaster.toast({
          title: target === 'hero' ? t('PA_PERFECT_HERO_NOT_SAVED', 'Perfect Hero was not saved') : t('PA_PERFECT_BANNER_NOT_SAVED', 'Perfect Banner was not saved'),
          body: localizeError(error, 'PA_TRY_AGAIN'),
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

  const closing = useRef(false);

  /* Keep the editor mounted until the write finishes so errors remain visible and no
     canvas or plugin call is left running from an unmounted component. */
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    void persist().finally(() => closeModal?.());
  }, [closeModal, persist]);

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
    else if (logoSource) setLayer('logo');
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
      onCancelActionDescription={saving ? t('PA_SAVING', 'Saving…') : t('PA_SAVE_EXIT', 'Save and exit')}
      aria-busy={saving}
      actionDescriptionMap={{
        [GamepadButton.BUMPER_LEFT]: t('PA_SHRINK', 'Shrink'),
        [GamepadButton.BUMPER_RIGHT]: t('PA_ENLARGE', 'Enlarge'),
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
                  {sourceReady ? t('PA_NO_BACKGROUND_GAME', 'No background is installed for this game.') : t('PA_LOADING_BACKGROUND', 'Loading background…')}
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
            <span className="pa-editor-label">{t('PA_WHAT_EDIT', 'What do you want to edit?')}</span>
            {/* Logo first, on the left: it is what the editor is opened for. */}
            <Focusable className="pa-editor-row" flow-children="horizontal">
              <DialogButton
                data-pa-layer="logo"
                data-pa-active={layer === 'logo' ? 'true' : 'false'}
                className={layer === 'logo' ? 'active' : ''}
                disabled={!canEditLogo}
                onClick={() => setLayer('logo')}
              >
                <MdOutlineBrandingWatermark /><span>{t('ASSET_TYPE_LOGO', 'Logo')}</span>
              </DialogButton>
              <DialogButton
                data-pa-layer="background"
                data-pa-active={layer === 'background' ? 'true' : 'false'}
                className={layer === 'background' ? 'active' : ''}
                onClick={() => setLayer('background')}
              >
                <MdImage /><span>{t('PA_BACKGROUND', 'Background')}</span>
              </DialogButton>
            </Focusable>

            {!logoSource && (
              <span className="pa-editor-hint">{t('PA_NO_LOGO_COMPOSE_BG_ONLY', 'This game has no logo, so only the background will be composed.')}</span>
            )}

            {Boolean(logoSource) && (
              <Focusable className="pa-editor-row" flow-children="horizontal">
                <DialogButton
                  data-pa-logo-visible={logoHidden ? 'false' : 'true'}
                  onClick={toggleLogo}
                >
                  {logoHidden ? <MdVisibilityOff /> : <MdVisibility />}
                  <span>{logoHidden ? t('PA_LOGO_EXCLUDED', 'Logo excluded') : t('PA_LOGO_INCLUDED', 'Logo included')}</span>
                </DialogButton>
              </Focusable>
            )}

            {logoHidden && Boolean(logoSource) && (
              <span className="pa-editor-hint">
                {t('PA_LOGO_EXCLUDED_DESC', 'The logo is not merged into the image; Steam keeps displaying it over the background.')}
              </span>
            )}

            {/* Marked so the self test can read the values back instead of eyeballing them. */}
            <span className="pa-editor-label" data-pa-readout="transform">
              {t('PA_POSITION_SCALE', 'Position · {x}% / {y}% · scale {scale}%').replace('{x}', String(Math.round(activeTransform.x))).replace('{y}', String(Math.round(activeTransform.y))).replace('{scale}', String(Math.round(activeTransform.scale)))}
            </span>

            <Focusable className="pa-editor-row pa-editor-row-center" flow-children="horizontal">
              <DialogButton data-pa-move="up" aria-label={t('PA_MOVE_UP', 'Move up')} onOKActionDescription={t('PA_MOVE_UP', 'Move up')} onClick={() => move(0, -1)}><HiArrowUp /></DialogButton>
            </Focusable>
            <Focusable className="pa-editor-row" flow-children="horizontal">
              <DialogButton data-pa-move="left" aria-label={t('PA_MOVE_LEFT', 'Move left')} onOKActionDescription={t('PA_MOVE_LEFT', 'Move left')} onClick={() => move(-1, 0)}><HiArrowLeft /></DialogButton>
              <DialogButton onClick={reset}><MdRefresh /><span>{t('PA_RESET', 'Reset')}</span></DialogButton>
              <DialogButton data-pa-move="right" aria-label={t('PA_MOVE_RIGHT', 'Move right')} onOKActionDescription={t('PA_MOVE_RIGHT', 'Move right')} onClick={() => move(1, 0)}><HiArrowRight /></DialogButton>
            </Focusable>
            <Focusable className="pa-editor-row pa-editor-row-center" flow-children="horizontal">
              <DialogButton data-pa-move="down" aria-label={t('PA_MOVE_DOWN', 'Move down')} onOKActionDescription={t('PA_MOVE_DOWN', 'Move down')} onClick={() => move(0, 1)}><HiArrowDown /></DialogButton>
            </Focusable>

            <Focusable className="pa-editor-row" flow-children="horizontal">
              <DialogButton data-pa-scale="down" onClick={() => resize(-2)}><MdZoomOut /><span>{t('PA_SHRINK', 'Shrink')}</span></DialogButton>
              <DialogButton data-pa-scale="up" onClick={() => resize(2)}><MdZoomIn /><span>{t('PA_ENLARGE', 'Enlarge')}</span></DialogButton>
            </Focusable>

            <span className="pa-editor-label">{t('PA_REFINEMENT', 'Fine tuning')}</span>
            <DropdownItem
              label={t('PA_BACKGROUND_OPACITY', 'Background opacity')}
              rgOptions={percentOptions}
              selectedOption={backgroundOpacity}
              onChange={(option) => { dirty.current = true; setBackgroundOpacity(Number(option.data)); }}
            />
            <DropdownItem
              label={t('PA_LOGO_SHADOW_OPACITY', 'Logo shadow opacity')}
              disabled={!canEditLogo}
              rgOptions={percentOptions}
              selectedOption={logoShadowOpacity}
              onChange={(option) => { dirty.current = true; setLogoShadowOpacity(Number(option.data)); }}
            />
            <DropdownItem
              label={t('PA_LOGO_SHADOW_BLUR', 'Logo shadow blur')}
              disabled={!canEditLogo}
              rgOptions={percentOptions}
              selectedOption={logoShadowBlur}
              onChange={(option) => { dirty.current = true; setLogoShadowBlur(Number(option.data)); }}
            />

            <span className="pa-editor-hint">
              {t('PA_COMPOSER_CONTROLS_HINT', 'LB and RB adjust the size from anywhere. Closing with B saves the composition.')}
            </span>
          </Focusable>
        </div>
      </div>

    </Focusable>
  );
};

export default ArtworkComposerModal;
