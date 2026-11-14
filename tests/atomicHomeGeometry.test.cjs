const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../tools/typescript.cjs');
const root = process.env.PLAYHUB_ARTWORKS_SOURCE || path.resolve(__dirname, '..');
const file = 'src/patches/carouselWidthPatch.ts';
const noop = () => {};

function harness({ square = true, mounted = true } = {}) {
  delete require.cache[require.resolve('./fixtures/steam-carousel.cjs')];
  const Carousel = require('./fixtures/steam-carousel.cjs');
  const nodes = [];
  const doc = { querySelectorAll: () => nodes, querySelector: () => nodes[0] };
  const foreign = {};
  let home = true, recomputes = 0, renders = 0;
  const nativeRender = Carousel.prototype.render;
  Carousel.prototype.render = function () { renders++; return nativeRender.call(this); };
  const originals = Object.getOwnPropertyDescriptors(Carousel.prototype);
  const window = { __playhubArtworksCarouselPrototype: Carousel.prototype };
  const mocks = {
    '../utils/steamWindow': { findSteamUI: () => ({ window: { document: doc } }) },
    '../static-classes': { homeCarouselClasses: { BasicGameCarousel: 'home-carousel', LabelHeight: '52px' }, sel: (o, k) => o[k] ? '.' + o[k] : '' },
    '../utils/log': { default: noop, __esModule: true },
    '../utils/steamRoute': { isHomeRoute: () => home },
  };
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const load = () => {
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: name => { assert.ok(name in mocks, name); return mocks[name]; }, window, console,
    setTimeout: () => assert.fail('Geometry must be fixed before render, without timers'), setInterval: () => assert.fail('No repair polling') }, { filename: file });
  return module.exports;
  };
  const api = load();
  function props(width = 160, height = 292, count = 4) {
    return { className: 'home-carousel', nNumItems: count, nItemMarginX: 16, nItemHeight: height, nHeight: height,
      fnGetColumnWidth: () => width, fnGetId: i => i, fnItemRenderer: (index, width, height) => ({ index, width, height }) };
  }
  function instance(p = props(), owner = mounted ? doc : null) {
    const value = new Carousel(p, owner);
    value.m_refGrid.recomputeGridSize = () => recomputes++;
    nodes.push({ '__reactFiber$fixture': { stateNode: value } });
    return value;
  }
  function render(value) {
    const native = value.render();
    const grid = native.props.children;
    return { native, grid, widths: [0, 1, value.props.nNumItems - 1].map(index => grid.props.columnWidth({ index })),
      cell: grid.props.cellRenderer({ key: 'native-key', columnIndex: 0, style: { left: 0 } }).props.children };
  }
  return { api, reload: load, Carousel, doc, foreign, originals, props, instance, render, setHome: value => home = value,
    get recomputes() { return recomputes; }, get renders() { return renders; }, install: () => api.addCarouselWidthPatch(square) };
}

test('refresh/delete: the first native render measures new props before any observer/sweep', () => {
  const h = harness(), value = h.instance();
  const immutable = value.GetCellColumnWidth;
  assert.equal(Object.getOwnPropertyDescriptor(value, 'GetCellColumnWidth').configurable, false);
  assert.equal(h.install(), true);
  assert.equal(h.render(value).widths[0], 256);
  const before = h.recomputes;
  for (const count of [3, 2, 5]) {
    value.props = h.props(160, 292, count); // React refresh/delete replaces this object.
    const result = h.render(value);
    assert.deepEqual(result.widths, [256, count === 2 ? 267 : 256, 267]);
    assert.equal(result.cell.width, 240);
    assert.equal(result.grid.props.columnWidth, immutable, 'Steam keeps its original bound method and identity');
  }
  assert.equal(h.recomputes, before, 'No post-render repair/recompute is needed for new props');
  assert.equal(h.renders, 4, 'No extra render or remount');
});

test('a newly mounted carousel gets square slot and cell width in the same first measured render', () => {
  const h = harness(); h.install();
  const value = h.instance();
  const result = h.render(value);
  assert.deepEqual(result.widths, [256, 256, 267]);
  assert.equal(result.cell.width, 240);
  assert.equal(h.renders, 1);
});

