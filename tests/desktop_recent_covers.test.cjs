const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const classes = { RecentGames: 'recent-games', RecentGameMediaContainer: 'recent-media', CarouselExtraHeight: '58' };
const element = (type, props, key) => ({ type, props, key });
const react = {
  isValidElement: value => !!value?.props,
  cloneElement: (value, props, ...children) => ({ ...value, props: { ...value.props, ...props,
    ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }),
};
function load(file, mocks, globals) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const js = ts.transpileModule(source, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2021 } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: name => {
    if (!(name in mocks)) throw new Error('Missing mock: ' + name);
    return mocks[name];
  }, ...globals });
  return exports;
}
function fixture() {
  const styles = new Map();
  const roots = [];
  const doc = { body: {}, querySelectorAll: selector => selector === '.recent-games' ? roots : [],
    head: { append: style => styles.set(style.id, style) }, getElementById: id => styles.get(id),
    createElement: () => ({ remove() { styles.delete(this.id); } }) };
  let desktop = doc;
  const bigPicture = { querySelectorAll: () => [] };
  let observer;
  const frames = new Map();
  const timers = new Map();
  let next = 1;
  const globals = { window: { SteamUIStore: { WindowStore: { get SteamUIWindows() {
    return [{ IsMainDesktopWindow: () => true, BrowserWindow: { document: desktop } }];
  } } }, requestAnimationFrame: fn => { const id = next++; frames.set(id, fn); return id; },
  cancelAnimationFrame: id => frames.delete(id) },
  setInterval: fn => { const id = next++; timers.set(id, fn); return id; }, clearInterval: id => timers.delete(id),
  MutationObserver: class { constructor(fn) { observer = this; this.callback = fn; } observe() {} disconnect() {} } };
  const ui = { findSP: () => ({ window: { document: bigPicture } }), findModule: predicate => predicate(classes) ? classes : undefined,
    afterPatch: (instance, key, callback) => {
      const original = instance[key];
      instance[key] = function(...args) { return callback(args, original.apply(this, args)); };
      return { unpatch: () => { instance[key] = original; } };
    } };
  const staticClasses = { appportraitClasses: { LibraryItemBox: 'game' },
    libraryAssetImageClasses: { Container: 'asset', PortraitImage: 'portrait' },
    collectionGridClasses: { YourCollection: 'collection' }, showcaseGridClasses: { ShowcaseGrid: 'showcase' },
    sel: (map, key) => map[key] ? '.' + map[key] : '' };
  const scope = load('src/patches/libraryGridScope.ts', { '@decky/ui': ui, '../static-classes': staticClasses,
    '../utils/steamRoute': { isSquareLibraryRoute: () => true } }, globals);
  const api = load('src/patches/desktopLibraryCovers.ts', { '@decky/ui': ui, react,
    '../static-classes': staticClasses, './libraryGridScope': scope }, globals);
  function carousel(width = 154, ownerDocument = doc, className = 'recent-games') {
    const label = element('date', { children: 'This week' });
    const cards = [true, false].map((featured, index) => element('RecentGame', {
      app: { appid: index + 1 }, label, bFeatured: featured, bShortLayout: false,
      nWidth: width * (featured ? 2.108 : 1), nHeight: width * 1.5,
    }, 'app-' + index));
    const instance = { props: { className }, m_elScrollingDiv: { ownerDocument }, updates: 0,
      UpdateScrollArrows() {}, render() { return element('div', { style: { height: width * 1.5 + 58 + 'px', color: 'white' },
        children: element('div', { role: 'list', children: cards }) }); },
      forceUpdate() { this.updates++; this.output = this.render(); this.UpdateScrollArrows(); } };
    const root = { ownerDocument, isConnected: true, nodeType: 1,
      matches: selector => selector.includes('recent-games'), querySelector: () => null,
      __reactFiber$test: { return: { stateNode: instance } } };
    roots.push(root);
    return { instance, root, cards, originalRender: instance.render };
  }
  return { api, scope, doc, roots, carousel, styles, timers, frames, bigPicture,
    replaceDocument: () => { desktop = { ...doc, querySelectorAll: () => [] }; },
    mutation: records => observer.callback(records),
    flush: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); },
    tick: () => [...timers.values()].forEach(fn => fn()) };
}

test('desktop Recent Games squares ordinary portraits and leaves the featured banner entirely native', () => {
  const f = fixture();
  const c = f.carousel();
  f.api.setDesktopLibrarySquare(true);
  const output = c.instance.output;
  assert.equal(output.props.style.height, '289px');
  assert.equal(output.props.style.color, 'white');
  assert.equal(output.props['data-playhub-artworks-square'], '');
  assert.equal(output.props.children.props.role, 'list');
  output.props.children.props.children.forEach((card, i) => {
    assert.equal(card.props.nWidth, i === 0 ? 154 * 2.108 : 231);
    assert.equal(card.props.nHeight, 231);
    assert.equal(card.props.bFeatured, i === 0);
    assert.equal(card.props.bShortLayout, false);
    assert.equal(card.props.label, c.cards[i].props.label);
    assert.equal(card.props.app, c.cards[i].props.app);
    assert.equal(card.key, c.cards[i].key);
  });
  assert.equal(output.props.children.props.children[0], c.cards[0], 'featured element identity and all props remain native');
  assert.equal(c.cards[0].props.bFeatured, true);
  assert.equal(c.cards[0].props.nHeight, 231);
  const updates = c.instance.updates;
  f.tick();
  assert.equal(c.instance.updates, updates, 'no repeated forceUpdate on periodic scan');
  f.api.setDesktopLibrarySquare(false);
  assert.equal(c.instance.render, c.originalRender);
  assert.equal(c.instance.output.props.style.height, '289px');
  assert.equal(f.styles.size, 0);
  assert.equal(f.timers.size, 0);
});

