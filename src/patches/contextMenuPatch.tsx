import {
  afterPatch,
  fakeRenderComponent,
  findInReactTree,
  findModuleByExport,
  Export,
  MenuItem,
  Navigation,
  Patch,
  findInTree,
} from '@decky/ui';
import { FC } from 'react';

// Always add before "Properties..."
const spliceArtworkItem = (children: any[], appid: number) => {
  children.find((x: any) => x?.key === 'properties');
  const found = children.findIndex((item) =>
    findInReactTree(item, (x) => x?.onSelected && x.onSelected.toString().includes('AppProperties'))
  );
  // findIndex returns -1 when Steam renamed the entry; -1 would splice before the last item.
  const propertiesMenuItemIdx = found >= 0 ? found : children.length;
  children.splice(propertiesMenuItemIdx, 0, (
    <MenuItem
      key="playhub-artworks-change-artwork"
      onSelected={() => {
        Navigation.Navigate(`/playhub-artworks/${appid}`);
      }}
    >
      Playhub Artworks
    </MenuItem>
  ));
};

// Check if correct menu by looking at the code of the onSelected function
// Should be enough to ignore the screenshots and other menus.
const isOpeningAppContextMenu = (items: any[]) => {
  if (!items?.length) {
    return false;
  }
  return !!findInReactTree(items, (x) => x?.props?.onSelected && x?.props?.onSelected.toString().includes('launchSource'));
};

const handleItemDupes = (items: any[]) => {
  const sgdbIdx = items.findIndex((x: any) => x?.key === 'playhub-artworks-change-artwork');
  if (sgdbIdx != -1) items.splice(sgdbIdx, 1);
};

const patchMenuItems = (menuItems: any[], appid: number) => {
  let updatedAppid: number = appid;
  // find the first menu component that has the correct appid, sometimes the one passed is cached from another context menu
  const parentOverview = menuItems.find((x: any) => x?._owner?.pendingProps?.overview?.appid &&
    x._owner.pendingProps.overview.appid !== appid
  );
  // if found then use that appid
  if (parentOverview) {
    updatedAppid = parentOverview._owner.pendingProps.overview.appid;
  }
  // Oct 2025 client
  if (updatedAppid === appid) {
    const foundApp = findInTree(menuItems, (x) => x?.app?.appid, { walkable: ['props', 'children'] });
    if (foundApp) {
      updatedAppid = foundApp.app.appid;
    }
  }
  spliceArtworkItem(menuItems, updatedAppid);
};

/*
  Everything patched here lives on a *shared class prototype* inside Steam's own JS
  context, which outlives this bundle. Two separate ways of stacking wrappers on it both
  ended with `patch.original.call is not a function` and a dead Steam library:

  1. patching `render` / `shouldComponentUpdate` inside a callback that runs on every
     render of the menu;
  2. patching again on every plugin mount. Decky hot-reloads the plugin whenever its
     files change, so a development session adds one layer per reload - which is exactly
     what the crash trace showed, one repeated frame per deploy.

  The guard is stored on the prototype itself, so it survives a bundle reload: an earlier
  patch is undone before a new one is installed, and there is never more than one layer.
*/
const PATCH_MARKER = '__playhubArtworksContextMenuPatch';

const takeOverPrototype = (prototype: any): void => {
  const previous = prototype?.[PATCH_MARKER];
  if (!previous) return;
  try {
    previous.outer?.unpatch?.();
    previous.inner?.unpatch?.();
  } catch (_) {
    // The previous bundle is gone; the marker is cleared either way.
  }
  delete prototype[PATCH_MARKER];
};

const patchedPrototypes = new WeakSet<object>();

/**
 * Patches the game context menu.
 * @param LibraryContextMenu The game context menu.
 * @returns A patch to remove when the plugin dismounts.
 */
