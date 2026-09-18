const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('../tools/typescript.cjs');
const root = path.join(__dirname,'..');
const noop = () => {};
const React = {
  createElement(type, props, ...children) { return {$$typeof:'react',type,key:props?.key ?? null,props:{...props,children:children.length===1?children[0]:children}}; },
  cloneElement(node, props, ...children) { return {...node,props:{...node.props,...props,...(children.length?{children:children.length===1?children[0]:children}:{})}}; },
  isValidElement: node => node?.$$typeof === 'react', Fragment:'fragment',
};
function clock(extra={}) {
  let serial=0; const timers=new Map(),delays=new Map();
  const window={SP_REACT:React,location:{pathname:'/routes/library/home',href:'steam://library/home'},console,
    setTimeout(fn,delay){const id=++serial;timers.set(id,fn);delays.set(id,delay);return id;},
    clearTimeout(id){timers.delete(id);delays.delete(id);},
    setInterval(fn,delay){const id=++serial;timers.set(id,fn);delays.set(id,delay);return id;},
    clearInterval(id){timers.delete(id);delays.delete(id);},...extra};
  return {window,timers,delays,run(){const [id,fn]=timers.entries().next().value;timers.delete(id);delays.delete(id);return fn();}};
}
function load(file,mocks={},globals={}) {
  const module={exports:{}};
  const js=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React,jsxFactory:'window.SP_REACT.createElement',esModuleInterop:true}}).outputText;
  vm.runInNewContext(js,{module,exports:module.exports,require:name=>{assert.ok(Object.hasOwn(mocks,name),'Unmocked import: '+name);const result=mocks[name];return result && typeof result==='object' && 'default' in result ? {...result,__esModule:true} : result;},console,Promise,Map,Set,WeakMap,WeakSet,Error,DOMException,AbortController,Number,Date,process:{env:{ROLLUP_ENV:'production'}},...globals},{filename:file});
  return module.exports;
}
function fakeDocument() {
 const styles=new Map();
 return {styles,head:{append(el){styles.set(el.id,el);}},getElementById:id=>styles.get(id),createElement:()=>({remove(){styles.delete(this.id);}})};
}
function flatten(node) {if(Array.isArray(node))return node.flatMap(flatten);return node?[node,...flatten(node.props?.children)]:[];}
const checkpoint = () => new Promise(resolve=>setImmediate(resolve));

test('Steam window resolver survives startup and prefers the live gamepad window over desktop',()=>{
 const desktop={document:fakeDocument(),location:{pathname:'/index.html'}};
 const big={document:fakeDocument(),location:{pathname:'/routes/library/home'}};
 const env=clock({document:null,SteamUIStore:{WindowStore:{SteamUIWindows:[]}}});
 const api=load('src/utils/steamWindow.ts',{'@decky/ui':{findSP:()=>{throw Error('not ready');}}},env);
 assert.equal(api.findSteamUI(),null);
 env.window.document=fakeDocument(); assert.equal(api.findSteamUI().window,env.window);
 env.window.SteamUIStore.WindowStore.SteamUIWindows=[{IsGamepadUIWindow:()=>true,IsGamepadUIOverlayWindow:()=>false,BrowserWindow:big}];
 const withDesktop=load('src/utils/steamWindow.ts',{'@decky/ui':{findSP:()=>({window:desktop})}},env);
 assert.equal(withDesktop.findSteamUI().window,big);
 big.closed=true;assert.equal(withDesktop.findSteamUI().window,env.window);
});

test('styles queued before head exists are restored, updated, and removed without touching foreign CSS',()=>{
 let doc=null;const api=load('src/utils/styleInjector.ts',{'./steamWindow':{findSteamUI:()=>doc?{window:{document:doc}}:null}},{window:{}});
 assert.equal(api.addStyle('own','old'),false);
 doc=fakeDocument();assert.deepEqual(Array.from(api.restoreStylesTo(doc)),['own']);
 api.addStyle('own','new');assert.equal(doc.getElementById('own').textContent,'new');
 const second=fakeDocument();api.restoreStylesTo(second);assert.equal(second.getElementById('own').textContent,'new');
 second.styles.set('foreign',{textContent:'untouched'});api.removeStyle('own');
 assert.equal(doc.styles.size,0);assert.equal(second.styles.size,1);
});

