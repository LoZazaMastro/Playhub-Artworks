#!/usr/bin/env node
/* Deterministic no-network build: all plugin TS/TSX + JSON are recompiled.
 * Only unchanged third-party dependency code and compiled SCSS are frozen.
 * The standard Rollup build remains available through pnpm run build.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('./typescript.cjs');
const root = path.resolve(__dirname, '..');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const files = dir => fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]).sort();
const id = file => path.relative(root,file).split(path.sep).join('/');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname,'vendor/manifest.json'),'utf8'));
for (const [name,hash] of Object.entries(manifest.scssSha256)) {
 if (sha(fs.readFileSync(path.join(root,name)))!==hash) throw Error('SCSS changed: run the normal Rollup/Sass build instead: '+name);
}
const vendor = fs.readFileSync(path.join(__dirname,'vendor/runtime.js'),'utf8');
const css = fs.readFileSync(path.join(__dirname,'vendor/style.css'),'utf8');
const modules = new Map(), inputs = {};
const externals = new Set(['@decky/api','@decky/ui','react','react-dom',...Object.keys(manifest.modules)]);
function resolve(from,spec) {
 if (!spec.startsWith('.')) {
  if (!externals.has(spec)) throw Error('Unsupported runtime import '+spec+' in '+id(from));
  return spec;
 }
 const base = path.resolve(path.dirname(from),spec);
 const target = [base,base+'.ts',base+'.tsx',base+'.json',path.join(base,'index.ts'),path.join(base,'index.tsx')]
   .find(p=>fs.existsSync(p)&&fs.statSync(p).isFile());
 if (!target || !target.startsWith(path.join(root,'src')+path.sep)) throw Error('Unresolved source import '+spec+' in '+id(from));
 return id(target);
}
for (const file of files(path.join(root,'src'))) {
 if (/\.d\.ts$/.test(file) || !/\.(tsx?|json)$/.test(file)) continue;
 const source = fs.readFileSync(file,'utf8'); inputs[id(file)]=sha(source);
 if (file.endsWith('.json')) { modules.set(id(file),'module.exports = '+JSON.stringify(JSON.parse(source))+';'); continue; }
 const result = ts.transpileModule(source, {fileName:file,reportDiagnostics:true,compilerOptions:{
  target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,
  jsxFactory:'window.SP_REACT.createElement',jsxFragmentFactory:'window.SP_REACT.Fragment',
  esModuleInterop:true,isolatedModules:true,sourceMap:false,
 }});
 const errors = (result.diagnostics||[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
 if (errors.length) throw Error(ts.formatDiagnosticsWithColorAndContext(errors,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}));
 const output=result.outputText.replace(/\bprocess\.env\.ROLLUP_ENV\b/g,JSON.stringify('production'))
   .replace(/require\((['"])([^'"]+)\1\)/g,(_match,_q,spec)=>'require('+JSON.stringify(resolve(file,spec))+')');
 modules.set(id(file),output);
}
modules.set('src/styles/style.scss','module.exports = '+JSON.stringify(css)+';');
for (const [name,code] of modules) for (const match of code.matchAll(/require\("([^"\n]+)"\)/g)) {
 if (!modules.has(match[1]) && !externals.has(match[1])) throw Error('Missing built module '+match[1]+' in '+name);
}
const header = `// Playhub Artworks 1.1.5 — offline source build (TypeScript ${ts.version}).\n// Third-party runtime retained from the supplied 1.1.3 release; plugin modules rebuilt below.\nconst SP_REACT = window.SP_REACT;\nconst SP_REACTDOM = window.SP_REACTDOM;\nconst __deckyUI = typeof DFL !== 'undefined' ? DFL : window.DFL;\nconst __vendors = (() => {\n${vendor}\n})();\nconst __connection = window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit;\nif (!__connection) throw new Error('Playhub Artworks: Decky API is not initialized.');\nlet __api;\ntry { __api = __connection.connect(2, 'Playhub Artworks'); } catch { __api = __connection.connect(1, 'Playhub Artworks'); }\nObject.assign(__vendors, { react: SP_REACT, 'react-dom': SP_REACTDOM, '@decky/ui': __deckyUI, '@decky/api': __api });\nconst __modules = {\n`;
const definitions = [...modules].map(([name,body])=>JSON.stringify(name)+': function(module, exports, require) {\n'+body+'\n}').join(',\n');
const footer = `\n};\nconst __cache = Object.create(null);\nfunction __require(name) {\n if (Object.prototype.hasOwnProperty.call(__vendors, name)) return __vendors[name];\n if (__cache[name]) return __cache[name].exports;\n if (!__modules[name]) throw new Error('Unknown Playhub Artworks module: '+name);\n const module = { exports: {} }; __cache[name] = module;\n try { __modules[name](module, module.exports, __require); } catch (error) { delete __cache[name]; throw error; }\n return module.exports;\n}\nexport default __require('src/index.tsx').default;\n`;
const output = header+definitions+footer;
fs.mkdirSync(path.join(root,'dist'),{recursive:true});
// Declaration files are not needed at runtime and must not survive from stale source.
for (const f of files(path.join(root,'dist'))) if (f.endsWith('.d.ts')) fs.unlinkSync(f);
fs.writeFileSync(path.join(root,'dist/index.js'),output);
fs.writeFileSync(path.join(root,'dist/build-info.json'),JSON.stringify({version:'1.1.5',build:'1.1.5',builder:'offline-typescript',typescript:ts.version,
 bundleSha256:sha(output),sourceSha256:inputs,vendorRuntimeSha256:sha(vendor),frozenDependenciesFrom:manifest.sourceBundleSha256},null,2)+'\n');
console.log('Built '+modules.size+' modules ('+Buffer.byteLength(output)+' bytes), TypeScript '+ts.version+'.');
console.log('This build checks syntax/import resolution, not full dependency-aware semantic TypeScript diagnostics.');
