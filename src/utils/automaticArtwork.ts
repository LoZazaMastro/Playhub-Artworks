// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '@decky/api';
import { ASSET_TYPE } from '../constants';
import { automaticArtworkCandidates } from './zazamastroBatch';
import { readArtworkPayload } from './artworkTransfer';
import { runSteamArtworkTransaction } from './derivedCover';
import { isRuntimeActive } from './runtimeLifecycle';
import { resizeAutomaticLogoOnePixel } from './automaticLogoRefresh';
import { readLogoPosition,writeLogoPosition } from './logoControl';

export const AUTOMATIC_ASSETS: SGDBAssetType[] = ['grid_p', 'grid_l', 'hero', 'logo', 'icon'];
export type AutomaticGame = { appid: number; display_name: string; is_shortcut: boolean; steamUser: string; identity: string; hasOfficialIcon?: boolean };
type Status = { appid: number; steamUser: string; assets: Record<string, { exists: boolean }>; shortcutIcon?: string };
export interface AutomaticArtworkDependencies {
  current: () => Promise<boolean>;
  status: () => Promise<Status>;
  candidates: (kind: SGDBAssetType) => Promise<any[]>;
  payload: (url: string, retain: boolean) => Promise<any>;
  stageIcon: (token: string) => Promise<{ path: string }>;
  release: (token: string) => Promise<unknown>;
  transaction: typeof runSteamArtworkTransaction;
  apps: any;
  nativePresent?: (kind:SGDBAssetType)=>boolean;
  resizeLogo?: typeof resizeAutomaticLogoOnePixel;
  saveLogoPosition?: (appId:number)=>Promise<unknown>;
  logoFingerprint?: ()=>string;
}
export function automaticNativeArtworkPresent(game: AutomaticGame, kind: SGDBAssetType): boolean {
  const store = window.appStore as any, app = store?.GetAppOverviewByAppID?.(game.appid);
  if (!app || Number(app.appid) !== game.appid || app.display_name !== game.display_name) throw Error('PA_AUTO_ARTWORK_UNKNOWN');
  if (kind === 'icon') return [app.icon_hash, app.icon_data].some(value => typeof value === 'string' && value.length > 0);
  const getter = { grid_p: 'GetCustomVerticalCapsuleURLs', grid_l: 'GetCustomLandcapeImageURLs', hero: 'GetCustomHeroImageURLs', logo: 'GetCustomLogoImageURLs' }[kind];
  if (typeof store[getter] !== 'function') throw Error('PA_AUTO_ARTWORK_UNKNOWN');
  const urls = store[getter](app);
  if (!Array.isArray(urls) || !urls.every(value => typeof value === 'string')) throw Error('PA_AUTO_ARTWORK_UNKNOWN');
  return urls.some(value => value.length > 0);
}
const validStatus = (status: Status, game: AutomaticGame) => status?.appid === game.appid && status.steamUser === game.steamUser &&
  AUTOMATIC_ASSETS.every(kind => typeof status.assets?.[kind]?.exists === 'boolean');
export function automaticPayloadShape(kind: SGDBAssetType, shape: 'square' | 'portrait', dimensions: unknown) {
  if (!Array.isArray(dimensions) || dimensions.length !== 2 || !dimensions.every(value => Number.isFinite(value) && value >= 16)) return false;
  const ratio = dimensions[0] / dimensions[1];
  if (kind === 'grid_p') return shape === 'square' ? ratio >= .9 && ratio <= 1.1 : ratio >= .5 && ratio <= .8;
  if (kind === 'grid_l') return ratio >= 1.8 && ratio <= 2.4;
  if (kind === 'hero') return ratio >= 1.4 && ratio <= 4;
  if (kind === 'icon') return ratio >= .8 && ratio <= 1.25 && Math.max(...dimensions) <= 1024;
  return kind === 'logo';
}