function menuHarness(){
 let module;const navigated=[];const env=clock();
 const mocks={'react':React,'../utils/log':{default:noop},'@decky/ui':{
  findModuleByExport:predicate=>module && Object.values(module).some(predicate)?module:undefined,
  applyHookStubs:()=>({}),removeHookStubs:noop,MenuItem:'MenuItem',Navigation:{Navigate:id=>navigated.push(id)},
 }};
 const api=load('src/patches/contextMenuPatch.tsx',mocks,env);
 return {api,navigated,setModule:m=>module=m};
}
function menuClass() {
 return class GameMenu {
  constructor(appid){this.props={overview:{appid}};}
  GetTargetApps(){return this.props.apps ?? [this.props.overview];}
  render(){return React.createElement('Menu',null,React.createElement('Play',{}),React.createElement(React.Fragment,null,React.createElement('Separator',{}),React.createElement('Properties',{onSelected:()=>this.props.navigator.AppProperties(this.props.overview.appid)})));}
 };
}
test('lazy current-Steam menu resolution retries; nested Properties, current app ID and immutable children work',()=>{
 const h=menuHarness(),GameMenu=menuClass();const descriptor=Object.getOwnPropertyDescriptor(GameMenu.prototype,'render');
 const handle=h.api.default();assert.equal(handle.ensure(),false);
 // Same factory markers and outer class shape as the supplied September Steam chunk.
 function Factory(){return React.createElement(GameMenu,{navigator:{}});}
 function marker(){return ({LibraryContextMenu:'steam-class'}).LibraryContextMenu;}
 h.setModule({Factory,marker});assert.equal(handle.ensure(),true);
 const menu=new GameMenu(17);const tree=menu.render(),nodes=flatten(tree);
 const added=nodes.filter(n=>n.key==='playhub-artworks-change-artwork');assert.equal(added.length,1);
 const fragment=nodes.find(n=>n.type==='fragment');assert.deepEqual(Array.from(fragment.props.children,n=>n.type),['Separator','Properties','Properties']);
 added[0].props.onSelected();assert.deepEqual(h.navigated,['/playhub-artworks/17']);
 menu.props.overview.appid=99;flatten(menu.render()).find(n=>n.key==='playhub-artworks-change-artwork').props.onSelected();assert.equal(h.navigated[1],'/playhub-artworks/99');
 const frozen=React.createElement('Menu',null,Object.freeze([React.createElement('Properties',{onSelected:()=>({}).AppProperties()})]));
 Object.freeze(frozen.props);Object.freeze(frozen);
 assert.equal(flatten(h.api.injectArtworkMenuItem(frozen,5)).filter(n=>n.key==='playhub-artworks-change-artwork').length,1);
 assert.equal(frozen.props.children.length,1);
 handle.unpatch();assert.deepEqual(Object.getOwnPropertyDescriptor(GameMenu.prototype,'render'),descriptor);assert.equal(handle.ensure(),false);
});
test('menu skips multi-selection and unknown app IDs; hot reload installs exactly one wrapper',()=>{
 const h=menuHarness(),GameMenu=menuClass(),original=GameMenu.prototype.render;
 const first=h.api.default(GameMenu),second=h.api.default(GameMenu);first.unpatch();
 const menu=new GameMenu(42);assert.equal(flatten(menu.render()).filter(n=>n.key==='playhub-artworks-change-artwork').length,1);
 menu.props.apps=[{appid:42},{appid:43}];assert.equal(flatten(menu.render()).filter(n=>n.key==='playhub-artworks-change-artwork').length,0);
 menu.props.apps=[{appid:undefined}];assert.equal(flatten(menu.render()).filter(n=>n.key==='playhub-artworks-change-artwork').length,0);
 assert.equal(GameMenu.prototype.shouldComponentUpdate,undefined);
 second.unpatch();assert.equal(GameMenu.prototype.render,original);
});

test('provider failures preserve 404 identity; successful pages are deduplicated; autocomplete does not select sequels',()=>{
 const api=load('src/utils/searchResults.ts');const error=Object.assign(new Error('Game not found'),{status:404});
 assert.throws(()=>api.combineAssetSearchResults([{status:'rejected',reason:error}]),e=>e===error);
 const assets=api.combineAssetSearchResults([{status:'rejected',reason:error},{status:'fulfilled',value:[{url:'one'},{url:'one'},{url:'two'}]}]);
 assert.equal(assets.length,2);
 assert.equal(api.exactTitleMatch('Game',[{id:2,name:'Game 2'}]),undefined);
 assert.equal(api.exactTitleMatch('Café™ — Game',[{id:1,name:'Cafe Game'}]).id,1);
});

