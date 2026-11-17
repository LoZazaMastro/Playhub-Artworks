const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('../tools/typescript.cjs');
const compile=file=>ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8')+(file==='utils/zazamastroBatch.ts'?'\nexport const __automaticCacheKeys=()=>[...gameIdCache.keys()];':''),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
function fixture(options={}){
 let user='42';const requests=[],settings={steamgriddb_api_key:'synthetic-private-key'},search={};
 const constants={};const t={__esModule:true,default:(_key,fallback)=>fallback};vm.runInNewContext(compile('constants.ts'),{exports:constants,require:()=>t});
 const matching={};vm.runInNewContext(compile('utils/searchResults.ts'),{exports:matching});
 const api={};const fetchNoCors=async url=>{requests.push(url);const query=url.split('/autocomplete/')[1];const rows=query?(search[decodeURIComponent(decodeURIComponent(query))]||[]):[{id:1,url:'https://fixture.invalid/verified.png',width:512,height:512}];return{status:200,json:async()=>({success:true,data:rows})};};
 vm.runInNewContext(compile('utils/zazamastroBatch.ts'),{exports:api,URLSearchParams,setTimeout,clearTimeout,AbortController,require:id=>id==='@decky/api'?{call:async(_method,key,fallback)=>{if(options.readFailure&&key.startsWith('nonsteam_'))throw Error('unknown association');return Object.hasOwn(settings,key)?settings[key]:fallback;},fetchNoCors}:id==='../constants'?constants:id==='../utils/i18n'?t:id==='../hooks/useSGDB'?{SGDB_API_BASE:'https://fixture.invalid/api'}:id==='./getCurrentSteamUserId'?{__esModule:true,default:()=>user}:id==='./searchResults'?matching:id==='./imageSafety'?{MAX_SOURCE_DIMENSION:32768,MAX_SOURCE_PIXELS:100000000,fetchWithCancellation:async(fetcher,...args)=>fetcher(...args)}:id==='./log'?{__esModule:true,default:()=>{}}:{}});
 return{api,requests,settings,search,setUser:value=>{user=value;},run:(name='Exact Game')=>api.automaticArtworkCandidates({appid:3000000010,display_name:name,is_shortcut:true},'grid_p','square',new AbortController().signal)};
}
test('automatic autocomplete requires one unique exact identity, never a similarly named sequel',async()=>{
 const f=fixture();f.search['Exact Game']=[{id:200,name:'Exact Game 2'},{id:100,name:'Exact Game'}];assert.equal((await f.run()).length,1);assert.ok(f.requests.some(url=>url.includes('/game/100?')));assert.equal(f.requests.some(url=>url.includes('/game/200?')),false);
 const g=fixture();g.search['Exact Game']=[{id:100,name:'Exact Game'},{id:200,name:'Exact Game™'}];assert.equal((await g.run()).length,0);assert.equal(g.requests.some(url=>url.includes('/game/')),false);
});
test('same AppID renamed or moved to another Steam user cannot reuse a cached title association',async()=>{
 const f=fixture();f.search['Exact Game']=[{id:100,name:'Exact Game'}];f.search['Replacement Game']=[{id:300,name:'Replacement Game'}];await f.run();await f.run('Replacement Game');assert.ok(f.requests.some(url=>url.includes('/game/300?')));
 f.setUser('43');await f.run('Replacement Game');const keys=Array.from(f.api.__automaticCacheKeys(),key=>JSON.parse(key));assert.ok(keys.some(key=>key[0]==='42'&&key[2]==='Replacement Game'));assert.ok(keys.some(key=>key[0]==='43'&&key[2]==='Replacement Game'));
});
test('unknown saved association fails closed instead of falling through to an unrelated search',async()=>{const f=fixture({readFailure:true});await assert.rejects(f.run());assert.equal(f.requests.length,0);});
