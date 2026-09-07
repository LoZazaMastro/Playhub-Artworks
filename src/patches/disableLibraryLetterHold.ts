import { call } from '@decky/api';
import { findSP, GamepadButton } from '@decky/ui';

import { appportraitClasses, gamepadLibraryClasses, sel } from '../static-classes';
import log from '../utils/log';
import { isSquareLibraryRoute } from '../utils/steamRoute';

const SETTING_KEY = 'disable_library_letter_hold';
const CACHE_KEY = 'playhub_artworks_disable_library_letter_hold';
const REBIND_INTERVAL_MS = 2000;

type SteamGamepadEvent = Event & {
  detail?: {
    button?: number;
    source?: number;
    is_repeat?: boolean;
  };
};

let enabled = false;
let boundDocument: Document | null = null;
let rebindTimer: number | undefined;
let loggedDispatchFailure = false;

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

const isLibraryGame = (target: EventTarget | null): target is HTMLElement => {
  if (!enabled || !isSquareLibraryRoute()) return false;
  const element = target as HTMLElement | null;
  if (!element?.closest) return false;

  const librarySelector = sel(gamepadLibraryClasses, 'GamepadLibrary');
  const gameSelector = sel(appportraitClasses, 'LibraryItemBox');
  if (!librarySelector || !gameSelector) return false;

  const game = element.closest(gameSelector);
  return Boolean(game?.closest(librarySelector));
};

const isRepeatedVerticalDirection = (event: SteamGamepadEvent): boolean =>
  event.detail?.is_repeat === true
  && (event.detail.button === GamepadButton.DIR_UP
    || event.detail.button === GamepadButton.DIR_DOWN);

const resetSteamFastScrollHold = (event: Event) => {
  const gamepadEvent = event as SteamGamepadEvent;
  if (!isRepeatedVerticalDirection(gamepadEvent) || !isLibraryGame(event.target)) return;

  const target = event.target as HTMLElement;
  const view = target.ownerDocument.defaultView;
  if (!view) return;

  try {
    /*
      Steam's AppGridFastScroll hook opens the letter index after five repeated Up/Down
      button-down events. A matching button-up resets only that private hold counter.
      Sending the reset before each repeat keeps Steam's normal directional event intact,
      so focus can continue moving while the alphabetical shortcut never activates.
    */
    target.dispatchEvent(new view.CustomEvent('vgp_onbuttonup', {
      bubbles: true,
      cancelable: true,
      detail: {
        button: gamepadEvent.detail?.button,
        source: gamepadEvent.detail?.source,
        is_repeat: false,
      },
    }));
  } catch (error) {
    if (!loggedDispatchFailure) {
      loggedDispatchFailure = true;
      log('disable library letter hold failed', error);
    }
  }
};

const unbindDocument = () => {
  boundDocument?.removeEventListener('vgp_onbuttondown', resetSteamFastScrollHold, true);
  boundDocument = null;
};

const bindCurrentDocument = () => {
  const doc = currentView()?.document ?? null;
  if (doc === boundDocument) return;
  unbindDocument();
  if (!enabled || !doc) return;
  doc.addEventListener('vgp_onbuttondown', resetSteamFastScrollHold, true);
  boundDocument = doc;
};

const start = () => {
  bindCurrentDocument();
  if (rebindTimer !== undefined) window.clearInterval(rebindTimer);
  rebindTimer = window.setInterval(bindCurrentDocument, REBIND_INTERVAL_MS);
};

export const setDisableLibraryLetterHold = (value: boolean) => {
  enabled = value;
  loggedDispatchFailure = false;
  writeCachedSetting(value);
  if (value) {
    start();
    return;
  }
  stopDisableLibraryLetterHold();
};

export const applyCachedDisableLibraryLetterHold = (): boolean => {
  const cached = readCachedSetting();
  if (cached === null) return false;
  setDisableLibraryLetterHold(cached);
  return true;
};

export const refreshDisableLibraryLetterHold = async () => {
  let stored = false;
  try {
    stored = Boolean(await call<[string, boolean], boolean>('get_setting', SETTING_KEY, false));
  } catch (error) {
    log('disable library letter hold setting unavailable', error);
    const cached = readCachedSetting();
    if (cached !== null) stored = cached;
  }
  setDisableLibraryLetterHold(stored);
};

export const stopDisableLibraryLetterHold = () => {
  enabled = false;
  unbindDocument();
  if (rebindTimer !== undefined) {
    window.clearInterval(rebindTimer);
    rebindTimer = undefined;
  }
};