const contextMenuPatch = (LibraryContextMenu: any) => {
  const patches: {
    outer?: Patch,
    inner?: Patch,
    unpatch: () => void;
  } = { unpatch: () => {return null;} };
  // Undo whatever a previous mount of this plugin left behind.
  takeOverPrototype(LibraryContextMenu.prototype);

  if (typeof LibraryContextMenu?.prototype?.render !== 'function') return patches;

  patches.outer = afterPatch(LibraryContextMenu.prototype, 'render', (_: Record<string, unknown>[], component: any) => {
    if (!component) return component;
    let appid: number = 1018880;
    if (component._owner?.pendingProps?.overview?.appid) {
      appid = component._owner.pendingProps.overview.appid;
    } else {
      // Oct 2025 client
      const foundApp = findInTree(component?.props?.children, (x) => x?.app?.appid, { walkable: ['props', 'children'] });
      if (foundApp) {
        appid = foundApp.app.appid;
      }
    }

    if (!patches.inner) {
      patches.inner = afterPatch(component, 'type', (_: any, ret: any) => {
        const prototype = ret?.type?.prototype;
        if (!prototype || patchedPrototypes.has(prototype)) return ret;
        patchedPrototypes.add(prototype);

        /*
          THE library crash. `afterPatch` stores `object[property]` as `patch.original`
          and later does `patch.original.call(...)`. On current Steam clients this menu
          class does NOT define `shouldComponentUpdate` on its prototype, so the stored
          original was `undefined` - and the first time React asked the component whether
          it should update, Steam died with `patch.original.call is not a function` and
          the whole library route went to the error page.

          A property that is not a function is given a real default first, so the patch
          always has something callable to wrap.
        */
        if (typeof prototype.shouldComponentUpdate !== 'function') {
          prototype.shouldComponentUpdate = function () { return true; };
        }
        if (typeof prototype.render !== 'function') {
          patchedPrototypes.delete(prototype);
          return ret;
        }

        // initial render
        afterPatch(prototype, 'render', (_: any, ret2: any) => {
          const menuItems = ret2?.props?.children?.[0]; // always the first child
          if (!Array.isArray(menuItems) || !isOpeningAppContextMenu(menuItems)) return ret2;
          try {
            handleItemDupes(menuItems);
          } catch (error) {
            return ret2;
          }
          patchMenuItems(menuItems, appid);
          return ret2;
        });

        // when steam decides to refresh app overview
        afterPatch(prototype, 'shouldComponentUpdate', ([nextProps]: any, shouldUpdate: any) => {
          try {
            if (!Array.isArray(nextProps?.children)) return shouldUpdate;
            handleItemDupes(nextProps.children);
          } catch (error) {
            // wrong context menu (probably)
            return shouldUpdate;
          }

          if (shouldUpdate === true) {
            patchMenuItems(nextProps.children, appid);
          }

          return shouldUpdate;
        });
        return ret;
      });
    } else if (Array.isArray(component?.props?.children)) {
      try {
        handleItemDupes(component.props.children);
        spliceArtworkItem(component.props.children, appid);
      } catch (_) {
        // Not the app context menu; leave it untouched.
      }
    }
    return component;
  });
  (LibraryContextMenu.prototype as any)[PATCH_MARKER] = patches;

  patches.unpatch = () => {
    try { patches.outer?.unpatch(); } catch (_) { /* already gone */ }
    try { patches.inner?.unpatch(); } catch (_) { /* already gone */ }
    if ((LibraryContextMenu.prototype as any)[PATCH_MARKER] === patches) {
      delete (LibraryContextMenu.prototype as any)[PATCH_MARKER];
    }
  };
  return patches;
};

/**
 * Game context menu component.
 */
export const LibraryContextMenu = fakeRenderComponent(
  Object.values(
    findModuleByExport((e: Export) => e?.toString && e.toString().includes('().LibraryContextMenu'))
  ).find((sibling) => (
    sibling?.toString().includes('navigator:')
  )) as FC
).type;

export default contextMenuPatch;