/** Strict missing-only writes. A failed read is unknown, never permission to replace. */
export async function fillAutomaticArtwork(game: AutomaticGame, shape: 'square' | 'portrait', signal: AbortSignal,
  current: () => Promise<boolean>, dependencies?: AutomaticArtworkDependencies) {
  const deps: AutomaticArtworkDependencies = dependencies ?? {
    current, status: async () => {
      const local = await call<[number, string, boolean], Status>('get_auto_artwork_status', game.appid, game.steamUser, game.is_shortcut);
      if (!validStatus(local, game)) throw Error('PA_AUTO_ARTWORK_UNKNOWN');
      // Native state can be newer than shortcuts.vdf/grid disk flushes. A new
      // manual image in either source always wins over queued automation.
      for (const kind of AUTOMATIC_ASSETS) if (automaticNativeArtworkPresent(game, kind)) local.assets[kind].exists = true;
      return local;
    },
    candidates: kind => automaticArtworkCandidates(game, kind, shape, signal),
    payload: (url, retain) => readArtworkPayload(url, { signal, staticOnly: true, retainSource: retain }),
    stageIcon: token => call('stage_auto_shortcut_icon', game.appid, game.steamUser, token),
    release: token => call('release_artwork_transfer', token), transaction: runSteamArtworkTransaction,
    apps: SteamClient.Apps, nativePresent:kind=>automaticNativeArtworkPresent(game,kind),
    resizeLogo:resizeAutomaticLogoOnePixel,
    saveLogoPosition:async appId=>{const position=await readLogoPosition(appId);if(!await writeLogoPosition(appId,position))throw Error('PA_ERROR_INTERNAL_ARTWORK');},
    logoFingerprint:()=>{const app=window.appStore?.GetAppOverviewByAppID?.(game.appid);if(!app||app.display_name!==game.display_name)throw Error('PA_AUTO_ARTWORK_UNKNOWN');return JSON.stringify((window.appStore as any).GetCustomLogoImageURLs(app));},
  };
  const stillCurrent = async () => !signal.aborted && isRuntimeActive() && await deps.current();
  const status = async () => { const result = await deps.status(); if (!validStatus(result, game)) throw Error('PA_AUTO_ARTWORK_UNKNOWN'); return result; };
  let missing = false, changed = 0;
  for (const kind of AUTOMATIC_ASSETS) {
    if (!await stillCurrent()) throw new DOMException('Aborted', 'AbortError');
    if ((await status()).assets[kind].exists) continue;
    if (kind === 'icon' && !game.is_shortcut && game.hasOfficialIcon) continue;
    // Steam's official icon remains native. SetShortcutIcon is only defined for
    // shortcuts; an unknown official icon is not replaced through a guessed API.
    if (kind === 'icon' && !game.is_shortcut) { missing = true; continue; }
    if (typeof deps.apps?.[kind === 'icon' ? 'SetShortcutIcon' : 'SetCustomArtworkForApp'] !== 'function') { missing = true; continue; }
    let satisfied = false;
    for (const asset of (await deps.candidates(kind)).slice(0, 4)) {
      let payload: any, attemptedWrite = false;
      try {
        payload = await deps.payload(asset.url, kind === 'icon');
        if (!payload?.data || payload.animated || !automaticPayloadShape(kind, shape, payload.dimensions)) throw Error('PA_ERROR_INVALID_ARTWORK');
        if (!await stillCurrent()) throw new DOMException('Aborted', 'AbortError');
        await deps.transaction(async mutate => {
          if (!await stillCurrent()) throw new DOMException('Aborted', 'AbortError');
          if ((await status()).assets[kind].exists) { satisfied = true; return; }
          if (!await stillCurrent()) throw new DOMException('Aborted', 'AbortError');
          const perform=(operation:()=>unknown)=>{
            if(signal.aborted||!isRuntimeActive())throw new DOMException('Aborted','AbortError');
            // No await between the latest native manual choice and the Set.
            if(deps.nativePresent?.(kind)){satisfied=true;return;}
            attemptedWrite=true;return operation();
          };
          if (kind === 'icon') {
            if (!payload.transferToken || payload.format !== 'png') throw Error('PA_ERROR_INVALID_ARTWORK');
            const staged = await deps.stageIcon(payload.transferToken);
            if (!await stillCurrent()) throw new DOMException('Aborted', 'AbortError');
            if ((await status()).assets.icon.exists) { satisfied = true; return; }
            if (!await stillCurrent()) throw new DOMException('Aborted', 'AbortError');
            await mutate('Automatic icon timeout', () => perform(()=>deps.apps.SetShortcutIcon(game.appid, staged.path)));
          } else {
            await mutate('Automatic artwork timeout', () => perform(()=>deps.apps.SetCustomArtworkForApp(game.appid, payload.data, payload.format, ASSET_TYPE[kind])));
            if(kind==='logo'&&attemptedWrite){
              // Existing/manual logos never reach this branch. Revalidate the
              // same Steam account and shortcut after decoding the new pixels.
              const fingerprint=deps.logoFingerprint?.(),refreshed=await deps.resizeLogo?.(payload,signal);
              if(!await stillCurrent())throw new DOMException('Aborted','AbortError');
              if(deps.logoFingerprint&&deps.logoFingerprint()!==fingerprint)throw new DOMException('Aborted','AbortError');
              if(refreshed)await mutate('Automatic logo refresh timeout',()=>{if(signal.aborted||!isRuntimeActive())throw new DOMException('Aborted','AbortError');return deps.apps.SetCustomArtworkForApp(game.appid,refreshed.data,refreshed.format,ASSET_TYPE.logo);});
              if(!await stillCurrent())throw new DOMException('Aborted','AbortError');
              if(deps.saveLogoPosition)await mutate('Automatic logo position timeout',()=>deps.saveLogoPosition!(game.appid));
            }
          }
          if(attemptedWrite)changed++;
          satisfied = (await status()).assets[kind].exists;
        });
        // A successful Set may become observable later. Never replace it with
        // the next image merely because native/disk readback is not flushed yet.
        if (satisfied || attemptedWrite) break;
      } catch (error: any) {
        if (attemptedWrite || signal.aborted || error?.name === 'AbortError') throw error;
        // A corrupt first image can advance to another image of the same exact
        // SGDB identity; no fallback ever changes the matched game.
      } finally { if (payload?.transferToken) await deps.release(payload.transferToken).catch(() => undefined); }
    }
    if (!satisfied) missing = true;
  }
  return { changed, complete: !missing };
}
