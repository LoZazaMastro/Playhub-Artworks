'use strict';
// Real batch/reset/logo/Steam-mutation-queue code; explicit Steam and provider adapters.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../tools/typescript.cjs');
const root = path.resolve(__dirname, '..');
const compiled = new Map();

function setup(options = {}) {
  const ids = options.ids || [42001, 42002];
  const apps = ids.map((appid, index) => ({appid, display_name: `Fixture ${index}`, app_type: 1}));
  const settings = {steamgriddb_api_key: 'synthetic-test-key'};
  const heroes = new Map(), sources = new Set(), positions = new Map(), events = [], progress = [];
  const controller = new AbortController();
  for (const id of ids) {
    settings[`perfect_hero_${id}`] = true;
    settings[`perfect_hero_info_${id}`] = {origin: 'manual', withLogo: false};
    settings[`zazamastro_hero_${id}`] = {sha256: `old-${id}`};
    settings[`logo_hidden_${id}`] = true;
    settings[`logo_visible_${id}`] = false;
    settings[`logo_position_backup_${id}`] = {pinnedPosition: 'UpperCenter', nWidthPct: 62, nHeightPct: 43};
    settings[`perfect_grid_l_${id}`] = true;
    settings[`perfect_grid_l_info_${id}`] = {withLogo: false};
    settings[`nonsteam_${id}`] = {id};
    heroes.set(id, `old-${id}`); sources.add(id);
    positions.set(id, {pinnedPosition: 'BottomLeft', nWidthPct: .01, nHeightPct: .01});
  }
  if (options.seed) options.seed({settings, heroes, sources, positions, ids});
  const timers = new Set();
  const timeout = (fn, ms) => {
    const timer = setTimeout(() => {timers.delete(timer); fn();}, ms <= 180 ? 0 : ms);
    timers.add(timer); return timer;
  };
  const clearTimer = timer => {timers.delete(timer); clearTimeout(timer);};
  const window = {setTimeout: timeout, clearTimeout: clearTimer,
    appStore: {allApps: apps, GetAppOverviewByAppID: id => apps.find(app => app.appid === id)}};
  const local = (id, type) => type === 'hero' && heroes.has(id)
    ? {exists: true, source: 'custom', sha256: heroes.get(id)} : {exists: false};
  const call = async (method, ...args) => {
    events.push(['rpc', method, ...args]);
    if (method === 'get_setting') {
      if (options.readFailure && args[0] === `perfect_hero_${options.readFailure}`) throw Error('settings unavailable');
      return Object.hasOwn(settings, args[0]) ? settings[args[0]] : args[1];
    }
    if (method === 'set_setting') {settings[args[0]] = args[1]; return true;}
    if (method === 'delete_setting') {delete settings[args[0]]; return true;}
    if (method === 'get_local_asset_info') return local(...args);
    if (method === 'search_provider_assets') return [];
    if (method === 'clear_perfect_hero_state') {
      const [id, restore] = args;
      if (options.resetFailure === id) return false;
      sources.delete(id);
      for (const prefix of ['perfect_hero_', 'perfect_hero_info_', 'zazamastro_hero_']) delete settings[prefix + id];
      if (restore) {
        delete settings[`logo_position_backup_${id}`];
        settings[`logo_hidden_${id}`] = false; settings[`logo_visible_${id}`] = true;
      }
      events.push(['reset', id]);
      if (options.abortAfterReset === id) controller.abort();
      return true;
    }
    if (method === 'release_artwork_transfer') return true;
    throw Error(`Unmocked RPC ${method}`);
  };
  const SteamClient = {Apps: {
    ClearCustomArtworkForApp: async (id, type) => {
      events.push(['clear', id, type]);
      if (options.clearFailure === id) throw Error('Steam clear failed');
      assert.equal(type, 1, 'The reset must not delete covers, banners, icons, or logo files');
      heroes.delete(id);
      if (options.abortDuringClear === id) controller.abort();
    },
    SetCustomArtworkForApp: async (id, data, format, type) => {
      events.push(['set', id, type]); heroes.set(id, `new-${id}`);
    },
    SetCustomLogoPositionForApp: async (id, value) => {
      events.push(['position', id]);
      if (options.positionFailure === id) throw Error('Steam logo position failed');
      positions.set(id, JSON.parse(value).logoPosition);
    },
  }};
  window.SteamClient = SteamClient;
  const fetchNoCors = async url => {
    const id = Number(url.match(/\/(?:game|steam)\/(\d+)/)?.[1]);
    events.push(['search', id, url]);
    return {status: 200, json: async () => ({success: true, data:
      options.noAssets || !url.includes('/heroes/') ? [] : [{id: id + 1, width: 3840, height: 1240,
        author: {name: 'LoZazaMastro'}, url: `https://fixture.invalid/${id}.png`}]
    })};
  };
  const mocks = {
    '@decky/api': {call, fetchNoCors},
    'src/utils/i18n.ts': {__esModule: true, default: (key, fallback) => fallback || key, localizeError: e => e?.message || String(e)},
    'src/utils/log.ts': {__esModule: true, default: () => {}},
    'src/hooks/useSGDB.ts': {SGDB_API_BASE: 'https://fixture.invalid/api'},
    'src/utils/getAppOverview.ts': {__esModule: true, default: async id => apps.find(a => a.appid === id)},
    'src/utils/getAppDetails.ts': {__esModule: true, default: async id => ({libraryAssets: {logoPosition: positions.get(id)}})},
    'src/utils/getCustomLogoPosition.ts': {__esModule: true, default: async id => positions.get(id)},
    'src/utils/getCurrentSteamUserId.ts': {__esModule: true, default: () => '123'},
    'src/utils/artworkSources.ts': {artworkSources: () => []},
    'src/utils/artworkTransfer.ts': {
      readArtworkPayload: async url => {events.push(['download', url]); return {data: 'synthetic-image', format: 'png', sha256: 'new'};},
      readArtworkSource: async () => {throw Error('Unexpected source lookup');}, artworkPayloadUrl: () => 'unused',
    },
    'src/utils/imageSafety.ts': {
      MAX_SOURCE_DIMENSION: 32768, MAX_SOURCE_PIXELS: 100000000,
      fetchWithCancellation: async (fetcher, ...args) => fetcher(...args),
    },
    'src/utils/normalizeArtworkPayload.ts': {normalizeArtworkPayload: async payload => payload},
  };
  const cache = new Map();
  const context = vm.createContext({window, SteamClient, appStore: window.appStore, setTimeout: timeout,
    clearTimeout: clearTimer, console, URLSearchParams, AbortController});
  const load = id => {
    if (Object.hasOwn(mocks, id)) return mocks[id];
    if (cache.has(id)) return cache.get(id).exports;
    if (!compiled.has(id)) {
      let source = fs.readFileSync(path.join(root, id), 'utf8');
      if (id === 'src/utils/zazamastroBatch.ts') source += '\nexport const __test = {resetPerfectHeroForRegeneration, phasesForKind};';
      compiled.set(id, ts.transpileModule(source, {fileName: id, compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true,
      }}).outputText);
    }
    const module = {exports: {}}; cache.set(id, module);
    const requireFrom = spec => {
      if (!spec.startsWith('.')) return load(spec);
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(id), spec));
      if (!path.extname(target)) target += '.ts';
      return load(target);
    };
    const fn = vm.runInContext(`(function(module,exports,require){\n${compiled.get(id)}\n})`, context, {filename: id});
    fn(module, module.exports, requireFrom); return module.exports;
  };
  const bulk = load('src/utils/zazamastroBatch.ts');
  const run = kind => bulk.runZazaMastroBatch(kind, update => progress.push(update), 2, controller.signal);
  return {ids, settings, heroes, sources, positions, events, progress, controller, bulk, run, load,
    dispose: () => {for (const timer of timers) clearTimeout(timer); timers.clear();}};
}

