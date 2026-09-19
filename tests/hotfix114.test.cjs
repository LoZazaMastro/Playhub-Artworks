const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('../tools/typescript.cjs'),React=require('./react-fixture.cjs');
const root=path.resolve(__dirname,'..'),noop=()=>{};
function load(file,mocks={},globals={},sourceRoot=root){
 const module={exports:{}};
 const js=ts.transpileModule(fs.readFileSync(path.join(sourceRoot,file),'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.React,jsxFactory:'window.SP_REACT.createElement',esModuleInterop:true}}).outputText;
 vm.runInNewContext(js,{module,exports:module.exports,require:id=>{if(id==='../pluginMenuSection')return load('src/pluginMenuSection.ts',{},globals);if(id==='react')return React;if(!(id in mocks))throw Error('Unmocked '+id);const out=mocks[id];return out&&typeof out==='object'&&'default' in out?{...out,__esModule:true}:out;},console,Symbol,Map,Set,WeakMap,WeakSet,Error,Promise,Date,Object,process:{env:{ROLLUP_ENV:'production'}},...globals},{filename:file});return module.exports;
}
function env(path='/index.html'){
 const listeners=new Map();return {SP_REACT:React,closed:false,document:{head:{}},location:{pathname:path,href:'https://steamloopback.host'+path},localStorage:{getItem:()=>null,setItem:noop},
 addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn)},removeEventListener(name,fn){listeners.get(name)?.delete(fn)},listeners};
}
function render(node,depth=0){
 assert.ok(depth<40,'No recursive wrappers');if(Array.isArray(node))return node.map(x=>render(x,depth+1));if(!React.isValidElement(node))return node;
 let type=node.type;while(type?.$$typeof===Symbol.for('react.memo'))type=type.type;
 if(type?.$$typeof===Symbol.for('react.forward_ref'))return render(type.render(node.props,node.props.ref),depth+1);
 if(typeof type==='function')return render(type.prototype?.isReactComponent?new type(node.props).render():type(node.props),depth+1);
 assert.ok(type!==undefined,'No undefined component type');return {...node,props:{...node.props,children:render(node.props.children,depth+1)}};
}
const flatten=node=>Array.isArray(node)?node.flatMap(flatten):React.isValidElement(node)?[node,...flatten(node.props.children)]:[];
const patchModule=()=>load('src/utils/reactOutputPatch.ts');

