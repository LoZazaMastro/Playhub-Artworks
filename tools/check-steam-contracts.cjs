#!/usr/bin/env node
// Read-only contract scan. Steam client code is neither executed nor copied into the release.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const directory=process.argv[2];
if(!directory||!fs.statSync(directory).isDirectory())throw Error('Usage: node tools/check-steam-contracts.cjs <extracted Steam files directory>');
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):[path.join(dir,e.name)]);
const checks={
 'Steam window exposes memory history':/get History\(\)\{return this\.m_history\}/,
 'main gamepad predicate is available':/IsMainGamepadUIWindow\(\)\{/,
 'React memo and forwardRef symbols exist':/react\.memo[\s\S]{0,1000}react\.forward_ref|react\.forward_ref[\s\S]{0,1000}react\.memo/,

 'game-specific menu factory uses navigator props':/function\s+\w+\(\w+\)\{[^{}]{0,150}return[^{}]{0,100}\{navigator:\w+,instance:/,
 'game menu exposes live target apps':/GetTargetApps\(\)\{return this\.props\.includeMultiSelect/,
 'menu Properties action remains identifiable':/onSelected:\(\)=>this\.props\.navigator\.AppProperties\(/,
 'game-menu export marker remains available':/\.LibraryContextMenu/,
 'carousel native column-width method exists':/GetCellColumnWidth\(\w+\)\{let\{fnGetColumnWidth:/,
 'carousel width is decorated/bound':/prototype,"GetCellColumnWidth",/,
 'carousel scroll method exists':/SendScrollNotification\(/,
 'portrait artwork CSS module keys exist':/PortraitImage:/,
 'gamepad library CSS module key exists':/GamepadLibrary:/,
 'home recents scope CSS module key exists':/InRecentGames:/,
 'home hero image CSS module key exists':/RecentGamesBackgroundImage:/,
 'custom artwork write API exists':/SetCustomArtworkForApp/,
 'custom logo-position API exists':/SetCustomLogoPositionForApp/,
 'app-details subscription API exists':/RegisterForAppDetails/,
 'custom landscape URL getter retains Steam spelling':/GetCustomLandcapeImageURLs/,
};
const results=Object.fromEntries(Object.keys(checks).map(key=>[key,[]]));
const hashes={};let scanned=0;
for(const file of files(directory).filter(f=>f.endsWith('.js'))){
 const bytes=fs.readFileSync(file),text=bytes.toString('utf8');scanned++;
 for(const [name,pattern]of Object.entries(checks))if(pattern.test(text)){
  const relative=path.relative(directory,file).split(path.sep).join('/');results[name].push(relative);
  hashes[relative]=crypto.createHash('sha256').update(bytes).digest('hex');
 }
}
const missing=Object.keys(results).filter(name=>!results[name].length);
console.log(JSON.stringify({scope:'Static contracts in user-supplied Steam files; not a live Steam/Decky integration test',scannedJavaScriptFiles:scanned,
 checks:Object.fromEntries(Object.entries(results).map(([name,matches])=>[name,{passed:matches.length>0,matches}])),matchedFileSha256:hashes,missing},null,2));
if(missing.length)process.exitCode=1;
