// SPDX-License-Identifier: GPL-3.0-or-later
import { call } from '@decky/api';
import getCurrentSteamUserId from './getCurrentSteamUserId';
import { fillAutomaticArtwork, type AutomaticGame } from './automaticArtwork';
import { isRuntimeActive } from './runtimeLifecycle';
type Proof = AutomaticGame & { steam64: string };
type Job = { identity: string; attempts: number; nextAt: number; done: boolean };
type Journal = { schema: 1; seen: number[]; jobs: Record<string, Job> };
const USER_BASE = 76561197960265728n;
const validId = (id: number) => Number.isInteger(id) && id > 0 && id <= 0xffffffff;
function user() {
  const steam64 = getCurrentSteamUserId(true);
  if (!/^\d{17}$/.test(steam64) || BigInt(steam64) <= USER_BASE || BigInt(steam64) > USER_BASE + 0xffffffffn) throw Error('PA_AUTO_ARTWORK_UNKNOWN');
  return { steam64, steamUser: (BigInt(steam64) - USER_BASE).toString() };
}
const overview = (id: number) => window.appStore?.GetAppOverviewByAppID?.(id) as any;
const validName = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 2048 && !/[\u0000-\u001f]/.test(value);
export function automaticInventory(): { known: boolean; apps: any[] } {
  const store = window.appStore as any, apps = new Map<number, any>(); let known = false;
  const collect = (source: any) => {
    if (typeof source?.forEach !== 'function') return;
    known = true;
    source.forEach((entry: any) => { const id = Number(entry?.appid); if (!validId(id)) return; const current = overview(id); if (!current || Number(current.appid) !== id) return; if ([1, 1073741824].includes(Number(current.app_type)) && current.visible_in_game_list !== false) apps.set(id, current); });
  };
  try { collect(store?.allApps); collect(store?.m_mapAppOverview); } catch { known = false; }
  return { known: known && apps.size > 0 && apps.size <= 20000, apps: [...apps.values()] };
}
async function details(appid: number): Promise<any> {
  const apps = SteamClient.Apps as any;
  if (typeof apps?.RegisterForAppDetails !== 'function') throw Error('PA_AUTO_ARTWORK_UNKNOWN');
  return new Promise((resolve, reject) => {
    let registration: any, done = false;
    const finish = (value?: any) => { if (done) return; done = true; clearTimeout(timer); registration?.unregister?.(); value ? resolve(value) : reject(Error('PA_AUTO_ARTWORK_UNKNOWN')); };
    const timer = setTimeout(() => finish(), 2500);
    try { registration = apps.RegisterForAppDetails(appid, (value: any) => { if (value?.unAppID === appid && [value.strShortcutExe, value.strShortcutLaunchOptions, value.strShortcutStartDir].every(field => typeof field === 'string' && field.length <= 32768)) finish(value); }); if (done) registration?.unregister?.(); }
    catch { finish(); }
  });
}
export async function automaticIdentity(appid: number): Promise<Proof | null> {
  try {
    const owner = user(), item = overview(appid), apps = SteamClient.Apps;
    if (!item || Number(item.appid) !== appid || !validName(item.display_name) || ![1, 1073741824].includes(Number(item.app_type))) return null;
    // Native overviews are observable mutable objects. Capture scalar identity
    // before awaiting details; comparing two references would miss a rename.
    const displayName = item.display_name, appType = item.app_type;
    const hasOfficialIcon = [item.icon_hash, item.icon_data].some(value => typeof value === 'string' && value.length > 0);
    const is_shortcut = Number(appType) === 1073741824, native = is_shortcut ? await details(appid) : null;
    const after = overview(appid);
    if (user().steam64 !== owner.steam64 || SteamClient.Apps !== apps || after?.display_name !== displayName || after?.app_type !== appType) return null;
    const bytes = new TextEncoder().encode(JSON.stringify([owner.steam64, appid, displayName, appType, native?.strShortcutExe, native?.strShortcutLaunchOptions, native?.strShortcutStartDir]));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    if (user().steam64 !== owner.steam64 || SteamClient.Apps !== apps || overview(appid)?.display_name !== displayName || overview(appid)?.app_type !== appType) return null;
    return { ...owner, appid, display_name: displayName, is_shortcut, hasOfficialIcon: !is_shortcut && hasOfficialIcon, identity: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('') };
  } catch { return null; }
}
function loadJournal(value: any): Journal {
  if (value == null) return { schema: 1, seen: [], jobs: {} };
  if (value.schema !== 1 || !Array.isArray(value.seen) || value.seen.length > 20000 || !value.seen.every(validId) || !value.jobs || typeof value.jobs !== 'object' || Object.keys(value.jobs).length > 20000) throw Error('PA_AUTO_ARTWORK_UNKNOWN');
  for (const [id, record] of Object.entries(value.jobs) as [string, Job][]) {
    if (!validId(Number(id)) || !/^[a-f0-9]{64}$/.test(record?.identity) || !Number.isInteger(record.attempts) || record.attempts < 0 || record.attempts > 3 || !Number.isFinite(record.nextAt) || typeof record.done !== 'boolean') throw Error('PA_AUTO_ARTWORK_UNKNOWN');
  }
  return value;
}
export function startAutomaticArtwork() {
  let alive = true, busy = false, owner = '', journal: Journal | undefined, controller = new AbortController();
  const current = (account: string) => { try { return alive && isRuntimeActive() && user().steam64 === account; } catch { return false; } };
  const save = async (account: string) => { if (current(account) && journal) await call<[string, Journal], void>('set_setting', 'automatic_artwork_v2_' + account, journal); };
  const tick = async () => {
    if (!alive || !isRuntimeActive()) return;
    if (busy) { try { if (user().steam64 !== owner) controller.abort(); } catch { controller.abort(); } return; }
    busy = true;
    try {
      const account = user().steam64;
      if (owner !== account) { controller.abort(); controller = new AbortController(); journal = undefined; owner = account; }
      if (await call<[string, boolean], boolean>('get_setting', 'automatic_artwork_enabled', true) !== true || !current(account)) return;
      const inventory = automaticInventory(); if (!inventory.known) return;
      if (!journal) { const loaded = await call<[string, null], unknown>('get_setting', 'automatic_artwork_v2_' + account, null); if (!current(account)) return; journal = loadJournal(loaded); }
      const seen = new Set(journal.seen), eligible: any[] = [];
      for (const app of inventory.apps) {
        const fresh = !seen.has(app.appid), shortcut = Number(app.app_type) === 1073741824;
        let installed = false; try { installed = app.BIsInstalled?.() === true; } catch { /* Unknown does not grant a bulk write. */ }
        if (journal.jobs[String(app.appid)]?.done === false || installed || fresh && shortcut) eligible.push(app);
        // A newly added shortcut remains unseen until its real native identity
        // has been durably queued, so a burst of imports cannot lose all but one.
        if (!(fresh && shortcut && !journal.jobs[String(app.appid)])) seen.add(app.appid);
      }
      // Baseline known IDs first; a restart never replays a full library batch.
      if (seen.size !== journal.seen.length) { journal.seen = [...seen].slice(-20000); await save(account); }
      let selected: { proof: Proof; job: Job } | undefined;
      eligible.sort((a, b) => Number(!seen.has(b.appid)) - Number(!seen.has(a.appid)));
      for (const app of eligible) {
        if (!current(account)) return;
        const old = journal.jobs[String(app.appid)];
        if (old && (old.done || old.attempts >= 3 || old.nextAt > Date.now())) continue;
        const proof = await automaticIdentity(app.appid); if (!proof || proof.steam64 !== account) continue;
        const job = old?.identity === proof.identity ? old : { identity: proof.identity, attempts: 0, nextAt: 0, done: false };
        journal.jobs[String(app.appid)] = job; seen.add(app.appid); journal.seen = [...seen].slice(-20000); selected = { proof, job }; break;
      }
      if (!selected || !current(account)) return;
      const { proof, job } = selected;
      job.attempts++; job.nextAt = Date.now() + [60000, 300000, 1800000][job.attempts - 1]; await save(account);
      const shape = await call<[string, string], unknown>('get_setting', 'library_cover_format', 'portrait');
      if (!current(account) || !['square', 'portrait'].includes(String(shape))) return;
      const timer = setTimeout(() => controller.abort(), 180000);
      try {
        const result = await fillAutomaticArtwork(proof, shape as 'square' | 'portrait', controller.signal, async () => current(account) && (await automaticIdentity(proof.appid))?.identity === proof.identity);
        if (current(account) && journal.jobs[String(proof.appid)] === job) { job.done = result.complete; await save(account); }
      } catch { /* Bounded persisted retry; no startup errors/toast storm. */ }
      finally { clearTimeout(timer); if (controller.signal.aborted && current(account)) controller = new AbortController(); }
    } catch { /* Account, backend, inventory or local artwork is unknown. */ }
    finally { busy = false; }
  };
  const timer = setInterval(() => void tick(), 3000);
  const retry = () => { if (!journal) return; for (const job of Object.values(journal.jobs)) if (!job.done) { job.attempts = 0; job.nextAt = 0; } void tick(); };
  window.addEventListener('online', retry);
  void tick();
  return () => { alive = false; controller.abort(); clearInterval(timer); window.removeEventListener('online', retry); };
}
