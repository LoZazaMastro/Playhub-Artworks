import { findSP } from '@decky/ui';

export interface SteamUIView { window: Window; path?: string; instance?: any }

/** Steam may use memory history while the browser URL stays /index.html. */
const routeOf = (instance: any, view: any): string => {
  try {
    const path = instance?.History?.location?.pathname;
    if (typeof path === 'string' && path.startsWith('/')) return path;
  } catch { /* A window/history can disappear during a UI restart. */ }
  try { return String(view?.location?.pathname ?? ''); } catch { return ''; }
};

/** Resolve a live MAIN gamepad view, excluding overlay/VR/keyboard windows. */
export const findSteamUI = (): SteamUIView | null => {
  const candidates: Array<SteamUIView & { score: number }> = [];
  const add = (view: any, priority: number, instance?: any) => {
    try {
      if (!view || view.closed || !view.document?.head) return;
      const path = routeOf(instance, view);
      const routed = /^\/(?:routes\/)?(?:library|gamepad|login|playhub-artworks|decky)(?:\/|$)/i.test(path);
      candidates.push({ window: view, instance, path, score: priority + (routed ? 50 : 0) });
    } catch { /* Inaccessible or already closed. */ }
  };
  try {
    const store = (window as any).SteamUIStore?.WindowStore;
    for (const instance of store?.SteamUIWindows ?? []) {
      try {
        if (instance.IsGamepadUIOverlayWindow?.() || instance.IsAnyVRWindow?.()
          || instance.IsStandaloneKeyboardWindow?.()) continue;
        const main = instance.IsMainGamepadUIWindow?.();
        if (main === true) add(instance.BrowserWindow, 200, instance);
        // Legacy loaders do not expose the more specific predicate.
        else if (main === undefined && instance.IsGamepadUIWindow?.()) add(instance.BrowserWindow, 100, instance);
      } catch { /* Continue with the other windows. */ }
    }
  } catch { /* Steam's store is still loading. */ }
  try {
    const sp: any = findSP();
    const view = sp?.window ?? sp;
    const instance = (window as any).SteamUIStore?.WindowStore?.GetWindowInstanceFromWindow?.(view);
    const unwanted = instance?.IsGamepadUIOverlayWindow?.() || instance?.IsAnyVRWindow?.()
      || instance?.IsStandaloneKeyboardWindow?.();
    if (!unwanted) add(view, 10, instance);
  } catch { /* Decky's resolver may not yet be ready. */ }
  add(window, 0);
  candidates.sort((a, b) => b.score - a.score);
  if (!candidates[0]) return null;
  const { score: _score, ...selected } = candidates[0];
  return selected;
};