const scenario = (name, options, check) => test(name, async () => {
  const h = setup(options);
  try {await check(h);} finally {h.dispose();}
});

scenario('Regenerate all: every old manual/automatic hero and state is removed before the first search', {}, async h => {
  const result = await h.run('perfectHeroReplace');
  const firstSearch = h.events.findIndex(e => e[0] === 'search');
  assert.ok(firstSearch > 0);
  for (const id of h.ids) {
    assert.ok(h.events.findIndex(e => e[0] === 'reset' && e[1] === id) < firstSearch);
    assert.ok(h.events.findIndex(e => e[0] === 'clear' && e[1] === id) < firstSearch);
    assert.equal(h.heroes.get(id), `new-${id}`);
    assert.equal(h.sources.has(id), false, 'A stale pristine source must not survive a new precomposed hero');
    assert.equal(h.settings[`perfect_hero_${id}`], true);
    assert.equal(h.settings[`perfect_hero_info_${id}`].origin, 'zazamastro');
    assert.equal(h.settings[`perfect_grid_l_${id}`], true);
    assert.equal(h.settings[`nonsteam_${id}`].id, id);
  }
  assert.equal(result.removed, 2); assert.equal(result.changed, 2); assert.equal(result.failed, 0);
  assert.equal(result.processed, 4); assert.equal(result.total, 4);
});