test('scope excludes gamepad, other shelves and incomplete carousel instances', () => {
  const f = fixture();
  const desktop = f.carousel();
  const gamepad = f.carousel(154, f.bigPicture);
  const other = f.carousel(154, f.doc, 'play-next');
  const unknown = f.carousel();
  delete unknown.instance.UpdateScrollArrows;
  assert.equal(f.scope.mountedDesktopRecentCarousels().size, 1);
  f.api.setDesktopLibrarySquare(true);
  assert.notEqual(desktop.instance.render, desktop.originalRender);
  for (const c of [gamepad, other, unknown]) assert.equal(c.instance.render, c.originalRender);
  f.api.stopDesktopLibraryCovers();
});

test('late shelves are discovered by mutation, removed shelves and replaced documents restore patches', () => {
  const f = fixture();
  f.api.setDesktopLibrarySquare(true);
  const c = f.carousel(175);
  f.mutation([{ addedNodes: [c.root], removedNodes: [] }]);
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.equal(c.instance.output.props.style.height, '320.5px');
  c.root.isConnected = false;
  f.roots.splice(0);
  f.tick();
  assert.equal(c.instance.render, c.originalRender);
  const next = f.carousel(120);
  f.tick();
  assert.equal(next.instance.output.props.style.height, '238px');
  f.replaceDocument();
  f.tick();
  assert.equal(next.instance.render, next.originalRender);
  f.api.stopDesktopLibraryCovers();
});

test('resize renders use fresh card sizes and malformed output remains untouched', () => {
  const f = fixture();
  const c = f.carousel();
  f.api.setDesktopLibrarySquare(true);
  c.cards[0].props.nWidth = 175 * 2.108;
  c.cards[1].props.nWidth = 175;
  c.cards[1].props.nHeight = 262.5;
  assert.equal(c.instance.render().props.children.props.children[1].props.nWidth, 262.5);
  c.cards.forEach(card => { card.props.nWidth = NaN; });
  assert.equal(c.instance.render().props.style.height, '289px');
  f.api.stopDesktopLibraryCovers();
});

const steamBundle = 'C:/Program Files (x86)/Steam/steamui/chunk~2dcc5aaf7.js';
test('installed Steam BoxCarousel arrows use new DOM widths and restore after portrait toggle', {
  skip: !fs.existsSync(steamBundle),
}, () => {
  const source = fs.readFileSync(steamBundle, 'utf8');
  const start = source.indexOf('26271:(e,t,r)=>');
  assert.ok(start >= 0);
  const end = source.indexOf('},16182:', start) + 1;
  assert.ok(end > start);
  const exports = {};
  const modules = {
    34629: { Cg() {} }, 62540: { jsx: element },
    63696: { Component: class { constructor(props) { this.props = props; this.state = {}; }
      setState(value) { this.state = { ...this.state, ...value }; } } },
    27939: {}, 90765: {}, 51115: { oI() {} }, 81255: { s: () => () => {} }, 7558: {},
  };
  const requireNative = id => { assert.ok(id in modules, 'unexpected native dependency'); return modules[id]; };
  requireNative.d = (target, getters) => Object.entries(getters).forEach(([key, get]) => Object.defineProperty(target, key, { get }));
  requireNative.n = value => () => value;
  const module = vm.runInNewContext('(' + source.slice(start + '26271:'.length, end) + ')', { setTimeout });
  module({}, exports, requireNative);
  const f = fixture();
  const c = f.carousel();
  c.cards.push(element('RecentGame', { ...c.cards[1].props, app: { appid: 3 } }, 'app-2'));
  let arrows;
  const native = new exports.Q({ fnUpdateArrows: (left, right) => { arrows = [left, right]; } });
  let children = [];
  const scrolling = { scrollLeft: 0, clientWidth: 350, scrollWidth: 0, matches: () => false,
    get children() { return children; } };
  native.m_elScrollingDiv = scrolling;
  native.ScheduleUpdateScrollArrows = () => native.UpdateScrollArrows();
  native.ScrollToElement = node => { scrolling.scrollLeft = node.offsetLeft; };
  native.ScrollToOffset = offset => { scrolling.scrollLeft = offset; };
  const layout = () => {
    let left = 0;
    children = c.instance.render().props.children.props.children.map(card => {
      const node = { offsetLeft: left, offsetWidth: card.props.nWidth, matches: () => false, getAttribute: () => null };
      left += card.props.nWidth + 16;
      return node;
    });
    scrolling.scrollWidth = left - 16;
    native.componentDidUpdate();
  };
  f.api.setDesktopLibrarySquare(true);
  layout();
  assert.deepEqual(children.map(node => node.offsetLeft), [0, 154 * 2.108 + 16, 154 * 2.108 + 16 + 231 + 16]);
  assert.ok(children[0].offsetLeft + children[0].offsetWidth < children[1].offsetLeft, 'featured cannot overlap second cover');
  assert.deepEqual(arrows, [false, true]);
  native.ScrollRight({ shiftKey: false });
  assert.equal(scrolling.scrollLeft, 154 * 2.108 + 16, 'first page step retains native banner width');
  native.ScrollRight({ shiftKey: false });
  assert.equal(scrolling.scrollLeft, 154 * 2.108 + 16 + 231 + 16, 'next step uses new ordinary square width');
  native.ScrollLeft({ shiftKey: false });
  native.ScrollLeft({ shiftKey: false });
  assert.equal(scrolling.scrollLeft, 0);
  f.api.setDesktopLibrarySquare(false);
  layout();
  assert.equal(children[1].offsetLeft, 154 * 2.108 + 16);
  assert.equal(c.instance.render().props.style.height, '289px');
});
