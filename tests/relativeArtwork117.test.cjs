const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../tools/typescript.cjs');
const code = ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/utils/artworkTransfer.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
test('Steam relative artwork is loaded by the renderer, never the remote downloader', async () => {
  const exports = {}, fetched = [];
  vm.runInNewContext(code, { exports, URL, require: id => {
    if (id === '@decky/api') return { call: () => { throw Error('Unexpected backend request'); } };
    if (id === './imageSafety') return { fetchLocalImageBlob: async url => { fetched.push(url); return { url }; } };
    if (id === './normalizeArtworkPayload') return { normalizeArtworkBlob: async blob => ({ data: blob.url, animated: false }) };
    return {};
  } });
  for (const suffix of ['p.png', '.jpg', '_hero.png', '_logo.png', '_icon.png']) {
    const path = '/customimages/2198601558' + suffix;
    const result = await exports.readArtworkSource(path, { staticOnly: true });
    assert.equal(result.data, 'https://steamloopback.host' + path);
  }
  assert.equal(fetched.length, 5);
});
