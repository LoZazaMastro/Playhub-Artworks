import { DialogButton, Focusable, GamepadButton, GamepadEvent, ModalRoot } from '@decky/ui';
import {
  FC, useCallback, useEffect, useMemo, useRef, useState,
} from 'react';

import getAppOverview from '../utils/getAppOverview';
import { artworkSources, useArtworkPreview } from '../utils/artworkSources';
import log from '../utils/log';
import {
  DEFAULT_LOGO_POSITION,
  hideLogo,
  isLogoHidden,
  LOGO_ANCHOR_LABEL,
  LOGO_ANCHORS,
  normalizeLogoPosition,
  readLogoPosition,
  resetLogoPosition,
  showLogo,
  writeLogoPosition,
} from '../utils/logoControl';

/*
  Why this was a trap you could not get out of.

  The root `Focusable` listened on `onButtonDown` and had no focusable content, so Steam
  never gave it focus - and an element without focus receives no gamepad events at all.
  The d-pad did nothing, LB/RB did nothing, they never appeared in the footer, and B did
  not close the modal either.

  Steam's own contract, and the one every working positioner uses:

    onGamepadDirection   the d-pad, with `is_repeat` for hold-to-accelerate
    onSecondaryButton    Y, with its footer label
    onOptionsButton      X, with its footer label
    onMenuButton         the menu button, with its footer label
    onCancel*            B
    actionDescriptionMap LB / RB, which is what puts them in the footer

  The element is focused explicitly on mount, so all of the above actually arrive.
*/

/** Where each anchor sits in the 3x3 guide, and how the logo lines up inside the frame. */
const ANCHOR_SPOT: Record<string, {
  row: number; column: number; justify: string; align: string; origin: string;
}> = {
  UpperLeft: { row: 1, column: 1, justify: 'flex-start', align: 'flex-start', origin: 'top left' },
  UpperCenter: { row: 1, column: 2, justify: 'center', align: 'flex-start', origin: 'top center' },
  CenterCenter: { row: 2, column: 2, justify: 'center', align: 'center', origin: 'center' },
  BottomLeft: { row: 3, column: 1, justify: 'flex-start', align: 'flex-end', origin: 'bottom left' },
  BottomCenter: { row: 3, column: 2, justify: 'center', align: 'flex-end', origin: 'bottom center' },
};