scenario('A missing logo after the purge leaves the old hero removed and the separate logo visible', {noAssets: true}, async h => {
  const result = await h.run('perfectHeroReplace');
  assert.equal(result.failed, 2); assert.equal(result.changed, 0); assert.equal(result.removed, 2);
  assert.equal(h.events.some(e => e[0] === 'set'), false);
  for (const id of h.ids) {
    assert.equal(h.heroes.has(id), false); assert.equal(h.sources.has(id), false);
    assert.equal(h.settings[`perfect_hero_${id}`], undefined);
    assert.equal(h.settings[`perfect_hero_info_${id}`], undefined);
    assert.equal(h.settings[`zazamastro_hero_${id}`], undefined);
    assert.equal(h.settings[`logo_hidden_${id}`], false); assert.equal(h.settings[`logo_visible_${id}`], true);
    assert.equal(h.positions.get(id).nWidthPct, 62);
  }
});

scenario('Only-missing mode preserves intact manual logo-free Perfect Heroes', {}, async h => {
  const result = await h.run('perfectHeroMissing');
  assert.equal(result.skipped, 2); assert.equal(result.changed, 0); assert.equal(result.removed, 0);
  assert.equal(h.events.some(e => ['clear', 'set', 'reset', 'search'].includes(e[0])), false);
  for (const id of h.ids) assert.equal(h.heroes.get(id), `old-${id}`);
});

scenario('Failed Steam removal stops regeneration for that game and retains retry state', {clearFailure: 42001}, async h => {
  const result = await h.run('perfectHeroReplace');
  assert.equal(result.failed, 1); assert.equal(result.changed, 1); assert.equal(result.removed, 1);
  assert.equal(h.heroes.get(42001), 'old-42001'); assert.equal(h.sources.has(42001), true);
  assert.equal(h.events.some(e => e[0] === 'search' && e[1] === 42001), false);
  assert.equal(h.settings.perfect_hero_42001, true);
});

scenario('Failed backend cleanup stops regeneration and is counted only once', {resetFailure: 42001}, async h => {
  const result = await h.run('perfectHeroReplace');
  assert.equal(result.failed, 1); assert.equal(result.changed, 1);
  assert.equal(h.events.some(e => e[0] === 'search' && e[1] === 42001), false);
  assert.equal(h.settings.perfect_hero_42001, true, 'Keep the marker for a later retry');
});

scenario('Failed settings read does not silently skip cleanup and write over an unknown state', {readFailure: 42001}, async h => {
  const result = await h.run('perfectHeroReplace');
  assert.equal(result.failed, 1); assert.equal(result.changed, 1);
  assert.equal(h.heroes.get(42001), 'old-42001');
  assert.equal(h.events.some(e => ['clear', 'search'].includes(e[0]) && e[1] === 42001), false);
});

scenario('Cancellation during Steam clear finishes that game reset but starts no download or next deletion', {abortDuringClear: 42001}, async h => {
  await assert.rejects(h.run('perfectHeroReplace'), e => e.name === 'AbortError');
  assert.equal(h.heroes.has(42001), false); assert.equal(h.sources.has(42001), false);
  assert.equal(h.settings.logo_visible_42001, true); assert.equal(h.settings.perfect_hero_42001, undefined);
  assert.equal(h.heroes.get(42002), 'old-42002'); assert.equal(h.sources.has(42002), true);
  assert.equal(h.events.some(e => e[0] === 'search'), false);
});

scenario('Cancellation after all removals starts no regeneration and keeps all removed heroes gone', {abortAfterReset: 42002}, async h => {
  await assert.rejects(h.run('perfectHeroReplace'), e => e.name === 'AbortError');
  for (const id of h.ids) {
    assert.equal(h.heroes.has(id), false); assert.equal(h.settings[`logo_visible_${id}`], true);
  }
  assert.equal(h.events.some(e => e[0] === 'search'), false);
  assert.equal(h.progress.at(-1).removed, 2);
});

scenario('A stale Zaza marker is cleared without deleting an unrelated ordinary custom hero', {
  ids: [42001], noAssets: true, seed: ({settings, heroes, sources}) => {
    delete settings.perfect_hero_42001; delete settings.perfect_hero_info_42001;
    heroes.set(42001, 'ordinary-newer-file'); sources.clear();
  },
}, async h => {
  const result = await h.run('perfectHeroReplace');
  assert.equal(result.removed, 0); assert.equal(result.failed, 1);
  assert.equal(h.heroes.get(42001), 'ordinary-newer-file');
  assert.equal(h.settings.zazamastro_hero_42001, undefined);
  assert.equal(h.events.some(e => e[0] === 'clear'), false);
  assert.equal(h.settings.logo_hidden_42001, true, 'An unrelated user-hidden logo is not forcibly shown');
});

