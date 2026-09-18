const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const noop=()=>{};

function environment(){
 const timers=new Map(),events=new Map(),styles=new Map();let timer=0;
 const React={...require('./react-fixture.cjs'),createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'fragment',
 createContext:value=>({Provider:'Provider',Consumer:'Consumer',_currentValue:value}),forwardRef:fn=>fn,memo:fn=>fn,
 useState:value=>[value,noop],useRef:value=>({current:value}),useMemo:fn=>fn(),useCallback:fn=>fn,useEffect:noop,useContext:ctx=>ctx._currentValue,
 Children:{toArray:value=>[].concat(value??[])},isValidElement:node=>Boolean(node?.type),cloneElement:(node,props,...children)=>({...node,props:{...node.props,...props,children}})};
 if(process.env.STEAM_REACT_BUNDLE)Object.assign(React,require('./react-fixture.cjs'));
 const document={head:{append:el=>styles.set(el.id,el)},body:{classList:{add:noop,remove:noop,contains:()=>false}},
 createElement:tag=>({tag,remove(){styles.delete(this.id);}}),getElementById:id=>styles.get(id),querySelector:()=>null,querySelectorAll:()=>[],
 addEventListener:noop,removeEventListener:noop,documentElement:{classList:{add:noop,remove:noop}},visibilityState:'visible'};
 const window={SP_REACT:React,SP_REACTDOM:{},document,location:{pathname:'/routes/library/home',href:'steam://library/home'},navigator:{language:'en'},console,
 localStorage:{getItem:()=>null,setItem:noop},sessionStorage:{getItem:()=>null,setItem:noop},
 setTimeout:(fn)=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id),
 setInterval:(fn)=>{timers.set(++timer,fn);return timer;},clearInterval:id=>timers.delete(id),
 addEventListener:(name,fn)=>{if(!events.has(name))events.set(name,new Set());events.get(name).add(fn);},removeEventListener:(name,fn)=>events.get(name)?.delete(fn),
 requestAnimationFrame:fn=>{timers.set(++timer,fn);return timer;},cancelAnimationFrame:id=>timers.delete(id),
 getComputedStyle:()=>({getPropertyValue:()=>'',fontSize:'16px'}),SteamUIStore:{WindowStore:{SteamUIWindows:[]}}};
 document.defaultView=window;
 const api={call:async(method,...args)=>method==='get_setting'?args[1]:method==='get_steamgriddb_api_key'?'':true,
 routerHook:{addRoute:noop,removeRoute:noop,addPatch:(_path,fn)=>fn,removePatch:noop},toaster:{toast:noop},openFilePicker:noop,fetchNoCors:async()=>{throw Error('No network in smoke test');}};
 window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit={connect:()=>api};
 const ui={definePlugin:fn=>fn,quickAccessMenuClasses:{},IconsModule:undefined,
 findSP:()=>({window}),findModule:()=>undefined,findClassModule:()=>undefined,findModuleExport:()=>undefined,findModuleByExport:()=>undefined,
 createReactTreePatcher:()=>noop,afterPatch:()=>({unpatch:noop}),findInReactTree:()=>undefined,GamepadButton:{},Navigation:{Navigate:noop}};
 return {timers,events,styles,window,globals:{window,document,DFL:ui,SP_REACT:React,SP_REACTDOM:{},SteamClient:{Settings:{},Apps:{}},navigator:window.navigator,
 console,URL,URLSearchParams,TextEncoder,TextDecoder,AbortController,DOMException,Map,Set,WeakSet,WeakMap,Promise,Error,Date,performance:{now:()=>0},
 setTimeout:window.setTimeout,clearTimeout:window.clearTimeout,setInterval:window.setInterval,clearInterval:window.clearInterval}};
}
const bundlePath=path.join(__dirname,'../dist/index.js');
test('compiled release imports with late Steam modules, mounts twice and fully tears down',async()=>{
 assert.ok(fs.existsSync(bundlePath),'Build dist/index.js before running bundle tests.');
 const env=environment();
 const code=fs.readFileSync(bundlePath,'utf8')
   .replace(/export default (__require\('src\/index\.tsx'\)\.default);/, 'globalThis.__plugin = $1;')
   .replace(/export\s*\{\s*(\w+)\s+as\s+default\s*\};?\s*(?:\/\/# sourceMappingURL=[^\n]+\s*)?$/, 'globalThis.__plugin = $1;');
 const context=vm.createContext(env.globals);
 vm.runInContext(code,context,{filename:'playhub-artworks/dist/index.js',timeout:5000});
 assert.equal(typeof context.__plugin,'function');
 const first=context.__plugin();assert.equal(typeof first.onDismount,'function');
 await new Promise(r=>setImmediate(r));
 const second=context.__plugin();await new Promise(r=>setImmediate(r));
 first.onDismount();second.onDismount();await new Promise(r=>setImmediate(r));
 assert.equal(env.timers.size,0,'No pending intervals/timeouts after unload.');
 assert.equal([...env.events.values()].reduce((n,set)=>n+set.size,0),0,'No event listeners after unload.');
 assert.equal(env.styles.size,0,'No owned CSS left after unload.');
});
