import log from './log';
import { findSteamUI } from './steamWindow';
import { ARTWORKS_BUILD } from './build';

/** Decky serves the plugin as Playhub%20Artworks, not only playhub-artworks. */
export const isArtworkSource = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  let text = value;
  try { text = decodeURIComponent(text); } catch { /* A stack need not be a valid URL. */ }
  return /playhub(?:[\s_-]|%20)+artworks/i.test(text);
};

export const reportFrontendError = (error: any, context: Record<string, unknown> = {}): void => {
  try {
    // Copy cross-window Errors into this realm and bound the stack while keeping
    // it an Error: generic diagnostic strings are deliberately truncated sooner.
    const copy = new Error(String(error?.message ?? error ?? 'Unknown frontend error').slice(0, 1000));
    copy.name = String(error?.name ?? 'Error').slice(0, 100);
    copy.stack = String(error?.stack ?? copy.stack ?? '').slice(0, 5000);
    log('frontend error', { build: ARTWORKS_BUILD, ...context }, copy);
  } catch { /* Error reporting must not crash Steam. */ }
};

/** Attach to both Shared SteamUI and the live gamepad window; never suppress errors. */
export const createFrontendDiagnostics = () => {
  const views = new Set<Window>();
  let stopped = false;
  const onError = (event: ErrorEvent) => {
    if (!isArtworkSource(event.error?.stack) && !isArtworkSource(event.filename)) return;
    reportFrontendError(event.error ?? event.message, { kind: 'window.error', source: event.filename,
      line: event.lineno, column: event.colno });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    if (isArtworkSource(event.reason?.stack)) reportFrontendError(event.reason, { kind: 'unhandledrejection' });
  };
  const detach = (view: Window) => {
    try { view.removeEventListener('error', onError); view.removeEventListener('unhandledrejection', onRejection); } catch { /* Closed. */ }
    views.delete(view);
  };
  const sync = () => {
    if (stopped) return;
    const wanted = new Set([window, findSteamUI()?.window].filter(Boolean) as Window[]);
    for (const view of views) if (!wanted.has(view)) detach(view);
    for (const view of wanted) {
      if (views.has(view)) continue;
      try {
        if (view.closed) continue;
        view.addEventListener('error', onError);
        view.addEventListener('unhandledrejection', onRejection);
        views.add(view);
      } catch { detach(view); }
    }
  };
  sync();
  return { sync, stop: () => { stopped = true; for (const view of views) detach(view); } };
};