function layoutHarness(call){
 const writes=[],applies=[];const cached=JSON.stringify({square:true,recents:'cover',hero:true});
 const env=clock({localStorage:{getItem:()=>cached,setItem:(...args)=>writes.push(args)}});
 const api=load('src/patches/layoutPatchController.ts',{'@decky/api':{call},'../utils/steamWindow':{findSteamUI:()=>env},'../utils/log':{default:noop},
 './homePatch':{addHomePatch:(_m,square)=>{applies.push(square);return true;},removeHomePatch:noop},
 './homeHeroPatch':{applyHomeHeroCentering:()=>true},'./squareLibraryPatch':{addSquareLibraryPatch:()=>true,removeSquareLibraryPatch:noop},'./homeRecentCover':{applyCachedHomeRecentCover:noop}},env);
 return {api,env,writes,applies};
}
test('backend outage preserves cached square/cover/hero settings; retries continue after a minute and stop on unload',async()=>{
 const h=layoutHarness(async()=>{throw Error('socket closed');});h.api.applyCachedLayout();
 for(let i=0;i<32;i++)await h.api.refreshLayoutPatches(true);
 assert.equal(h.api.currentLayoutSettings().square,true);assert.equal(h.api.currentLayoutSettings().coverRecents,true);
 assert.equal(h.writes.length,0);assert.equal(h.applies.every(Boolean),true);
 assert.equal([...h.env.delays.values()][0],15000);
 h.api.stopLayoutPatches();assert.equal(h.env.timers.size,0);
});
test('out-of-order settings requests cannot overwrite the newest settings',async()=>{
 const first=[];let calls=0;
 const values={library_cover_format:'portrait',home_recent_format:'banner',home_hero_center:false};
 const h=layoutHarness((_method,key)=>++calls<=3?new Promise(resolve=>first.push(resolve)):Promise.resolve(values[key]));
 const pending=h.api.refreshLayoutPatches();await h.api.refreshLayoutPatches();
 first[0]('square');first[1]('cover');first[2](true);await pending;
 assert.equal(h.api.currentLayoutSettings().square,false);assert.equal(h.writes.length,1);h.api.stopLayoutPatches();
});
test('Home retries reuse a single route/tree patch; toggles do not add layers',()=>{
 const env=clock();let routes=0,removed=0;const types=[];
 const classes={Container:'container',PortraitImage:'portrait',InRecentGames:'recents',LabelHeight:'52px'};
 const api=load('src/patches/homePatch.tsx',{'@decky/api':{routerHook:{addPatch:(_path,fn)=>{routes++;return fn;},removePatch:()=>removed++}},
 '@decky/ui':{afterPatch:()=>({unpatch:noop}),createReactTreePatcher:()=>noop,findInReactTree:noop},
 '../static-classes':{libraryAssetImageClasses:classes,appportraitClasses:classes,homeCarouselClasses:classes,sel:(obj,key)=>obj[key]?'.'+obj[key]:''},
 '../utils/styleInjector':{removeStyle:noop,updateStyle:()=>true},'../utils/log':{default:noop},'../utils/steamRoute':{steamPath:()=>'/library/home'},
 './carouselWidthPatch':{addCarouselWidthPatch:()=>types.push(true),removeCarouselWidthPatch:noop,setCarouselWidthSquare:noop},'./patchUtils':{rerenderAfterPatchUpdate:noop}},env);
 for(let i=0;i<5;i++)assert.equal(api.addHomePatch(true,true),true);
 assert.equal(api.addHomePatch(false,false),true);assert.equal(routes,1);
 api.removeHomePatch(true);assert.equal(removed,1);
});

