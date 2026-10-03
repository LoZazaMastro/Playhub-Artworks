const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),ts=require('../tools/typescript.cjs');
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/utils/perfectArtwork.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
function fixture(initial={}){
 const state=new Map(Object.entries(initial)),logo=[],exports={};
 vm.runInNewContext(code,{exports,window:{setTimeout,clearTimeout},require:id=>{
 if(id==='@decky/api')return {call:async(method,key,value)=>{if(method==='get_setting')return state.has(key)?state.get(key):value;if(method==='set_setting'){state.set(key,value);return true}if(method==='delete_setting'){state.delete(key);return true}return true}};
 if(id==='./logoControl')return {hideLogo:async()=>{logo.push('hide');return true},showLogo:async()=>{logo.push('show');return true}};
 return {};
 }});return {api:exports,state,logo};
}
for(const target of ['hero','grid_l'])test(`${target} alone restores the separate logo on removal`,async()=>{
 const f=fixture();await f.api.markPerfectArtwork(42,target,true);await f.api.clearPerfectArtwork(42,target);
 assert.deepEqual(f.logo,['hide','show']);assert.equal(f.state.has(`perfect_${target}_42`),false);assert.equal(f.state.has(`perfect_${target}_info_42`),false);
});
for(const target of ['hero','grid_l'])test(`removing ${target} preserves the logo state required by the other artwork`,async()=>{
 const other=target==='hero'?'grid_l':'hero',f=fixture();await f.api.markPerfectArtwork(42,target,true);await f.api.markPerfectArtwork(42,other,true);
 await f.api.clearPerfectArtwork(42,target);assert.deepEqual(f.logo,['hide','hide']);assert.equal(f.state.get(`perfect_${other}_42`),true);
 await f.api.clearPerfectArtwork(42,other);assert.deepEqual(f.logo,['hide','hide','show']);
});
test('composition without logo keeps another active baked logo hidden',async()=>{
 const f=fixture();await f.api.markPerfectArtwork(42,'hero',true);const hidden=await f.api.markPerfectArtwork(42,'grid_l',false);
 assert.equal(hidden,true);assert.deepEqual(f.logo,['hide','hide']);await f.api.clearPerfectArtwork(42,'hero');assert.deepEqual(f.logo,['hide','hide','show']);
});
test('composition without logo alone restores the Steam logo',async()=>{
 const f=fixture();assert.equal(await f.api.markPerfectArtwork(42,'grid_l',false),false);assert.deepEqual(f.logo,['show']);
});
test('legacy remaining banner without metadata prevents premature restoration',async()=>{
 const f=fixture({perfect_grid_l_42:true,perfect_hero_42:true});await f.api.clearPerfectArtwork(42,'hero');assert.deepEqual(f.logo,[]);
 await f.api.clearPerfectArtwork(42,'grid_l');assert.deepEqual(f.logo,['show']);
});
