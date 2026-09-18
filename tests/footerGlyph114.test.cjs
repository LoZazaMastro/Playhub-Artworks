'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../tools/typescript.cjs');
const React = require('./react-fixture.cjs');
const source = fs.readFileSync(path.resolve(__dirname, '../src/components/FooterGlyph.tsx'), 'utf8');
const code = ts.transpileModule(source, {fileName: 'FooterGlyph.tsx', compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.React,
  jsxFactory: 'window.SP_REACT.createElement', esModuleInterop: true,
}}).outputText;

function fixture(options = {}) {
  const module = {exports: {}};
  let calls = 0, now = 1000, current = options.exports || [];
  const ui = options.noLookupAPI ? {} : {findModuleExport(predicate) {
    calls++;
    if (options.throwLookup) throw Error('Simulated late Steam module');
    if (options.invalidResult) return options.invalidResult;
    return current.find(predicate);
  }};
  vm.runInNewContext(code, {module, exports: module.exports, window: {SP_REACT: React}, Symbol,
    Date: {now: () => now}, require: name => {
      if (name === 'react') return React;
      if (name === '@decky/ui') return ui;
      throw Error('Unexpected import ' + name);
    }}, {filename: 'FooterGlyph.tsx'});
  return {...module.exports, calls: () => calls, advance: () => {now += 3000;}, setExports: value => {current = value;}};
}
// Representative contracts, not copies of Steam code. Actual Steam functions
// and ReactDOM are separately exercised by tools/test-browser.py.
function currentNative(props) {
  const label = props.button === 0 ? '#ControllerButton_A' : '#ControllerButton_Menu';
  return React.createElement('svg', {className: props.additionalClassName, 'aria-label': label});
}
function legacyNative(props) {
  const classes = {Knockout: 'knockout'};
  return React.createElement('svg', {className: classes.Knockout + props.additionalClassName});
}
function render(node) {
  if (node == null) return node;
  let type = node.type;
  while (type?.$$typeof === Symbol.for('react.memo')) type = type.type;
  if (type?.$$typeof === Symbol.for('react.forward_ref')) return render(type.render(node.props));
  if (typeof type === 'function') return render(type(node.props));
  assert.equal(typeof type, 'string', 'A badge must never contain an undefined React component');
  return node;
}

test('FooterGlyph is a component at import time and does not eagerly scan Steam', () => {
  const f = fixture();
  assert.equal(typeof f.default, 'function');
  assert.equal(f.calls(), 0);
});
test('the old Knockout predicate misses the new native shape; hotfix recognizes both generations', () => {
  const f = fixture();
  assert.equal(currentNative.toString().includes('.Knockout'), false);
  assert.equal(f.isFooterGlyphExport(currentNative), true);
  assert.equal(f.isFooterGlyphExport(legacyNative), true);
});
test('glyph matcher recognizes memo/forwardRef and ignores malformed or cyclic values', () => {
  const f = fixture();
  assert.equal(f.isFooterGlyphExport(React.memo(currentNative)), true);
  assert.equal(f.isFooterGlyphExport(React.forwardRef(currentNative)), true);
  const cycle = {$$typeof: Symbol.for('react.memo')}; cycle.type = cycle;
  for (const value of [null, undefined, false, 3, 'svg', {}, cycle, () => 'additionalClassName']) {
    assert.equal(f.isFooterGlyphExport(value), false);
  }
});
test('glyph matcher never invokes a custom toString or a component while discovering it', () => {
  const f = fixture(); let called = 0;
  const object = {toString() {called++; throw Error('must not run');}};
  const proxy = new Proxy({}, {get() {throw Error('inaccessible export');}});
  assert.equal(f.isFooterGlyphExport(object), false);
  assert.equal(f.isFooterGlyphExport(proxy), false);
  assert.equal(called, 0);
});
for (const [name, options] of [
  ['missing native component', {}],
  ['missing Decky lookup API', {noLookupAPI: true}],
  ['throwing Decky lookup', {throwLookup: true}],
  ['invalid lookup result', {invalidResult: {notAComponent: true}}],
]) test('a real local SVG keeps Notes renderable with ' + name, () => {
  const f = fixture(options);
  const output = render(React.createElement(f.default, {button: 11, style: {width: '1em'}}));
  assert.equal(output.type, 'svg');
  assert.equal(output.props['data-playhub-glyph'], 'menu-fallback');
  assert.equal(output.props['aria-hidden'], 'true');
  assert.equal(output.props.style.width, '1em');
});
test('native component receives the original button, type and size and is positively cached', () => {
  const f = fixture({exports: [currentNative]});
  const props = {button: 11, type: 0, size: 0, additionalClassName: 'custom'};
  const result = f.default(props);
  assert.equal(result.type, currentNative);
  assert.equal(result.props.button, 11);
  assert.equal(result.props.type, 0);
  assert.equal(result.props.size, 0);
  assert.equal(result.props.additionalClassName, 'custom');
  f.advance(); f.default(props); assert.equal(f.calls(), 1);
});
test('negative lookup is throttled per grid, then retried when late Steam modules become available', () => {
  const f = fixture();
  for (let index = 0; index < 17; index++) render(f.default({button: 11}));
  assert.equal(f.calls(), 1);
  f.setExports([currentNative]);
  assert.equal(render(f.default({button: 11})).props['data-playhub-glyph'], 'menu-fallback');
  f.advance();
  assert.equal(f.default({button: 11}).type, currentNative);
  assert.equal(f.calls(), 2);
});
test('an unknown future button never receives a misleading Menu glyph', () => {
  const f = fixture();
  assert.equal(f.default({button: 123}), null);
});
