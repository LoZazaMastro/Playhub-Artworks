'use strict';
// Compile the actual image/transfer/bulk modules for browser regression tests.
// Only Steam/Decky/provider boundaries are adapted; canvas and image decoding are real.
const fs=require('node:fs'),path=require('node:path'),ts=require('./typescript.cjs');
const root=path.resolve(__dirname,'..');
const files=['src/constants.ts','src/utils/imageSafety.ts','src/utils/imageMetadata.ts','src/utils/normalizeArtworkPayload.ts',
 'src/utils/runtimeLifecycle.ts','src/utils/logoControl.ts','src/utils/artworkTransfer.ts','src/utils/artworkSources.ts','src/utils/searchResults.ts','src/utils/zazamastroBatch.ts'];
const mods={};
for(const f of files){
 let source=fs.readFileSync(path.join(root,f),'utf8');
 if(f.endsWith('zazamastroBatch.ts'))source+='\nexport const __test = {usableLogo, composePerfectHero, resolveLogoForApp, prepareAutoPerfectHero, applyPreparedHero3840, assetsForApp, sgdbGameIdForApp, allUsefulAssets};';
 const code=ts.transpileModule(source,{fileName:f,compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 mods[f]=code;
}
process.stdout.write(`(()=>{const sources=${JSON.stringify(mods)},cache={};
 const noop=()=>{};window.__settings={steamgriddb_api_key:"synthetic-test-key"};window.__writes=[];window.__overview=null;window.__localInfo={};
 window.__rpcOverride=null;window.__providerResponse=()=>[];
 const call=async(method,...args)=>{
  if(window.__rpcOverride){const override=window.__rpcOverride(method,args);if(override!==undefined)return await override;}
  if(method==='get_setting')return Object.hasOwn(window.__settings,args[0])?window.__settings[args[0]]:args[1];
  if(method==='set_setting'){window.__writes.push([method,...args]);window.__settings[args[0]]=args[1];return true;}
  if(method==='delete_setting'){window.__writes.push([method,...args]);delete window.__settings[args[0]];return true;}
  if(method==='get_local_asset_info')return window.__localInfo[args[1]]||{exists:false};
  if(method==='get_steamgriddb_api_key')return 'synthetic-test-key';
  if(method==='search_provider_assets')return [];
  if(method==='clear_download_progress')return true;
  return await window.testRpc(method,args);
 };
 const adapters={
  '@decky/api':{call,fetchNoCors:async(url)=>({status:200,ok:true,json:async()=>({success:true,data:window.__providerResponse(url)})})},
  'react':{useEffect:noop,useState:x=>[x,noop]},
  'src/utils/i18n.ts':{__esModule:true,default:(_k,v)=>v,localizeError:e=>e?.message||String(e)},
  'src/utils/log.ts':{__esModule:true,default:noop},
  'src/utils/getAppOverview.ts':{__esModule:true,default:async()=>window.__overview},
  'src/utils/getAppDetails.ts':{__esModule:true,default:async()=>null},
  'src/utils/getCustomLogoPosition.ts':{__esModule:true,default:async()=>null},
  'src/utils/getCurrentSteamUserId.ts':{__esModule:true,default:()=> '123'},
  'src/hooks/useSGDB.ts':{SGDB_API_BASE:'https://www.steamgriddb.com/api/v2'},
  'src/utils/derivedCover.ts':{clearDerivedCoverBackup:async()=>true,clearSteamArtworkSafely:async()=>true,runSteamArtworkTransaction:async(fn)=>fn(async(_label,operation)=>operation())}
 };
 window.SteamClient={Apps:{ClearCustomArtworkForApp:async(...a)=>window.__writes.push(['clear',...a]),SetCustomArtworkForApp:async(...a)=>window.__writes.push(['set',a[0],a[2],a[3]]),SetCustomLogoPositionForApp:async(...a)=>window.__writes.push(['position',...a])}};
 const resolve=(from,spec)=>{if(!spec.startsWith('.'))return spec;const stack=from.split('/').slice(0,-1);for(const part of spec.split('/')){if(part==='..')stack.pop();else if(part!=='.')stack.push(part);}return stack.join('/')+'.ts';};
 window.testRequire=function load(id){if(adapters[id])return adapters[id];if(cache[id])return cache[id].exports;if(!sources[id])throw Error('Missing test module '+id);const m={exports:{}};cache[id]=m;new Function('module','exports','require',sources[id])(m,m.exports,spec=>load(resolve(id,spec)));return m.exports;};
})();`);