scenario('A verified legacy Zaza marker without a perfect flag is still removed', {
  ids: [42001], noAssets: true, seed: ({settings}) => {
    delete settings.perfect_hero_42001; delete settings.perfect_hero_info_42001;
  },
}, async h => {
  const result = await h.run('perfectHeroReplace');
  assert.equal(result.removed, 1); assert.equal(h.heroes.has(42001), false);
  assert.equal(h.settings.zazamastro_hero_42001, undefined);
});

scenario('An old invisible logo-position backup is replaced with a visible default on reset', {
  ids: [42001], noAssets: true, seed: ({settings}) => {
    settings.logo_position_backup_42001 = {pinnedPosition: 'BottomLeft', nWidthPct: .01, nHeightPct: .01};
  },
}, async h => {
  await h.run('perfectHeroReplace');
  assert.equal(h.positions.get(42001).nWidthPct, 50); assert.equal(h.positions.get(42001).nHeightPct, 50);
});

scenario('A successful regeneration stores the visible logo position so a later removal restores it', {ids: [42001]}, async h => {
  await h.run('perfectHeroReplace');
  assert.equal(h.settings.logo_hidden_42001, true); assert.equal(h.settings.logo_visible_42001, false);
  assert.equal(h.settings.logo_position_backup_42001.nWidthPct, 62);
  await h.bulk.__test.resetPerfectHeroForRegeneration({appid: 42001}, h.controller.signal);
  assert.equal(h.settings.logo_visible_42001, true); assert.equal(h.positions.get(42001).nWidthPct, 62);
});

scenario('No valid marker is written if Steam cannot hide the separate logo after applying', {
  ids: [42001], positionFailure: 42001,
  seed: ({settings, heroes, sources}) => {
    for (const key of Object.keys(settings)) if (/^(perfect_hero_|perfect_hero_info_|zazamastro_hero_|logo_)/.test(key)) delete settings[key];
    heroes.clear(); sources.clear();
  },
}, async h => {
  const result = await h.run('perfectHeroMissing');
  assert.equal(result.failed, 1); assert.equal(h.settings.perfect_hero_42001, undefined);
});

test('All 31 locale files include the destructive warning and reset progress/error messages', () => {
  const files = fs.readdirSync(path.join(root, 'src/i18n')).filter(name => name.endsWith('.json'));
  assert.equal(files.length, 31);
  for (const name of files) {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'src/i18n', name), 'utf8'));
    for (const key of ['PA_REMAKE_PERFECT_HERO_DESC', 'PA_BATCH_PERFECT_HERO_RESET', 'PA_ERROR_PERFECT_HERO_RESET', 'PA_ERROR_LOGO_NOT_FOUND']) {
      assert.ok(data[key]?.length > 10, `${name}: ${key}`);
    }
    assert.ok(data.PA_PERFECT_HERO_REMOVED_COUNT.includes('{count}'), name);
  }
});

for (const legacy of [false, true]) scenario(`Hero bulk reset preserves ${legacy ? 'legacy' : 'explicit'} Banner logo ownership`, {
  ids: [42001], noAssets: true, seed: ({settings}) => {
    if (legacy) delete settings.perfect_grid_l_info_42001;
    else settings.perfect_grid_l_info_42001 = {withLogo: true};
  },
}, async h => {
  await h.bulk.__test.resetPerfectHeroForRegeneration({appid: 42001}, h.controller.signal);
  assert.equal(h.heroes.has(42001), false);
  assert.equal(h.settings.perfect_hero_42001, undefined);
  assert.equal(h.settings.perfect_grid_l_42001, true);
  assert.equal(h.settings.logo_hidden_42001, true);
  assert.equal(h.settings.logo_visible_42001, false);
  assert.equal(h.positions.get(42001).nWidthPct, .01);
  assert.equal(h.settings.logo_position_backup_42001.nWidthPct, 62);
  assert.equal(h.events.some(e => e[0] === 'position'), false);
  assert.ok(h.events.some(e => e[0] === 'rpc' && e[1] === 'clear_perfect_hero_state' && e[3] === false));
});
scenario('Hero bulk reset restores logo when remaining Banner has no baked logo', {ids: [42001], noAssets: true}, async h => {
  await h.bulk.__test.resetPerfectHeroForRegeneration({appid: 42001}, h.controller.signal);
  assert.equal(h.settings.perfect_grid_l_42001, true);
  assert.equal(h.settings.perfect_grid_l_info_42001.withLogo, false);
  assert.equal(h.settings.logo_hidden_42001, false);
  assert.equal(h.positions.get(42001).nWidthPct, 62);
  assert.ok(h.events.some(e => e[0] === 'rpc' && e[1] === 'clear_perfect_hero_state' && e[3] === true));
});
