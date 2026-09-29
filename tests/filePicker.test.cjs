const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../tools/typescript.cjs');
const code = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/utils/openFilePicker.tsx'), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
}).outputText;
function load(native, legacy = () => { throw Error('Unexpected Decky fallback'); }) {
  const exports = {};
  vm.runInNewContext(code, {exports, window: {}, require: id => id === '@decky/api'
    ? {FileSelectionType: {FILE: 0}, openFilePicker: legacy}
    : {findSteamUI: () => ({window: {SteamClient: {System: {OpenFileDialog: native}}}})}});
  return exports;
}
test('uses the native owning Steam window with Windows path and image filters', async () => {
  let options;
  const {default: pick} = load(async value => { options = value; return 'D:\\Photos\\image.PNG'; });
  const result = await pick('D:\\Photos', true, undefined, {validFileExtensions: ['png', 'jpg']});
  assert.equal(result.path, 'D:\\Photos\\image.PNG');
  assert.equal(options.strInitialFile, 'D:\\Photos');
  assert.equal(options.rgFilters[0].rFilePatterns.join(','), '*.png,*.jpg');
});
test('cancel is silent and does not open a second picker', async () => {
  const module = load(async () => '');
  await assert.rejects(module.default(''), error => module.isFilePickerCancelled(error));
});
test('native failure remains an error rather than being relabelled as cancellation', async () => {
  const error = new Error('Disconnected');
  const module = load(async () => { throw error; });
  await assert.rejects(module.default(''), value => value === error && !module.isFilePickerCancelled(value));
});
test('legacy failure is preserved; only missing native capability uses Decky', async () => {
  const error = new Error('Failed to fetch');
  const module = load(undefined, async () => { throw error; });
  await assert.rejects(module.default('/'), value => value === error);
});
test('unsupported selection cannot enter the artwork replacement operation', async () => {
  const {default: pick} = load(async () => 'D:\\file.exe');
  await assert.rejects(pick('', true, undefined, {validFileExtensions: ['png']}), /Unsupported/);
});
