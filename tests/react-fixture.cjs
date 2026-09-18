// Test helper only. With STEAM_REACT_BUNDLE set, load React from the user's
// supplied Steam webpack bundle. No Steam client file is shipped in this project.
const fs=require('node:fs'),vm=require('node:vm');
function contractReact(){
 class Component {constructor(props){this.props=props;this.state={};} setState(value){Object.assign(this.state,value);}}
 Component.prototype.isReactComponent={};
 return {version:'contract-mock',Component,Fragment:Symbol.for('react.fragment'),
 createElement(type,config,...children){const props={...config};const key=config?.key??null;delete props.key;if(children.length)props.children=children.length===1?children[0]:children;return {$$typeof:Symbol.for('react.transitional.element'),type,key,props};},
 cloneElement(node,props,...children){return {...node,props:{...node.props,...props,...(children.length?{children:children.length===1?children[0]:children}:{})}};},
 isValidElement:node=>node?.$$typeof===Symbol.for('react.transitional.element'),
 forwardRef:render=>({$$typeof:Symbol.for('react.forward_ref'),render}),memo:(type,compare)=>({$$typeof:Symbol.for('react.memo'),type,compare:compare??null}),
 createContext:value=>({Provider:'Provider',Consumer:'Consumer',_currentValue:value})};
}
function fromSteam(file){
 const factories={},cache={};const context=vm.createContext({self:{webpackChunksteamui:{push:chunk=>Object.assign(factories,chunk[1])}},console});
 vm.runInContext(fs.readFileSync(file,'utf8'),context,{filename:'user-supplied-react-bundle.js',timeout:5000});
 const found=Object.entries(factories).find(([,factory])=>factory.toString().includes('react.production.js'));
 if(!found)throw Error('React production factory not found in STEAM_REACT_BUNDLE');
 function requireModule(id){if(cache[id])return cache[id].exports;const module={exports:{}};cache[id]=module;if(!factories[id])throw Error('Missing React dependency '+id);factories[id](module,module.exports,requireModule);return module.exports;}
 const React=requireModule(found[0]);if(!React.createElement||!React.memo||!React.version)throw Error('Invalid React factory');return React;
}
const React=process.env.STEAM_REACT_BUNDLE?fromSteam(process.env.STEAM_REACT_BUNDLE):contractReact();
module.exports=React;