test('callback receiver, arguments, return values, and native render output remain intact', () => {
  const h = harness(), value = h.instance(); h.install();
  let calls = 0;
  const p = h.props();
  p.fnGetColumnWidth = function (index, ...extra) { calls++; assert.equal(this, p); assert.equal(extra.length, 0); return index === 1 ? 10 : 160; };
  value.props = p;
  const result = h.render(value);
  assert.deepEqual(result.widths, [256, 26, 267]);
  assert.equal(result.cell.width, 240);
  assert.equal(calls, 4);
  assert.equal(result.native.type, 'nav'); assert.equal(result.grid.type, 'grid');
  assert.equal(result.grid.props.ref, value.BindGridObject);
  assert.equal(result.grid.props.columnCount, 4);
});

test('portrait setting, banner/separator widths, foreign document, and non-Home route stay native', () => {
  const h = harness(); h.install();
  for (const width of [514, 10, 115]) {
    const value = h.instance(h.props(width));
    assert.equal(h.render(value).widths[0], width + 16);
    assert.equal(h.render(value).cell.width, width);
  }
  const other = h.instance(h.props(), h.foreign);
  assert.equal(h.render(other).widths[0], 176);
  const unrelated = h.instance({ ...h.props(), className: 'friends-carousel' });
  assert.equal(h.render(unrelated).widths[0], 176);
  h.setHome(false);
  assert.equal(h.render(h.instance()).widths[0], 176);
  h.setHome(true); h.api.setCarouselWidthSquare(false);
  assert.equal(h.render(h.instance()).widths[0], 176);
});

test('label-free row, margins and final padding stay coherent; repeated render never stacks wrappers', () => {
  const h = harness(); h.install();
  const p = h.props(160, 240), value = h.instance(p);
  const first = h.render(value); const callback = value.props.fnGetColumnWidth;
  assert.deepEqual(first.widths, [256, 256, 267]);
  for (let i = 0; i < 8; i++) { assert.equal(h.render(value).cell.width, 240); assert.equal(value.props.fnGetColumnWidth, callback); }
  h.api.removeCarouselWidthPatch();
  assert.equal(h.render(value).widths[0], 176);
  assert.equal(h.Carousel.prototype.render, h.originals.render.value);
  h.install(); assert.equal(h.render(value).widths[0], 256);
});

test('Home square media is constrained to its slot even before the native class can be discovered', () => {
  const source = fs.readFileSync(path.join(root, 'src/patches/homePatch.tsx'), 'utf8');
  assert.match(source, /\$\{media\}\$\{notFeatured\}\s*\{[^}]*max-width:\s*100%\s*!important/s);
  assert.match(source, /> div:first-child\$\{notLabel\}\s*\{[^}]*max-width:\s*100%\s*!important/s);
});


test('a callback retained in replacement props cannot transfer another carousel owner or scope', () => {
  const h = harness(), first = h.instance(); h.install();
  const original = first.props.fnGetColumnWidth.__playhubArtworksColumnWidthSource;
  const foreignProps = { ...first.props };
  const other = h.instance(foreignProps, h.foreign);
  assert.equal(h.render(other).widths[0], 176);
  assert.equal(other.props.fnGetColumnWidth, original);
  assert.equal(h.render(first).widths[0], 256);
  const another = h.instance({ ...first.props });
  assert.equal(h.render(another).cell.width, 240);
  assert.notEqual(another.props.fnGetColumnWidth, first.props.fnGetColumnWidth);
});

test('unmeasured first mount stays native; before its first Grid render both measurements become square', () => {
  const h = harness(); h.install();
  const value = h.instance(h.props(), null); value.state.nContainerWidth = 0;
  assert.equal(value.render().props.children, 0);
  value.m_refContainer.current = { ownerDocument: h.doc }; value.state.nContainerWidth = 1280;
  assert.deepEqual(h.render(value).widths, [256, 256, 267]);
  assert.equal(h.render(value).cell.width, 240);
});


test('bundle reload restores render and unwraps stale props without retaining a dead bundle', () => {
  const h = harness(), value = h.instance();
  const bound = value.GetCellColumnWidth;
  h.install(); h.render(value); const old = value.props.fnGetColumnWidth;
  h.api.removeCarouselWidthPatch();
  assert.equal(h.render(value).cell.width, 160);
  const next = h.reload(); next.addCarouselWidthPatch(true);
  assert.equal(h.render(value).cell.width, 240);
  assert.equal(value.GetCellColumnWidth, bound);
  assert.notEqual(value.props.fnGetColumnWidth, old);
  next.removeCarouselWidthPatch();
  assert.equal(h.Carousel.prototype.render, h.originals.render.value);
  assert.equal(h.render(value).cell.width, 160);
});