test('8K source is accepted but bounded before output; pathological dimensions remain rejected',()=>{
 const api=load('src/utils/imageSafety.ts');
 const image={naturalWidth:7680,naturalHeight:4320};
 assert.doesNotThrow(()=>api.assertImageDimensions(image,true));assert.throws(()=>api.assertImageDimensions(image),/PA_ERROR_ARTWORK_TOO_LARGE/);
 const [w,h]=api.boundedArtworkSize(7680,4320);assert.ok(w*h<=16000000&&w<=6144&&h<=6144);assert.ok(Math.abs(w/h-16/9)<0.001);
 assert.throws(()=>api.assertImageDimensions({naturalWidth:16000,naturalHeight:16000},true),/PA_ERROR_ARTWORK_TOO_LARGE/);
 assert.throws(()=>api.boundedArtworkSize(NaN,10),/PA_ERROR_INVALID_ARTWORK/);
});
test('image decode abort releases source; composition queue releases after a failure',async()=>{
 const env=clock();let image;
 class Image {constructor(){image=this;this.naturalWidth=1;this.naturalHeight=1;}}
 const api=load('src/utils/imageSafety.ts',{}, {...env,Image});const abort=new AbortController();
 const pending=api.loadSafeImage('data:image/png;base64,AA==',abort.signal);abort.abort();await assert.rejects(pending,/PA_OPERATION_CANCELLED/);assert.equal(image.src,'');assert.equal(env.timers.size,0);
 await assert.rejects(api.withCompositionLock(async()=>{throw Error('fail');}),/fail/);
 assert.equal(await api.withCompositionLock(async()=>42),42);
});
test('normalizer preserves small PNG and animated WebM; large static PNG is resized without losing alpha',async()=>{
 let dims=[7680,4320],drawn,canvases=0,loads=0;
 const safety=load('src/utils/imageSafety.ts');
 const canvas={getContext:()=>({drawImage:(...args)=>drawn=args}),width:0,height:0};
 const api=load('src/utils/normalizeArtworkPayload.ts',{'./imageSafety':{...safety,loadSafeImage:async()=>{loads++;return {naturalWidth:dims[0],naturalHeight:dims[1]};},canvasToBase64:async(_c,format)=>{assert.equal(format,'png');return 'resized';},releaseImage:noop,releaseCanvas:noop}}, {document:{createElement:()=>{canvases++;return canvas;}}});
 const result=await api.normalizeArtworkPayload({data:'AAAA',format:'png'});assert.equal(result.data,'resized');assert.equal(result.format,'png');assert.ok(canvas.width*canvas.height<=16000000);assert.equal(drawn[3],canvas.width);
 dims=[600,900];const small=await api.normalizeArtworkPayload({data:'AAAA',format:'png'});assert.equal(small.data,'AAAA');assert.equal(canvases,1);
 const before=loads;const video=await api.normalizeArtworkPayload({data:'AAAA',format:'webm',animated:true});assert.equal(video.format,'png');assert.equal(loads,before);
 dims=[7680,4320];await assert.rejects(api.normalizeArtworkPayload({data:'AAAA',format:'webp',animated:true}),/PA_ERROR_ARTWORK_TOO_LARGE/);
});
test('synchronous Steam app-details callback does not leak a subscription or create a timeout',async()=>{
 let unregistered=0,timers=0;
 const api=load('src/utils/getAppDetails.ts',{}, {SteamClient:{Apps:{RegisterForAppDetails:(_id,callback)=>{callback({appid:12});return {unregister(){unregistered++;}};}}},setTimeout:()=>timers++,clearTimeout:noop});
 assert.equal((await api.default(12)).appid,12);assert.equal(unregistered,1);assert.equal(timers,0);
});
test('logger is single-flight and clears queued RPCs on unload',async()=>{
 const env=clock();let resolve,calls=0;
 const api=load('src/utils/log.ts',{'@decky/api':{call:()=>{calls++;return new Promise(r=>resolve=r);}},'./steamRoute':{steamPath:()=>'/library/home'}},env);
 for(let i=0;i<30;i++)api.default('event',i);assert.equal(env.timers.size,1);
 env.run();await checkpoint();assert.equal(calls,1);assert.equal(env.timers.size,0);
 api.default('during flight');assert.equal(env.timers.size,0);api.stopLogging();resolve();await checkpoint();
 api.default('after stop');assert.equal(calls,1);assert.equal(env.timers.size,0);
});

test('runtime unload immediately cancels progress polling and ignores an in-flight reply',async()=>{
 const env=clock();let resolve,calls=0,reports=0;
 const lifecycle=load('src/utils/runtimeLifecycle.ts');
 const progress=load('src/utils/downloadProgress.ts',{'@decky/api':{call:()=>{calls++;return new Promise(r=>resolve=r);}},'./runtimeLifecycle':lifecycle},env);
 progress.watchDownloadProgress('job',()=>reports++);
 const poll=[...env.timers.values()][0];poll();poll();assert.equal(calls,1);
 lifecycle.stopRuntime();assert.equal(env.timers.size,0);resolve({percent:50});await checkpoint();assert.equal(reports,0);
 progress.watchDownloadProgress('late',()=>reports++);assert.equal(env.timers.size,0);
});

test('PNG conversion shrinks within the byte budget rather than stripping transparency',async()=>{
 const safety=load('src/utils/imageSafety.ts');let attempts=0;
 const canvas={width:0,height:0,getContext:()=>({drawImage:noop})};
 const api=load('src/utils/normalizeArtworkPayload.ts',{'./imageSafety':{...safety,loadSafeImage:async()=>({naturalWidth:3840,naturalHeight:2160}),
 canvasToBase64:async(_canvas,format)=>{assert.equal(format,'png');if(++attempts===1)throw Error('PA_ERROR_ARTWORK_TOO_LARGE');return 'bounded';},releaseImage:noop,releaseCanvas:noop}},
 {document:{createElement:()=>canvas}});
 assert.equal((await api.normalizeArtworkPayload({data:'AAAA',format:'webp'})).data,'bounded');
 assert.equal(attempts,2);assert.equal(canvas.width,2880);assert.equal(canvas.height,1620);
});
