import { cloneElement, isValidElement } from 'react';
import { call, routerHook, RoutePatch } from '@decky/api';
import { afterPatch, createReactTreePatcher, findInReactTree } from '@decky/ui';

import { rerenderAfterPatchUpdate } from './patchUtils';

export const HOME_RECENT_COVER_SETTING_KEY = 'home_recent_cover';
let enabled = false;
let revision = 0;
let routePatch: RoutePatch | undefined;
const rootPatches = new Map<object, { unpatch: () => void }>();

// Steam's recent-games wrapper passes this flag to its native carousel. It controls
// both the first item's asset type and slot width; all other items remain native.
const presentRecentCover = (tree: any): any => {
  if (Array.isArray(tree)) return tree.map(presentRecentCover);
  if (!isValidElement<any>(tree)) return tree;
  const props = tree.props;
  if (Array.isArray(props.games)
    && typeof props.onItemFocus === 'function'
    && 'autoFocus' in props
    && 'showFeaturedItem' in props) {
    return cloneElement(tree, { showFeaturedItem: false });
  }
  if (!props.children) return tree;
  return cloneElement(tree, {}, presentRecentCover(props.children));
};

const descend = createReactTreePatcher(
  [
    (tree: any) => tree,
    (tree: any) => findInReactTree(tree, (node: any) =>
      node?.props && 'autoFocus' in node.props && 'showBackground' in node.props),
  ],
  (_args: any, tree: any) => enabled ? presentRecentCover(tree) : tree,
  'PlayhubHomeRecentCover',
);

export const setHomeRecentCover = (value: boolean): void => {
  revision += 1;
  enabled = value === true;
  if (enabled && !routePatch) {
    routePatch = routerHook.addPatch('/library/home', (props) => {
      const child = props.children;
      if (child && !rootPatches.has(child)) {
        rootPatches.set(child, afterPatch(child, 'type', descend));
      }
      return props;
    });
  }
  rerenderAfterPatchUpdate();
};

export const refreshHomeRecentCover = async (): Promise<void> => {
  const current = revision;
  const value = await call<[string, boolean], boolean>(
    'get_setting', HOME_RECENT_COVER_SETTING_KEY, false,
  ).catch(() => false);
  if (current === revision) setHomeRecentCover(value);
};

export const stopHomeRecentCover = (): void => {
  revision += 1;
  enabled = false;
  if (routePatch) routerHook.removePatch('/library/home', routePatch);
  routePatch = undefined;
  for (const patch of rootPatches.values()) patch.unpatch();
  rootPatches.clear();
  rerenderAfterPatchUpdate();
};
