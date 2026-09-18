import PluginErrorBoundary from './components/PluginErrorBoundary';
import { createFrontendDiagnostics } from './utils/frontendDiagnostics';
import { ARTWORKS_BUILD } from './utils/build';
import { definePlugin, quickAccessMenuClasses } from '@decky/ui';
import { routerHook } from '@decky/api';

import QuickAccessSettings from './components/qam-contents/QuickAccessSettings';
import MenuIcon from './components/Icons/MenuIcon';
import { SGDBProvider } from './hooks/useSGDB';
import { SettingsProvider } from './hooks/useSettings';
import SGDBPage from './components/plugin-pages/SGDBPage';
import contextMenuPatch from './patches/contextMenuPatch';
import { removeStyles } from './utils/styleInjector';
import { applyCachedLayout, refreshLayoutPatches, stopLayoutPatches } from './patches/layoutPatchController';
import { updateSquareLibraryRoute } from './patches/squareLibraryPatch';
import { attachHomeCarousel, homeUsesRouteScope, updateHomeRoute } from './patches/homePatch';
import { guardAfterRoute, startLayoutGuard, stopLayoutGuard } from './patches/layoutGuard';
import log, { startLogging, stopLogging } from './utils/log';
import { startRuntime, stopRuntime } from './utils/runtimeLifecycle';
import { steamHref, steamPath } from './utils/steamRoute';
import { cancelBulkArtworkJob } from './utils/bulkJobStore';
import {
  applyCachedInstantLibraryScroll,
  refreshInstantLibraryScroll,
  stopInstantLibraryScroll,
} from './patches/instantLibraryScroll';
import {
  applyCachedDisableLibraryLetterHold,
  refreshDisableLibraryLetterHold,
  stopDisableLibraryLetterHold,
} from './patches/disableLibraryLetterHold';

import { applyCachedHomeRecentCover, refreshHomeRecentCover, stopHomeRecentCover } from './patches/homeRecentCover';
import { startLibraryPreload, stopLibraryPreload } from './patches/libraryPreload';

const ROUTE = '/playhub-artworks/:appid/:assetType?';
const RUNTIME_CLEANUP = '__playhubArtworksRuntimeCleanup';

export default definePlugin(() => {
  let cleaned = false;
  const routeTimers = new Set<number>();
  try {
    (window as any)[RUNTIME_CLEANUP]?.();
  } catch (_) {
    // The previous Steam view is already gone.
  }

  startRuntime();
  startLogging();
  const diagnostics = createFrontendDiagnostics();

  // Register the cached asset choice before unrelated UI and backend setup.
  applyCachedHomeRecentCover();
  log('plugin mounted', { build: ARTWORKS_BUILD, href: steamHref(), path: steamPath(), language: navigator.language });

  routerHook.addRoute(ROUTE, () => (
    <PluginErrorBoundary area="artwork-page">
      <SettingsProvider>
        <SGDBProvider><SGDBPage /></SGDBProvider>
      </SettingsProvider>
    </PluginErrorBoundary>
  ), {
    exact: true,
  });

  let menuPatches: ReturnType<typeof contextMenuPatch> | undefined;

  try {
    menuPatches = contextMenuPatch();
  } catch (error) {
    log('context menu patch failed', error);
  }

  let lastRoute = steamPath();
  let nextMenuCheck = 0;
  const routeWatcher = window.setInterval(() => {
    if (cleaned) return;
    diagnostics.sync();
    if (Date.now() >= nextMenuCheck) {
      nextMenuCheck = Date.now() + 3000;
      try { menuPatches?.ensure(); } catch { /* Lazy library chunk not ready. */ }
    }
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
        for (const delay of [500, 1400]) {
          const timer = window.setTimeout(() => {
            routeTimers.delete(timer);
            if (!cleaned) attachHomeCarousel();
          }, delay);
          routeTimers.add(timer);
        }
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
    log('cached layout skipped', error);
  }
  try {
    applyCachedInstantLibraryScroll();
  } catch (error) {
    log('cached instant library scroll skipped', error);
  }
  try {
    applyCachedDisableLibraryLetterHold();
  } catch (error) {
    log('cached disable library letter hold skipped', error);
  }

  void refreshHomeRecentCover();
  startLibraryPreload();
  startLayoutGuard();
  void (async () => {
    try {
      await refreshLayoutPatches(true);
    } catch (error) {
      log('layout patches skipped', error);
    }
    if (cleaned) return;
    try {
      await refreshInstantLibraryScroll();
    } catch (error) {
      log('instant library scroll skipped', error);
    }
    if (cleaned) return;
    try {
      await refreshDisableLibraryLetterHold();
    } catch (error) {
      log('disable library letter hold skipped', error);
    }
    if (cleaned) return;
    /*
      Steam is still building itself for several seconds after a cold start, so the layout
      is verified again and again over the first minute rather than trusted once.
    */
    startLayoutGuard();
  })();

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    log('plugin dismounted');
    stopRuntime();
    try { cancelBulkArtworkJob(); } catch (_) { /* Continue independent teardown. */ }
    window.clearInterval(routeWatcher);
    routeTimers.forEach(timer => window.clearTimeout(timer));
    routeTimers.clear();
    try { stopLayoutGuard(); } catch (_) { /* Continue independent teardown. */ }
    try { diagnostics.stop(); } catch { /* A Steam window may already be closed. */ }
    try { routerHook.removeRoute(ROUTE); } catch (_) { /* Route may already be removed. */ }
    try { menuPatches?.unpatch(); } catch (_) { /* already gone */ }
    try { stopHomeRecentCover(); } catch (_) { /* Continue independent teardown. */ }
    try { stopLibraryPreload(); } catch (_) { /* Continue independent teardown. */ }
    try { stopLayoutPatches(); } catch (_) { /* already gone */ }
    try { stopInstantLibraryScroll(); } catch (_) { /* already gone */ }
    try { stopDisableLibraryLetterHold(); } catch (_) { /* already gone */ }

    stopLogging();
    removeStyles(
      'sgdb-square-capsules-library',
      'playhub-artworks-square-game-info',
      'sgdb-square-capsules-home',
      'sgdb-carousel-logo',
      'playhub-artworks-home-fit',
      'playhub-artworks-home-hero-center'
    );
  };
  (window as any)[RUNTIME_CLEANUP] = cleanup;

  return {
    title: <div className={quickAccessMenuClasses?.Title}>Playhub Artworks</div>,
    content: <PluginErrorBoundary area="quick-access"><SettingsProvider><QuickAccessSettings /></SettingsProvider></PluginErrorBoundary>,
    icon: <MenuIcon />,
    onDismount() {
      cleanup();
      if ((window as any)[RUNTIME_CLEANUP] === cleanup) {
        delete (window as any)[RUNTIME_CLEANUP];
      }
    },
  };
});
