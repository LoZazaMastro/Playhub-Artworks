// Exact installed Steam methods; this inert fixture never loads or invokes Steam.
'use strict';
const j=()=>{};const e={jsx:(type,props,key)=>({type,props,key})};const l={Z:'nav'};const s={xA:'grid'};const B={b$:()=>({current:null})};
function steamAutobind(o,e,s){return{get(){let c=s.value.bind(this);return Object.prototype.hasOwnProperty.call(this,e)||Object.defineProperty(this,e,{value:c}),c}}}
class Carousel {
 constructor(props,doc){this.props=props;this.state={nRightPadding:11,nContainerWidth:1280};this.m_refContainer={current:doc?{ownerDocument:doc}:null};this.m_mapRefs=new Map();this.m_activeScrollTo=null;this.m_refGrid={recomputeGridSize(){}};}
 get alignment(){return this.props.scrollToAlignment||'start'}
 get nIndexLeftmost(){return this.props.nIndexLeftmost??0}
GetCellColumnWidth(y){let{fnGetColumnWidth:x}=this.props,T=x(y.index)+this.props.nItemMarginX;return y.index==this.props.nNumItems-1&&(T+=this.state.nRightPadding),T}
CellRenderer(y){const{fnGetColumnWidth:x,fnGetId:E,fnItemRenderer:T,nItemHeight:L,autoFocus:R}=this.props,{key:P,columnIndex:O,style:v}=y,z=x(O),p=parseInt(v.left?.toString()??"0"),C=E(O),k=!this.m_mapRefs.has(C),H=this.m_mapRefs.get(C)||(0,B.b$)();return this.m_mapRefs.set(C,H),(0,e.jsx)(l.Z,{navKey:P,navRef:H,focusable:!1,onGamepadDirection:this.OnGamepadDirection,autoFocus:R&&O==this.props.focusedColumn&&k,"data-id":C,onFocus:q=>this.OnItemFocused(q,O),style:v,preferredFocus:O==this.props.focusedColumn,role:"listitem","aria-setsize":this.props.nNumItems,"aria-posinset":O+1,children:T(O,z,L,p)},P)}
render(){const{className:y,nNumItems:x,nHeight:E,nItemHeight:T,overscan:L=3,scrollToAlignment:R,focusedColumn:P,autoHeight:O,"aria-label":v,navEntryPreferPosition:z}=this.props,p={overflow:"visible"},C=this.state.nContainerWidth;return j("Inner render",this.props.name,this.props.nNumItems,C,this.nIndexLeftmost,P),(0,e.jsx)(l.Z,{ref:this.m_refContainer,"flow-children":"row",onButtonDown:this.OnGamepadButtonDown,focusable:!1,navEntryPreferPosition:z,children:C&&(0,e.jsx)(s.xA,{role:"generic",containerRole:"list",ref:this.BindGridObject,containerProps:{ref:this.m_refGridContainer},className:y,cellRenderer:this.CellRenderer,onScroll:this.OnScroll,onSectionRendered:this.OnSectionRendered,columnCount:x,columnWidth:this.GetCellColumnWidth,overscanColumnCount:L,overscanIndicesGetter:({cellCount:k,overscanCellsCount:H,startIndex:q,stopIndex:U})=>({overscanStartIndex:Math.max(0,q-H),overscanStopIndex:Math.min(k-1,U+H)}),rowCount:1,rowHeight:T,height:E,width:C,containerStyle:p,scrollToAlignment:this.alignment,scrollToColumn:P,tabIndex:null,autoHeight:O})})}
}
const autobind=steamAutobind;
for(const name of ['GetCellColumnWidth','CellRenderer']) {const descriptor=Object.getOwnPropertyDescriptor(Carousel.prototype,name);Object.defineProperty(Carousel.prototype,name,{...autobind(Carousel.prototype,name,descriptor),configurable:true});}
module.exports=Carousel;
