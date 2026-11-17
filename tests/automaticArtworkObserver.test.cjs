// Real observer/inventory/identity code, synthetic Steam registrations and settings.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto'),ts=require('../tools/typescript.cjs');
const source=fs.readFileSync(path.join(__dirname,'../src/utils/automaticArtworkObserver.ts'),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
const clone=value=>JSON.parse(JSON.stringify(value));
const settle=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(options={}){
 let owner='76561197960265770',clock=1000,interval,identityCallback,enabled=true,active=true;
 const apps=new Map(),settings=options.settings||{},calls=[],listeners=new Map(),fills=[],timers=new Map();let nextTimer=1;
 const add=(id,{installed=false,shortcut=true}={})=>{const app={appid:id,display_name:'Fixture '+id,app_type:shortcut?1073741824:1,icon_hash:shortcut?'':'official',BIsInstalled:()=>installed};apps.set(id,app);return app;};
 for(const app of options.apps||[])add(app.id,app);
 const currentUser=()=>owner;
 const native={RegisterForAppDetails:(id,callback)=>{const value={unAppID:id,strShortcutExe:'"C:\\Fixture\\Game.exe"',strShortcutLaunchOptions:'--fixture '+id,strShortcutStartDir:'C:\\Fixture'};if(options.deferIdentity)identityCallback=()=>callback(value);else callback(value);return{unregister(){}};}};
 const window={appStore:{allApps:apps,GetAppOverviewByAppID:id=>apps.get(id)},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name)=>listeners.delete(name)};
 const api={};const context={exports:api,window,SteamClient:{Apps:native},TextEncoder,Uint8Array,crypto:{subtle:{digest:async(_algorithm,bytes)=>createHash('sha256').update(bytes).digest()}},AbortController,Date:class extends Date{static now(){return clock;}},
 setInterval:fn=>{interval=fn;return 1;},clearInterval:()=>{interval=undefined;},setTimeout:(fn,ms)=>{const id=nextTimer++;timers.set(id,{fn,at:clock+ms});return id;},clearTimeout:id=>timers.delete(id),
 require:id=>id==='@decky/api'?{call:async(method,key,fallback)=>{calls.push([method,key]);if(method==='get_setting')return key==='automatic_artwork_enabled'?enabled:Object.hasOwn(settings,key)?clone(settings[key]):fallback;if(method==='set_setting'){settings[key]=clone(fallback);return true;}throw Error(method);}}:id==='./getCurrentSteamUserId'?{__esModule:true,default:currentUser}:id==='./runtimeLifecycle'?{isRuntimeActive:()=>active}:id==='./automaticArtwork'?{fillAutomaticArtwork:async(proof,shape,signal,current)=>{fills.push({proof,shape,signal,current});return options.fill?options.fill(proof,shape,signal,current):{complete:true,changed:5};}}:{}};
 vm.runInNewContext(code,context);let stop;
 return{api,apps,settings,fills,calls,add,start:async()=>{stop=api.startAutomaticArtwork();await settle();},tick:async()=>{interval?.();await settle();},advance:ms=>{clock+=ms;},online:async()=>{listeners.get('online')?.();await settle();},setOwner:value=>{owner=value;},setEnabled:value=>{enabled=value;},setActive:value=>{active=value;},identity:()=>identityCallback?.(),stop:()=>stop?.(),journal:()=>settings['automatic_artwork_v1_'+owner]};
}
test('burst imports are all durably queued, one worker at a time, and completed jobs do not replay after restart',async()=>{
 const f=fixture({apps:[{id:30001},{id:30002},{id:30003}]});await f.start();await f.tick();await f.tick();assert.deepEqual(f.fills.map(row=>row.proof.appid),[30001,30002,30003]);assert.equal(Object.values(f.journal().jobs).filter(job=>job.done).length,3);f.stop();
 const g=fixture({apps:[{id:30001},{id:30002},{id:30003}],settings:clone(f.settings)});await g.start();await g.tick();assert.equal(g.fills.length,0);g.stop();
});
test('installed games receive missing-only catchup while uninstalled official games are baselined without a write',async()=>{
 const f=fixture({apps:[{id:100,installed:false,shortcut:false},{id:200,installed:true,shortcut:false}]});await f.start();assert.deepEqual(f.fills.map(row=>row.proof.appid),[200]);assert.equal(f.fills[0].proof.hasOfficialIcon,true);assert.deepEqual(f.journal().seen,[100,200]);f.stop();
});
test('unknown inventory and disabled/runtime-stopped observers never authorize artwork jobs',async()=>{
 const empty=fixture();await empty.start();assert.equal(empty.fills.length,0);assert.equal(empty.calls.some(row=>row[0]==='set_setting'),false);empty.stop();
 for(const mode of ['disabled','stopped']){const f=fixture({apps:[{id:30001}]});if(mode==='disabled')f.setEnabled(false);else f.setActive(false);await f.start();assert.equal(f.fills.length,0);f.stop();}
});
test('concurrent polls never duplicate a worker; changing account aborts it and keeps journals separate',async()=>{
 let release;const f=fixture({apps:[{id:30001}],fill:()=>new Promise(resolve=>{release=resolve;})});await f.start();await f.tick();assert.equal(f.fills.length,1);const first=f.fills[0];f.setOwner('76561197960265771');await f.tick();assert.equal(first.signal.aborted,true);assert.equal(await first.current(),false);release({complete:true});await settle();assert.equal(Object.values(f.settings.automatic_artwork_v1_76561197960265770.jobs)[0].done,false);f.stop();
});
test('failed work has bounded persisted retries and an online event can retry after offline exhaustion',async()=>{
 const f=fixture({apps:[{id:30001}],fill:async()=>{throw Error('offline');}});await f.start();await f.tick();assert.equal(f.fills.length,1);f.advance(60001);await f.tick();f.advance(300001);await f.tick();f.advance(1800001);await f.tick();assert.equal(f.fills.length,3);assert.equal(Object.values(f.journal().jobs)[0].attempts,3);await f.online();assert.equal(f.fills.length,4);f.stop();
});
test('a late app-details callback after title/account changes cannot seal an identity',async()=>{
 const f=fixture({apps:[{id:30001}],deferIdentity:true});const pending=f.api.automaticIdentity(30001);f.apps.get(30001).display_name='Replacement game';f.identity();assert.equal(await pending,null);
 const g=fixture({apps:[{id:30002}],deferIdentity:true});const foreign=g.api.automaticIdentity(30002);g.setOwner('76561197960265771');g.identity();assert.equal(await foreign,null);
});
