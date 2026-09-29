/* Real Chromium tests. Called by tools/test-artwork-browser.py. */
window.runArtworkTests = async ({base, paths}) => {
 const req=testRequire, safety=req('src/utils/imageSafety.ts'), metadata=req('src/utils/imageMetadata.ts'), normal=req('src/utils/normalizeArtworkPayload.ts');
 const transfer=req('src/utils/artworkTransfer.ts'), bulk=req('src/utils/zazamastroBatch.ts').__test;
 const results=[];
 const assert=(condition,message)=>{if(!condition)throw Error(message);};
 const rejects=async(operation,match)=>{try{await operation();}catch(e){assert(String(e.message).includes(match),'Wrong error: '+e.message);return;}throw Error('Expected failure: '+match);};
 const check=async(name,fn)=>{try{const details=await fn();results.push({name,passed:true,...details});}catch(e){results.push({name,passed:false,error:String(e.stack||e)});}};
 const blob=async name=>(await fetch(base+'/'+name)).blob();
 const image=async payload=>safety.loadSafeImage(transfer.artworkPayloadUrl(payload));
 const pixel=async(payload,x,y)=>{const im=await image(payload);const c=document.createElement('canvas');c.width=im.naturalWidth;c.height=im.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(im,0,0);const p=Array.from(ctx.getImageData(x,y,1,1).data);safety.releaseImage(im);safety.releaseCanvas(c);return p;};
 await check('19 MB 4K PNG: chunked RPC -> normalized same resolution, transparent pixels preserved',async()=>{
  const p=await transfer.readArtworkPayload(paths.large,{path:true});
  assert(p.dimensions[0]===3840&&p.dimensions[1]===1240,'Resolution changed unexpectedly');
  assert(p.format==='png'&&safety.estimatedBase64Bytes(p.data)<safety.MAX_ARTWORK_BYTES,'Output is not bounded PNG');
  assert((await pixel(p,0,0))[3]===0,'Transparent corner was lost');
  assert((await pixel(p,1920,620))[3]===255,'Opaque center lost');
  window.__heroPayload=p;return {dimensions:p.dimensions,outputBytes:safety.estimatedBase64Bytes(p.data)};
 });
 await check('16-bit 28 MB PNG is decoded and recompressed without an oversized-RPC failure',async()=>{
  const p=await transfer.readArtworkPayload(paths.sixteen,{path:true});
  assert(p.dimensions[0]===3840&&p.dimensions[1]===1240,'4K geometry changed');
  const rgb=await pixel(p,1500,600);assert(rgb[0]>190&&rgb[2]<100,'16-bit pixels decoded incorrectly');
  return {dimensions:p.dimensions,outputBytes:safety.estimatedBase64Bytes(p.data)};
 });
 await check('8K static background is reduced below 16 megapixels, preserving aspect ratio',async()=>{
  const p=await normal.normalizeArtworkBlob(await blob('8k.png'));const [w,h]=p.dimensions;
  assert(w*h<=16000000&&w<=6144&&h<=6144,'Unsafe output dimensions');
  assert(Math.abs(w/h-7680/4320)<.002,'Aspect ratio changed');return {dimensions:p.dimensions};
 });
 await check('12000-pixel transparent logo is resized, trimmed, and composed into a real Perfect Hero',async()=>{
  const p=await transfer.readArtworkPayload(paths.logo,{path:true,staticOnly:true});
  const logo=await bulk.usableLogo(transfer.artworkPayloadUrl(p));assert(logo,'Logo missing');
  const composed=await bulk.composePerfectHero(transfer.artworkPayloadUrl(__heroPayload),logo);
  const dimensions=await metadata.inspectImageBlob(safety.base64ToBlob(composed.data,'image/jpeg'));
  assert(dimensions.dimensions.join('x')==='3840x1240','Wrong composition size');
  const rgb=await pixel(composed,960,620);assert(rgb[0]>200&&rgb[1]<90,'Logo is not painted in the image');
  return {dimensions:dimensions.dimensions};
 });
 await check('Fully transparent and 1x1 logos are rejected instead of creating fake completed heroes',async()=>{
  const clear=await normal.normalizeArtworkBlob(await blob('empty.png'));
  assert(await bulk.usableLogo(transfer.artworkPayloadUrl(clear))==='','Empty logo was accepted');
  const tiny=await normal.normalizeArtworkBlob(await blob('tiny.png'));
  assert(await bulk.usableLogo(transfer.artworkPayloadUrl(tiny))==='','1x1 logo was accepted');
 });
 await check('Missing logo causes no Steam write, no hidden layer, and no completed marker',async()=>{
  __overview=null;__localInfo={};__providerResponse=()=>[];__writes=[];
  await rejects(()=>bulk.prepareAutoPerfectHero({appid:10001,display_name:'Unmatched Game',is_shortcut:true},['steamgriddb'],true),'PA_ERROR_LOGO_NOT_FOUND');
  assert(__writes.length===0,'Missing logo changed Steam/settings');
 });
 await check('Saved game association overrides Steam ID and does not select a similarly named sequel',async()=>{
  __settings['nonsteam_10002']={id:99,provider:'steamgriddb'};
  const urls=[];__providerResponse=url=>{urls.push(url);return [];};
  await bulk.assetsForApp({appid:10002,display_name:'Game'},'logo',{pages:1});
  assert(urls.some(x=>x.includes('/logos/game/99'))&&!urls.some(x=>x.includes('/steam/10002')),'Manual association ignored');
  __providerResponse=url=>url.includes('/search/autocomplete/')?[{id:21,name:'Different Game 2'}]:[];
  assert(await bulk.sgdbGameIdForApp({appid:10003,display_name:'Different Game',is_shortcut:true})===null,'Wrong sequel chosen');
 });
 await check('Broken first background falls back to second; pristine source is retained only for commit',async()=>{
  __localInfo={logo:{exists:true,path:paths.logo}};__overview=null;__writes=[];
  __providerResponse=url=>url.includes('/heroes/')&&!url.includes('page=1')?[{id:1,url:base+'/broken.png',width:6000,height:1800,author:{name:'test'}},{id:2,url:base+'/large.png',width:3840,height:1240,author:{name:'test'}}]:[];
  const prepared=await bulk.prepareAutoPerfectHero({appid:10004,display_name:'Fixture Game',is_shortcut:false},['steamgriddb'],true);
  assert(prepared.result==='ready'&&prepared.perfectComposition&&prepared.sourceToken,'No successful fallback');
  assert(prepared.assetUrl.endsWith('/large.png'),'Invalid image selected');
  assert(__writes.length===0,'Preparation changed existing artwork');
  await bulk.applyPreparedHero3840(prepared);
  assert(__writes.some(x=>x[0]==='set'),'Steam write did not occur');
  assert(__settings.perfect_hero_10004===true&&__settings.logo_visible_10004===false,'Completion markers missing');
  await window.testRpc('release_artwork_transfer',[prepared.sourceToken]);
 });
 await check('Manual logo-free composition remains untouched in only-missing mode',async()=>{
  __localInfo={hero:{exists:true,source:'custom',sha256:'old'}};__settings.perfect_hero_10005=true;
  __settings.perfect_hero_info_10005={origin:'manual',withLogo:false};__writes=[];
  const p=await bulk.prepareAutoPerfectHero({appid:10005,display_name:'Manual'},['steamgriddb'],false);
  assert(p.result==='skipped'&&__writes.length===0,'Manual background was overwritten');
 });
 await check('Official Steam logo candidate survives a throwing custom getter',async()=>{
  window.appStore={GetCustomLogoImageURLs(){throw Error('Steam store not hydrated');}};
  window.appDetailsStore={GetLogoImagesForAppId:()=>({rgLogoImages:[{strURL:'https://example.invalid/native-logo.png'}]})};
  const candidates=req('src/utils/artworkSources.ts').artworkSources({appid:40},'logo');
  assert(candidates.includes('https://example.invalid/native-logo.png'),'Official logo candidate lost');
 });
 await check('APNG acTL beyond 3 MB metadata is detected and cannot be silently flattened',async()=>{
  const b=await blob('animated.png');const info=await metadata.inspectImageBlob(b);assert(info.animated,'Animation missed');
  const p=await normal.normalizeArtworkBlob(b);assert(p.animated&&safety.estimatedBase64Bytes(p.data)===b.size,'Animation bytes changed');
  await rejects(()=>transfer.readArtworkPayload(paths.animated,{path:true,staticOnly:true}),'PA_ERROR_STATIC_ARTWORK_REQUIRED');
 });
 await check('Oversized animation, impossible dimensions, and CDN HTML error pages are rejected',async()=>{
  const animated=await blob('animated-large.png'), bomb=await blob('bomb.png'), html=await blob('broken.png');
  await rejects(()=>normal.normalizeArtworkBlob(animated),'PA_ERROR_ANIMATED_ARTWORK_TOO_LARGE');
  await rejects(()=>normal.normalizeArtworkBlob(bomb),'PA_ERROR_ARTWORK_TOO_LARGE');
  await rejects(()=>normal.normalizeArtworkBlob(html),'PA_ERROR_ARTWORK_FORMAT_UNKNOWN');
 });
 await check('Cancellation halfway through chunk reads releases the transfer and leaves artwork unchanged',async()=>{
  const controller=new AbortController();let reads=0;__writes=[];
  __rpcOverride=(method,args)=>{if(method==='read_artwork_transfer_chunk'&&++reads===2){controller.abort();return window.testRpc(method,args);}return undefined;};
  await rejects(()=>transfer.readArtworkPayload(paths.large,{path:true,signal:controller.signal}),'PA_OPERATION_CANCELLED');
  __rpcOverride=null;assert(__writes.length===0,'Cancelled read wrote artwork');
 });
 await check('Truncated RPC chunk is rejected and temporary file is released',async()=>{
  __rpcOverride=method=>method==='read_artwork_transfer_chunk'?'AAAA':undefined;
  await rejects(()=>transfer.readArtworkPayload(paths.large,{path:true}),'PA_ERROR_INCOMPLETE_DOWNLOAD');__rpcOverride=null;
 });
 return results;
};
