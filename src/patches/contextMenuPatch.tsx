import * as React from "react";
import * as DeckyUI from "@decky/ui";
import { insertPluginSection, installMenuSectionFallback } from "../pluginMenuSection";
import { applyHookStubs, removeHookStubs, findModuleByExport, MenuItem, Navigation } from '@decky/ui';
import { cloneElement, isValidElement } from 'react';
import log from '../utils/log';

const ITEM_KEY = 'playhub-artworks-change-artwork';
const PATCH_MARKER = '__playhubArtworksContextMenuPatch';

/** Lazy: Steam loads the library chunk after the plugin on some startup paths. */
export const resolveLibraryContextMenu = (): any => {
  try {
    const module = findModuleByExport((value: any) =>
      typeof value === 'function' && Function.prototype.toString.call(value).includes('.LibraryContextMenu'));
    if (!module) return undefined;
    for (const value of Object.values(module)) {
      if (typeof value !== 'function') continue;
      if (!Function.prototype.toString.call(value).includes('navigator:')) continue;
      // DFL's fakeRenderComponent does not restore hook stubs if the factory
      // throws. Never leave Steam's global dispatcher in discovery/test mode.
      if (typeof applyHookStubs !== 'function' || typeof removeHookStubs !== 'function') return undefined;
      let stubbed = false;
      try {
        const hooks = applyHookStubs();
        stubbed = true;
        const type = (value as any)(hooks)?.type;
        if (typeof type?.prototype?.render === 'function') return type;
      } catch { /* This export is not the game-menu factory. */ }
      finally { if (stubbed) removeHookStubs(); }
    }
  } catch { /* Library module not ready; ensure() retries without breaking import. */ }
  return undefined;
};

/** Clone the menu (including Steam's nested Properties fragment), never mutate it. */
export const injectArtworkMenuItem = (tree: any, appid: number): any => {
  return insertPluginSection(React, tree,
    <MenuItem key={ITEM_KEY} onSelected={() => Navigation.Navigate(`/playhub-artworks/${appid}`)}>Playhub Artworks</MenuItem>);

};

/** Patch only the game-specific class, not Steam's shared generic Menu prototype. */
const contextMenuPatch = (initialType?: any) => {
  const stopFallback = installMenuSectionFallback(React, DeckyUI, injectArtworkMenuItem);
  let disposed = false;
  let installed: { prototype: any; descriptor: PropertyDescriptor; wrapped: (...args: any[]) => any } | undefined;
  const handle = {
    ensure: (): boolean => {
      if (disposed) return false;
      if (installed) return true;
      const type = initialType ?? resolveLibraryContextMenu();
      const prototype = type?.prototype;
      if (!prototype) return false;
      const previous = prototype[PATCH_MARKER];
      try {
        if (previous?.unpatch) previous.unpatch();
        else { previous?.outer?.unpatch?.(); previous?.inner?.unpatch?.(); }
      } catch { return false; }
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'render');
      if (!descriptor?.configurable || typeof descriptor.value !== 'function') return false;
      const original = descriptor.value;
      const wrapped = function (this: any, ...args: any[]) {
        const tree = original.apply(this, args);
        try {
          const apps = typeof this.GetTargetApps === 'function' ? this.GetTargetApps() : [this.props?.overview];
          if (!Array.isArray(apps) || apps.length !== 1) return tree;
          const appid = Number(apps[0]?.appid);
          if (!Number.isInteger(appid) || appid <= 0 || appid > 0xffffffff) return tree;
          return injectArtworkMenuItem(tree, appid);
        } catch (error) { log('game menu injection skipped', error); return tree; }
      };
      try {
        Object.defineProperty(prototype, 'render', { ...descriptor, value: wrapped });
        Object.defineProperty(prototype, PATCH_MARKER, { value: handle, configurable: true });
        installed = { prototype, descriptor, wrapped };
        return true;
      } catch {
        // Roll back a partially installed wrapper when the marker cannot be written.
        try { Object.defineProperty(prototype, 'render', descriptor); } catch { /* Steam owns this object. */ }
        return false;
      }
    },
    unpatch: () => {
      disposed = true;
      stopFallback();
      if (!installed) return;
      const { prototype, descriptor, wrapped } = installed;
      // Never overwrite a newer patch installed by another owner.
      if (Object.getOwnPropertyDescriptor(prototype, 'render')?.value === wrapped) {
        Object.defineProperty(prototype, 'render', descriptor);
      }
      if (prototype[PATCH_MARKER] === handle) delete prototype[PATCH_MARKER];
      installed = undefined;
    },
  };
  handle.ensure();
  return handle;
};
export default contextMenuPatch;
