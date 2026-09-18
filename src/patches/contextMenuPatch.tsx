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
  let inserted = false;
  const validType = (value: any) => typeof value === 'function' || typeof value === 'string'
    || (value && [Symbol.for('react.memo'), Symbol.for('react.forward_ref')].includes(value.$$typeof));
  const makeItem = (anchor: any) => {
    // Use the exact native item already rendered by this Steam build. An old
    // DFL export may be undefined even though Steam's own menu still works.
    const Item = validType(anchor?.type) ? anchor.type : validType(MenuItem) ? MenuItem : undefined;
    if (!Item) return undefined;
    return <Item key={ITEM_KEY} onSelected={() => Navigation.Navigate(`/playhub-artworks/${appid}`)}>
      Playhub Artworks
    </Item>;
  };
  const isProperties = (node: any) => {
    const handler = node?.props?.onSelected;
    return typeof handler === 'function' && Function.prototype.toString.call(handler).includes('AppProperties');
  };
  const visit = (node: any, depth: number): any => {
    if (depth > 24) return node;
    if (Array.isArray(node)) {
      const children: any[] = [];
      for (const child of node) {
        if (child?.key === ITEM_KEY) continue;
        if (!inserted && isProperties(child)) {
          const item = makeItem(child);
          if (item) { children.push(item); inserted = true; }
        }
        children.push(visit(child, depth + 1));
      }
      return children;
    }
    if (!isValidElement(node)) return node;
    const element: any = node;
    if (element.key === ITEM_KEY) return null;
    if (element.props?.children === undefined) return element;
    const children = element.props.children;
    // A single Properties child is legal React output too.
    if (!inserted && isProperties(children)) {
      const item = makeItem(children);
      if (item) {
        inserted = true;
        return cloneElement(element, undefined, [item, visit(children, depth + 1)]);
      }
    }
    return cloneElement(element, undefined, visit(children, depth + 1));
  };
  const result = visit(tree, 0);
  // Unknown menu contracts fail open: do not append an invalid control to an
  // arbitrary shared menu or throw during a later React render.
  return inserted ? result : tree;
};

/** Patch only the game-specific class, not Steam's shared generic Menu prototype. */
const contextMenuPatch = (initialType?: any) => {
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