test(`hotfix tests use ${React.version==='contract-mock'?'explicit React contract mock':'Steam React '+React.version}`,()=>assert.ok(React.Component&&React.memo));
test('main gamepad memory history wins over shared index URL, keyboard and overlay',()=>{
 const window=env(),big=env(),keyboard=env('/routes/library/home'),overlay=env('/routes/library/home');
 const main={IsMainGamepadUIWindow:()=>true,BrowserWindow:big,History:{location:{pathname:'/library/home'}}};
 window.SteamUIStore={WindowStore:{SteamUIWindows:[{IsGamepadUIWindow:()=>true,IsStandaloneKeyboardWindow:()=>true,BrowserWindow:keyboard},{IsGamepadUIWindow:()=>true,IsGamepadUIOverlayWindow:()=>true,BrowserWindow:overlay},main]}};
 const resolver=load('src/utils/steamWindow.ts',{'@decky/ui':{findSP:()=>({window})}},{window});
 assert.equal(resolver.findSteamUI().window,big);assert.equal(resolver.findSteamUI().path,'/library/home');
 const route=load('src/utils/steamRoute.ts',{'./steamWindow':resolver},{window});assert.equal(route.isHomeRoute(),true);
 main.History.location.pathname='/library/collection/7';assert.equal(route.isHomeRoute(),false);assert.equal(route.isSquareLibraryRoute(),true);
 big.closed=true;assert.equal(resolver.findSteamUI().window,window);
});
test('closed/cross-origin windows and history getters fail without throwing',()=>{
 const window=env();window.SteamUIStore={WindowStore:{SteamUIWindows:[{IsMainGamepadUIWindow:()=>true,get BrowserWindow(){throw Error('closed')}}]}};
 const resolver=load('src/utils/steamWindow.ts',{'@decky/ui':{findSP:()=>{throw Error('late')}}},{window});assert.equal(resolver.findSteamUI().window,window);
 const route=load('src/utils/steamRoute.ts',{'./steamWindow':{findSteamUI:()=>{throw Error('recreated')}}},{window});assert.equal(route.steamPath(),'');assert.equal(route.steamHref(),'');
});
for(const kind of ['function','memo','forwardRef','class'])test(`${kind}: immutable output transform keeps live props, key/ref and stable identity`,()=>{
 const {createOutputPatch}=patchModule(),ref={current:null};let calls=0;
 const Inner=props=>{calls++;return React.createElement('span',{value:props.value,ref:props.ref})};
 const type=kind==='memo'?React.memo(Inner,(a,b)=>a.value===b.value):kind==='forwardRef'?React.forwardRef((props,r)=>Inner({...props,ref:r})):kind==='class'?class extends React.Component{render(){return Inner(this.props)}}:Inner;
 const before=type.render;const p=createOutputPatch([()=>true],tree=>React.cloneElement(tree,{patched:true}),()=>assert.fail('unexpected transform error'));
 const make=value=>{const node=React.createElement(type,{key:'same',ref,value});Object.freeze(node.props);Object.freeze(node);return node;};
 const a=make(1),one=p.apply(a),two=p.apply(make(2));assert.equal(a.type,type);assert.equal(one.type,two.type);assert.equal(one.key,'same');assert.equal(one.props.ref,ref);assert.equal(type.render,before);
 assert.equal(render(one).props.value,1);assert.equal(render(two).props.value,2);assert.equal(render(two).props.patched,true);assert.equal(calls,3);
 assert.equal(p.apply(one),one);p.stop();assert.equal(render(two).props.patched,undefined);
});
test('unsupported lazy types are not resolved or invoked during patch discovery',()=>{
 const {createOutputPatch}=patchModule();let calls=0;const type={$$typeof:Symbol.for('react.lazy'),_init(){calls++;throw Error('must not run')}};
 const node=React.createElement(type,{}),p=createOutputPatch([()=>true],x=>x,noop);assert.equal(p.apply(node),node);assert.equal(calls,0);
});
test('a plugin output-transform error returns the native output without hiding native render errors',()=>{
 const {createOutputPatch}=patchModule();let reported=0;const tree=React.createElement('span',{native:true});const p=createOutputPatch([()=>true],()=>{throw Error('transform')},()=>reported++);
 assert.equal(render(p.apply(React.createElement(()=>tree))).props.native,true);assert.equal(reported,1);
 const originalError=Error('native');assert.throws(()=>render(p.apply(React.createElement(()=>{throw originalError}))),e=>e===originalError);
});
test('home recent-cover option works through memo/forwardRef layers, switches off and unloads without navigation',()=>{
 const window=env();let callback,removed=0,navigated=0;const {createOutputPatch}=patchModule();
 const api=load('src/patches/homeRecentCover.ts',{'@decky/api':{call:async()=>true,routerHook:{addPatch:(_,fn)=>{callback=fn;return fn},removePatch:()=>removed++}},'../utils/steamWindow':{findSteamUI:()=>({window})},'../utils/reactOutputPatch':{createOutputPatch},'../utils/log':{default:noop},'./patchUtils':{rerenderAfterPatchUpdate:()=>navigated++}},{window});
 const Games=props=>React.createElement('span',{featured:props.showFeaturedItem});
 const Recents=React.memo(()=>React.createElement('div',{},React.createElement(Games,{games:[1],onItemFocus:noop,autoFocus:true,showFeaturedItem:true})));
 const Home=React.forwardRef(()=>React.createElement('section',{},React.createElement(Recents,{autoFocus:true,showBackground:true})));
 const Root=React.memo(()=>React.createElement(Home));const child=React.createElement(Root);Object.freeze(child.props);Object.freeze(child);const props=Object.freeze({children:child});
 api.setHomeRecentCover(true,true);const patched=callback(props);assert.notEqual(patched,props);assert.equal(props.children.type,Root);
 assert.equal(flatten(render(patched.children)).find(x=>x.type==='span').props.featured,false);
 assert.equal(callback(props).children.type,patched.children.type);
 api.setHomeRecentCover(false,true);assert.equal(flatten(render(patched.children)).find(x=>x.type==='span').props.featured,true);
 api.stopHomeRecentCover();assert.equal(removed,1);assert.equal(navigated,0);assert.equal(flatten(render(patched.children)).find(x=>x.type==='span').props.featured,true);
});
test('menu discovery always restores hook dispatchers, including a throwing factory',()=>{
 const window=env();let restored=0,stubbed=0;const original=()=>42,dispatcher={useState:original};
 function factory(){const props={navigator:{}};throw Error('missing context')}
 const api=load('src/patches/contextMenuPatch.tsx',{'@decky/ui':{findModuleByExport:()=>({factory}),applyHookStubs(){stubbed++;dispatcher.useState=noop;return dispatcher},removeHookStubs(){restored++;dispatcher.useState=original},Navigation:{Navigate:noop}},'../utils/log':{default:noop}},{window});
 assert.equal(api.resolveLibraryContextMenu(),undefined);assert.equal(stubbed,1);assert.equal(restored,1);assert.equal(dispatcher.useState,original);
});
test('native context-menu item works even with an undefined DFL.MenuItem export',()=>{
 const window=env(),selected=[];const api=load('src/patches/contextMenuPatch.tsx',{'@decky/ui':{Navigation:{Navigate:id=>selected.push(id)}},'../utils/log':{default:noop}},{window});
 const Item=React.forwardRef(props=>React.createElement('button',props));const anchor=React.createElement(Item,{onSelected:()=>({}).AppProperties()});
 const tree=React.createElement('div',{},anchor);Object.freeze(tree.props);Object.freeze(tree);const patched=api.injectArtworkMenuItem(tree,22);
 const item=flatten(patched).find(x=>x.key==='playhub-artworks-change-artwork');assert.equal(item.type,Item);item.props.onSelected();assert.equal(selected[0],'/playhub-artworks/22');assert.equal(tree.props.children,anchor);
 const unknown=React.createElement('div',{},React.createElement('button',{}));assert.equal(api.injectArtworkMenuItem(unknown,22),unknown);
});
test('diagnostics recognize percent-encoded names, track recreated windows and leave foreign errors alone',()=>{
 const window=env(),old=env();let active=old;const events=[];
 const api=load('src/utils/frontendDiagnostics.ts',{'./log':{default:(...x)=>events.push(x)},'./steamWindow':{findSteamUI:()=>({window:active})},'./build':{ARTWORKS_BUILD:'1.1.4-hotfix.1'}},{window});
 assert.equal(api.isArtworkSource('http://127.0.0.1:1337/plugins/Playhub%20Artworks/dist/index.js'),true);assert.equal(api.isArtworkSource('playhub-artworks/dist/index.js'),true);assert.equal(api.isArtworkSource('another-plugin/dist/index.js'),false);
 const diag=api.createFrontendDiagnostics();assert.equal(window.listeners.get('error').size,1);assert.equal(old.listeners.get('error').size,1);
 for(const fn of old.listeners.get('error'))fn({error:{message:'test',stack:'Error\\n at Playhub%20Artworks/dist/index.js'},filename:'',lineno:12});assert.equal(events.length,1);assert.equal(events[0][2].message,'test');
 for(const fn of old.listeners.get('error'))fn({error:{stack:'another-plugin/dist/index.js'}});assert.equal(events.length,1);
 active=env();diag.sync();assert.equal(old.listeners.get('error').size,0);assert.equal(active.listeners.get('error').size,1);
 diag.stop();diag.sync();assert.equal(window.listeners.get('error').size,0);assert.equal(active.listeners.get('error').size,0);
});
test('plugin-local React boundary logs JS and component stacks and displays a native fallback',()=>{
 const reports=[];const window=env();const api=load('src/components/PluginErrorBoundary.tsx',{'../utils/frontendDiagnostics':{reportFrontendError:(...x)=>reports.push(x)}},{window,navigator:{language:'it'}});
 const boundary=new api.default({area:'test',children:'native child'});assert.equal(boundary.render(),'native child');boundary.state=api.default.getDerivedStateFromError(Error('test'));
 boundary.componentDidCatch(Error('failed'),{componentStack:'at SGDBPage'});assert.equal(reports.length,2);assert.equal(boundary.render().props.role,'alert');
});
// Optional genuine regression reproduction against the prior delivered archive.
test('previous 1.1.4 reproduces original.call on a memo route; hotfix test above renders it safely',{skip:!process.env.ARTWORKS_PREVIOUS_PROJECT},()=>{
 const window=env();let callback;
 const old=load('src/patches/homeRecentCover.ts',{'@decky/api':{routerHook:{addPatch:(_,fn)=>{callback=fn;return fn}},call:noop},'../utils/steamWindow':{findSteamUI:()=>({window})},'@decky/ui':{createReactTreePatcher:()=>noop,findInReactTree:noop,afterPatch(node,key,handler){const original=node[key];node[key]=function(...args){return handler(args,original.call(this,...args))};return {unpatch:noop}}},'./patchUtils':{rerenderAfterPatchUpdate:noop}},{window},process.env.ARTWORKS_PREVIOUS_PROJECT);
 old.setHomeRecentCover(true,true);const child=React.createElement(React.memo(()=>React.createElement('div')));callback({children:child});assert.throws(()=>render(child),/original.call is not a function/);
});
