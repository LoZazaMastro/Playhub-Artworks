const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../tools/typescript.cjs');
const noop = () => true;
function load(file, mocks, globals = {}, suffix = '') {
  const exports = {};
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8') + suffix;
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { exports, require: name => {
    if (name.endsWith('/steamWindow')) return { findSteamUI: mocks['@decky/ui']?.findSP };
    assert.ok(name in mocks, name); return mocks[name];
  }, ...globals });
  return exports;
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function environment() {
  const listeners = new Map(), timers = new Map(); let next = 0;
  const nativeWheel = () => {};
  listeners.set('wheel', new Set([nativeWheel]));
  const doc = { addEventListener: (name, fn) => {
    if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn);
  }, removeEventListener: (name, fn) => listeners.get(name)?.delete(fn) };
  const window = { document: doc, localStorage: { getItem: () => null, setItem() {} },
    setInterval: fn => { timers.set(++next, fn); return next; }, clearInterval: id => timers.delete(id),
    setTimeout: fn => { timers.set(++next, fn); return next; }, clearTimeout: id => timers.delete(id),
    addEventListener() {}, removeEventListener() {}, cancelAnimationFrame() {} };
  return { window, listeners, timers, nativeWheel };
}
test('pending layout backend result cannot reinstall after stop; a fresh module can start', async () => {
  const pending = deferred(), events = [], env = environment();
  const mocks = { '@decky/api': { call: () => pending.promise }, '@decky/ui': { findSP: () => env },
    '../static-classes': { hasClasses: noop }, '../utils/log': { default() {} },
    './homePatch': { addHomePatch: () => { events.push('add'); return true; }, removeHomePatch: noop },
    './homeHeroPatch': { applyHomeHeroCentering: noop },
    './squareLibraryPatch': { addSquareLibraryPatch: noop, removeSquareLibraryPatch: noop },
    './homeRecentCover': { applyCachedHomeRecentCover: noop },
  };
  const api = load('src/patches/layoutPatchController.ts', mocks, env);
  const work = api.refreshLayoutPatches(true); api.stopLayoutPatches(); pending.resolve('square'); await work;
  assert.deepEqual(events, []); assert.equal(env.timers.size, 0);
  mocks['@decky/api'].call = async (_method, key, fallback) => key === 'library_cover_format' ? 'square' : fallback;
  const fresh = load('src/patches/layoutPatchController.ts', mocks, env);
  await fresh.refreshLayoutPatches(true); assert.deepEqual(events, ['add']);
  fresh.stopLayoutPatches();
});
for (const [file, refresh, stop, enable] of [
  ['instantLibraryScroll', 'refreshInstantLibraryScroll', 'stopInstantLibraryScroll', 'setInstantLibraryScroll'],
  ['disableLibraryLetterHold', 'refreshDisableLibraryLetterHold', 'stopDisableLibraryLetterHold', 'setDisableLibraryLetterHold'],
]) test(`${file}: pending response cannot restore listeners; native wheel survives cleanup`, async () => {
  const env = environment(), pending = deferred();
  const mocks = { '@decky/api': { call: () => pending.promise }, '@decky/ui': { findSP: () => env, GamepadButton: {} },
    '../static-classes': {}, '../utils/log': { default() {} }, '../utils/steamRoute': { isSquareLibraryRoute: noop } };
  const api = load(`src/patches/${file}.ts`, mocks, env);
  api[enable](true); assert.equal(env.timers.size, 1);
  const work = api[refresh](); api[stop](); pending.resolve(true); await work;
  assert.equal(env.timers.size, 0);
  assert.deepEqual([...env.listeners.entries()].filter(([name, values]) => name !== 'wheel' && values.size), []);
  assert.deepEqual([...env.listeners.get('wheel')], [env.nativeWheel]);
});
test('style cleanup removes both original and recreated documents without removing foreign styles', () => {
  const document = () => {
    const styles = new Map();
    return { styles, head: { append: el => styles.set(el.id, el) }, getElementById: id => styles.get(id),
      createElement: () => ({ remove() { styles.delete(this.id); } }) };
  };
  const old = document(), fresh = document(); let current = old;
  const api = load('src/utils/styleInjector.ts', { '@decky/ui': { findSP: () => ({ window: { document: current } }) } }, { window: {} });
  api.addStyle('own', 'square'); api.restoreStylesTo(fresh);
  fresh.styles.set('foreign', {}); current = fresh;
  api.removeStyle('own');
  assert.equal(old.styles.size, 0); assert.deepEqual([...fresh.styles.keys()], ['foreign']);
  assert.deepEqual(Array.from(api.restoreStylesTo(old)), []);
});
test('in-flight layout guard cannot reattach, remeasure or schedule work after stop', async () => {
  const pending = deferred(), env = environment(), events = [];
  const api = load('src/patches/layoutGuard.ts', {
    '@decky/ui': { findSP: () => env }, '../static-classes': {},
    '../utils/styleInjector': { restoreStyles: noop }, '../utils/work': { markWork() {} },
    '../utils/log': { default() {} }, '../utils/steamRoute': {},
    './carouselWidthPatch': {}, './homePatch': { attachHomeCarousel: () => events.push('attach') },
    './layoutPatchController': { refreshLayoutPatches: () => pending.promise },
    './squareLibraryPatch': { remeasureGrids: () => events.push('remeasure') },
  }, env, '\nexport { reapply as testReapply };');
  const work = api.testReapply(); api.stopLayoutGuard(); pending.resolve(); await work;
  assert.deepEqual(events, []); assert.equal(env.timers.size, 0);
});
test('bootstrap unload cancels delayed routes and survives removeRoute throwing', async () => {
  const env = environment(), pending = deferred(), calls = []; let route = '/library';
  const methods = { createFrontendDiagnostics: () => ({sync: noop, stop: noop}), startLogging: noop, stopLogging: noop, startRuntime: noop, stopRuntime: noop, applyCachedLayout: noop, refreshLayoutPatches: () => pending.promise,
    stopLayoutPatches: () => calls.push('stopLayout'), updateSquareLibraryRoute: noop,
    attachHomeCarousel: () => calls.push('attach'), homeUsesRouteScope: () => false, updateHomeRoute: noop,
    guardAfterRoute: noop, startLayoutGuard: () => calls.push('guard'), stopLayoutGuard: () => calls.push('stopGuard'),
    applyCachedInstantLibraryScroll: noop, refreshInstantLibraryScroll: () => calls.push('lateScroll'), stopInstantLibraryScroll: noop,
    applyCachedDisableLibraryLetterHold: noop, refreshDisableLibraryLetterHold: () => calls.push('lateLetter'), stopDisableLibraryLetterHold: noop,
    applyCachedHomeRecentCover: noop, refreshHomeRecentCover: noop, stopHomeRecentCover: noop,
    startLibraryPreload: noop, stopLibraryPreload: noop, removeStyles: () => calls.push('styles'),
    cancelBulkArtworkJob: noop, steamPath: () => route, steamHref: () => route };
  const source = fs.readFileSync(path.join(__dirname, '../src/index.tsx'), 'utf8');
  const ast = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const mocks = Object.fromEntries(ast.statements.filter(ts.isImportDeclaration).map(n => [n.moduleSpecifier.text, { ...methods, default: noop }]));
  mocks['@decky/ui'] = { definePlugin: fn => fn, quickAccessMenuClasses: {} };
  mocks['@decky/api'] = { routerHook: { addRoute() {}, removeRoute() { throw Error('already removed'); } } };
  mocks['react/jsx-runtime'] = { jsx: () => ({}) };
  const api = load('src/index.tsx', mocks, { ...env, navigator: { language: 'en' } });
  const plugin = api.default();
  route = '/library/home'; [...env.timers.values()][0]();
  assert.equal(env.timers.size, 3);
  plugin.onDismount(); assert.equal(env.timers.size, 0);
  pending.resolve(); await new Promise(r => setImmediate(r));
  assert.equal(calls.filter(x => x === 'guard').length, 1);
  assert.ok(calls.includes('stopLayout') && calls.includes('styles'));
  assert.ok(!calls.includes('lateScroll') && !calls.includes('lateLetter') && !calls.includes('attach'));
  plugin.onDismount(); assert.equal(calls.filter(x => x === 'stopLayout').length, 1);
});