const LogoPositionerModal: FC<{ closeModal?: () => void; appId: number }> = ({ closeModal, appId }) => {
  const [overview, setOverview] = useState<AppStoreAppOverview | null>(null);
  const [position, setPosition] = useState<LogoPosition>({ ...DEFAULT_LOGO_POSITION });
  const [hidden, setHidden] = useState(false);
  const [guides, setGuides] = useState(true);
  const [busy, setBusy] = useState(false);

  const stageRef = useRef<any>(null);
  const ready = useRef(false);
  const writeTimer = useRef<number | undefined>(undefined);
  const latest = useRef(position);
  const hiddenRef = useRef(false);
  // Holding a direction accelerates, exactly like Steam's own editors.
  const step = useRef(0.5);

  const heroSources = useMemo(() => (overview ? artworkSources(overview, 'hero') : []), [overview]);
  const logoSources = useMemo(() => (overview ? artworkSources(overview, 'logo') : []), [overview]);
  const heroUrl = useArtworkPreview(heroSources);
  const logoUrl = useArtworkPreview(logoSources);

  useEffect(() => { latest.current = position; }, [position]);
  useEffect(() => { hiddenRef.current = hidden; }, [hidden]);

  useEffect(() => {
    void (async () => {
      setOverview(await getAppOverview(appId));
      setPosition(await readLogoPosition(appId));
      setHidden(await isLogoHidden(appId));
      ready.current = true;
    })();
  }, [appId]);

  /*
    The stage is focused explicitly once Steam has mounted it.

    Focus is what makes the difference between a working editor and a window that swallows
    every button; a single frame is not always enough, so it is attempted a few times.
  */
  useEffect(() => {
    const timers = [0, 120, 400].map((delay) => window.setTimeout(() => {
      try {
        stageRef.current?.focus?.();
      } catch (_) {
        // Not mounted yet; a later attempt will get it.
      }
    }, delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);

  const push = useCallback((value: LogoPosition) => {
    if (!ready.current || hiddenRef.current) return;
    if (writeTimer.current) window.clearTimeout(writeTimer.current);
    writeTimer.current = window.setTimeout(() => {
      writeLogoPosition(appId, value).catch((error) => log('logo position write failed', error));
    }, 140);
  }, [appId]);

  useEffect(() => () => {
    if (writeTimer.current) window.clearTimeout(writeTimer.current);
  }, []);

  const update = useCallback((change: (value: LogoPosition) => LogoPosition) => {
    setPosition((value) => {
      const updated = normalizeLogoPosition(change(value));
      push(updated);
      return updated;
    });
  }, [push]);

  const handleDirection = useCallback((event: GamepadEvent) => {
    // Accelerate while held, reset the moment the press is fresh.
    step.current = event.detail.is_repeat ? Math.min(step.current + 0.5, 4) : 0.5;
    const amount = step.current;

    switch (event.detail.button) {
    case GamepadButton.DIR_UP:
      return update((value) => ({ ...value, nHeightPct: value.nHeightPct + amount }));
    case GamepadButton.DIR_DOWN:
      return update((value) => ({ ...value, nHeightPct: value.nHeightPct - amount }));
    case GamepadButton.DIR_LEFT:
      return update((value) => ({ ...value, nWidthPct: value.nWidthPct - amount }));
    case GamepadButton.DIR_RIGHT:
      return update((value) => ({ ...value, nWidthPct: value.nWidthPct + amount }));
    default:
      return undefined;
    }
  }, [update]);

  const cycleAnchor = useCallback((direction: number) => {
    update((value) => {
      const index = LOGO_ANCHORS.indexOf(value.pinnedPosition);
      const next = (index + direction + LOGO_ANCHORS.length) % LOGO_ANCHORS.length;
      return { ...value, pinnedPosition: LOGO_ANCHORS[next] };
    });
  }, [update]);

  const handleButton = useCallback((event: GamepadEvent) => {
    const { button } = event.detail;
    if (button !== GamepadButton.BUMPER_LEFT && button !== GamepadButton.BUMPER_RIGHT) return;
    event.stopPropagation();
    cycleAnchor(button === GamepadButton.BUMPER_LEFT ? -1 : 1);
  }, [cycleAnchor]);

  const close = useCallback(() => {
    if (writeTimer.current) window.clearTimeout(writeTimer.current);
    // A hidden logo must stay hidden: never flush a visible size over it on the way out.
    if (ready.current && !hiddenRef.current) {
      void writeLogoPosition(appId, latest.current).catch(() => undefined);
    }
    closeModal?.();
  }, [appId, closeModal]);

  const reset = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await resetLogoPosition(appId);
      setHidden(false);
      setPosition(await readLogoPosition(appId));
    } finally {
      setBusy(false);
    }
  }, [appId, busy]);

  const toggleHidden = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (hidden) {
        await showLogo(appId);
        setHidden(false);
      } else {
        await hideLogo(appId);
        setHidden(true);
      }
      setPosition(await readLogoPosition(appId));
    } finally {
      setBusy(false);
    }
  }, [appId, busy, hidden]);

  const spot = ANCHOR_SPOT[position.pinnedPosition] ?? ANCHOR_SPOT.BottomLeft;

  /*
    Why this is wrapped in `ModalRoot`.

    A bare `Focusable` pushed into `showModal` is not something Steam's gamepad system ever
    gives focus to on its own: calling `.focus()` on the div does nothing, because the
    element has no focusable content for the navigation tree to land on. So no direction
    event, no LB/RB, no B - a window with no way out.

    `ModalRoot` is the container Steam's own dialogs use: it registers with the navigation
    system, it owns the cancel button, and anything focusable inside it can actually be
    reached. The stage below is a real focusable element (`DialogButton`), which is what
    guarantees the d-pad events arrive.
  */
  return (
    <ModalRoot className="pa-logo-modal" closeModal={close} onCancel={close}>
      <Focusable
        className="pa-logo-editor"
        data-pa-modal="logo"
        onGamepadDirection={handleDirection}
        onButtonDown={handleButton}
        onCancel={close}
        onCancelButton={close}
        onCancelActionDescription="Chiudi"
        onSecondaryButton={() => void toggleHidden()}
        onSecondaryActionDescription={hidden ? 'Mostra logo' : 'Nascondi logo'}
        onOptionsButton={() => setGuides((value) => !value)}
        onOptionsActionDescription={guides ? 'Nascondi guide' : 'Mostra guide'}
        onMenuButton={() => void reset()}
        onMenuActionDescription="Reimposta"
        actionDescriptionMap={{
          [GamepadButton.BUMPER_LEFT]: 'Ancoraggio precedente',
          [GamepadButton.BUMPER_RIGHT]: 'Ancoraggio successivo',
        }}
      >
        <div className="pa-logo-stage">
          {/*
            The stage itself takes the focus: a focusable element is the only thing the
            navigation tree will hand gamepad events to, and it is the artwork - no row of
            buttons down the side.
          */}
          <DialogButton
            ref={stageRef}
            className={`pa-logo-frame ${guides ? 'with-guides' : ''}`}
            onOKActionDescription="Sposta con i direzionali"
            onClick={() => setGuides((value) => !value)}
          >
            {heroUrl
              ? <img className="pa-logo-hero" src={heroUrl} alt="" />
              : <div className="pa-editor-empty">Nessuno sfondo installato per questo gioco.</div>}

            {guides && (
              <div className="pa-logo-guide" aria-hidden="true">
                {LOGO_ANCHORS.map((anchor) => {
                  const place = ANCHOR_SPOT[anchor];
                  if (!place) return null;
                  return (
                    <span
                      key={anchor}
                      className={`pa-logo-spot ${anchor === position.pinnedPosition ? 'on' : ''}`}
                      style={{ gridRow: place.row, gridColumn: place.column }}
                    />
                  );
                })}
              </div>
            )}

            <div className="pa-logo-slot" style={{ justifyContent: spot.justify, alignItems: spot.align }}>
              {logoUrl && !hidden && (
                <img
                  className={`pa-logo-image ${guides ? 'outlined' : ''}`}
                  src={logoUrl}
                  alt=""
                  style={{
                    width: `${position.nWidthPct}%`,
                    height: `${position.nHeightPct}%`,
                    objectPosition: spot.origin,
                  }}
                />
              )}
            </div>
          </DialogButton>

          <div className="pa-logo-readout">
            <strong>{LOGO_ANCHOR_LABEL[position.pinnedPosition] ?? position.pinnedPosition}</strong>
            <span>
              {position.nWidthPct.toFixed(0)}% × {position.nHeightPct.toFixed(0)}%
              {hidden ? ' · logo nascosto' : ''}
              {busy ? ' · attendi…' : ''}
            </span>
            <span className="pa-logo-hint">Direzionali: dimensione · LB/RB: ancoraggio · B: chiudi</span>
          </div>
        </div>
      </Focusable>
    </ModalRoot>
  );
};

export default LogoPositionerModal;
