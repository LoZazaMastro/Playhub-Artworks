import { definePlugin, quickAccessMenuClasses } from '@decky/ui';
import { routerHook } from '@decky/api';

import QuickAccessSettings from './components/qam-contents/QuickAccessSettings';
import MenuIcon from './components/Icons/MenuIcon';
import { SGDBProvider } from './hooks/useSGDB';
import { SettingsProvider } from './hooks/useSettings';
import SGDBPage from './components/plugin-pages/SGDBPage';
import contextMenuPatch, { LibraryContextMenu } from './patches/contextMenuPatch';
import { removeStyles } from './utils/styleInjector';
import { applyCachedLayout, refreshLayoutPatches, stopLayoutPatches } from './patches/layoutPatchController';
import { updateSquareLibraryRoute } from './patches/squareLibraryPatch';
import { attachHomeCarousel, homeUsesRouteScope, updateHomeRoute } from './patches/homePatch';
import { guardAfterRoute, startLayoutGuard, stopLayoutGuard } from './patches/layoutGuard';
import log from './utils/log';
import { steamHref, steamPath } from './utils/steamRoute';

const ROUTE = '/playhub-artworks/:appid/:assetType?';
const RUNTIME_CLEANUP = '__playhubArtworksRuntimeCleanup';

export default definePlugin(() => {
  try {
    (window as any)[RUNTIME_CLEANUP]?.();
  } catch (_) {
    // The previous Steam view is already gone.
  }

  log('plugin mounted', { href: steamHref(), language: navigator.language });

  routerHook.addRoute(ROUTE, () => (
    <SettingsProvider>
      <SGDBProvider>
        <SGDBPage />
      </SGDBProvider>
    </SettingsProvider>
  ), {
    exact: true,
  });

  let menuPatches: ReturnType<typeof contextMenuPatch> | undefined;

  try {
    menuPatches = contextMenuPatch(LibraryContextMenu);
  } catch (error) {
    log('context menu patch failed', error);
  }

  /*
    Anything this plugin throws is written to the diagnostic log with its stack.
    Without this a runtime error only ever showed up as a bare
    "Cannot read properties of undefined" with no way to tell where it came from.
  */
  const isOurs = (stack?: string) => Boolean(stack && /playhub-artworks/i.test(stack));
  const onError = (event: ErrorEvent) => {
    if (!isOurs(event.error?.stack) && !isOurs(event.filename)) return;
    log('uncaught error', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error?.stack,
    });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason: any = event.reason;
    if (!isOurs(reason?.stack)) return;
    log('unhandled rejection', { message: reason?.message ?? String(reason), stack: reason?.stack });
  };
  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  let lastRoute = steamPath();
  const routeWatcher = window.setInterval(() => {
    const currentRoute = steamPath();
    if (currentRoute !== lastRoute) {
      lastRoute = currentRoute;
      // The square-capsule getter reads this instead of the location on every frame.
      updateSquareLibraryRoute();
      /*
        When Steam's recents class could not be found, the Home styles are scoped to the
        route instead, so entering or leaving the Home has to re-apply them.
      */
      if (updateHomeRoute() && homeUsesRouteScope()) {
        void refreshLayoutPatches(true).catch(() => undefined);
      }
      /*
        Measure what the page actually became, a moment after Steam has laid it out.
        This is the difference between "sembra sbagliato" and knowing which rule did it.
      */
      const path = currentRoute;
      if (path.includes('/library/home')) {
        // The recents row is built a moment after the route changes.
        window.setTimeout(attachHomeCarousel, 500);
        window.setTimeout(attachHomeCarousel, 1400);
      }
      if (path.includes('/library/home') || /\/routes\/library\/?$/.test(path) || path === '/library') {
        /*
          And the safety net: measure what the covers became and put the setting back on
          if they are the wrong shape. This is what makes a fresh Big Picture start fix
          itself instead of waiting for the setting to be applied by hand.
        */
        guardAfterRoute(path);
      }
    }
  }, 500);

  /*
    Everything below talks to the backend or to Steam's class modules. A single failure here
    used to surface as `Cannot read properties of undefined` on every Decky start, so each
    step is isolated and the plugin stays usable even when one of them cannot run yet.
  */
  /*
    The remembered format goes on FIRST, in this same tick.

    Waiting for the backend to answer is what left a couple of seconds of Steam's own
    portrait covers on screen at every Big Picture start.
  */
  try {
    applyCachedLayout();
  } catch (error) {
    log('layout da cache saltato', error);
  }

  void (async () => {
    try {
      await refreshLayoutPatches(true);
    } catch (error) {
      log('layout patches skipped', error);
    }
    /*
      Steam is still building itself for several seconds after a cold start, so the layout
      is verified again and again over the first minute rather than trusted once.
    */
    startLayoutGuard();
  })();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    log('plugin dismounted');
    window.clearInterval(routeWatcher);
    stopLayoutGuard();
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
    routerHook.removeRoute(ROUTE);
    try { menuPatches?.unpatch(); } catch (_) { /* already gone */ }
    try { stopLayoutPatches(); } catch (_) { /* already gone */ }

    removeStyles(
      'sgdb-square-capsules-library',
      'playhub-artworks-square-game-info',
      'sgdb-square-capsules-home',
      'sgdb-carousel-logo',
      'playhub-artworks-home-fit'
    );
  };
  (window as any)[RUNTIME_CLEANUP] = cleanup;

  return {
    title: <div className={quickAccessMenuClasses.Title}>Playhub Artworks</div>,
    content: <SettingsProvider><QuickAccessSettings /></SettingsProvider>,
    icon: <MenuIcon />,
    onDismount() {
      cleanup();
      if ((window as any)[RUNTIME_CLEANUP] === cleanup) {
        delete (window as any)[RUNTIME_CLEANUP];
      }
    },
  };
});
