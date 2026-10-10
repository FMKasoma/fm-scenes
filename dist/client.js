'use strict';
const Hmp=Imports.get('hmp-lib');
const state={scenes:[],revision:-1,mode:'always',enabled:true,holding:false,visible:false,config:{maxDistanceMeters:15,key:'lalt',unitsPerMeter:100,promptKey:'SCENE',refreshMs:150}};
let shown='',stopped=false,boundKey='',removeDown=()=>{},removeUp=()=>{};
let roleplayEntries=[];let roleplayMeOffsetCm=0,roleplayDoOffsetCm=100;let lastRoleplayReceived=0;let promptSignature='';let promptPosition=null;let promptUpdated=0;
let placement=null;
let placementTimer=null;
let lastAdjustNotice=0;
let lastPromptPosition=null;
let lastPromptRedraw=0;
const placementBinds=[];

// Multi-label client renderer. The overlay is passive: it never captures gameplay input.
const MULTI_VIEW_URL='fw://resources/fm_scenes/dist/labels.html';
let multiView=-1, multiReady=false, multiFailed=false, multiWarned=false;
let multiLastSend=0, multiStarted=0;
const multiConfig={maxLabels:36,refreshMs:33,defaultFov:85};
function ensureMultiView(){
 if(multiFailed||stopped)return false;
 if(multiView>=0&&!multiReady&&Date.now()-multiStarted>3500){
  console.warn('[fm_scenes] Multi-label overlay did not acknowledge ready; reverting to native prompt.');
  closeMultiView();multiFailed=true;return false;
 }
 if(multiView>=0)return true;
 try{
  const handle=Web.createView(MULTI_VIEW_URL,{visible:false});
  if(!Number.isInteger(handle)||handle<0)throw new Error('Invalid web view handle');
  multiView=handle;multiStarted=Date.now();
  Web.on(multiView,'ready',()=>{
   multiReady=true;
   console.info('[fm_scenes] Multi-label overlay ready');
   try{Web.showView(multiView);}catch(e){console.warn('[fm_scenes] Overlay show failed:',String(e));}
   hide();
   renderMulti(true);
  });
  return true;
 }catch(e){
  multiFailed=true;
  console.warn('[fm_scenes] Multi-label overlay unavailable; native prompt fallback:',String(e));
  return false;
 }
}
function closeMultiView(){
 if(multiView>=0){try{Web.destroyView(multiView);}catch(_){}}
 multiView=-1;multiReady=false;
}
function eligibleLabels(){
 const p=LocalPlayer.getPosition?.();
 if(!validPoint(p))return [];
 const units=Number(state.config.unitsPerMeter||100);
 const max=Number(state.config.maxDistanceMeters||80)*units;
 const inspect=isInspectHeld();
 const now=Date.now();
 const labels=[];
 // Keep both /me and /do from the same character, independently.
 if(now-lastRoleplayReceived<1500){
  for(const actor of roleplayEntries){
   if(!validPoint(actor.position))continue;
   const d=Math.hypot(p.x-actor.position.x,p.y-actor.position.y,p.z-actor.position.z);
   if(typeof actor.me==='string'&&actor.me.trim())labels.push({id:'me:'+actor.id,kind:'me',category:'',text:actor.me,position:{x:actor.position.x,y:actor.position.y,z:actor.position.z+roleplayMeOffsetCm},distance:d});
   if(actor.action?.text&&Number(actor.action.expiresAt)>now)labels.push({id:'do:'+actor.id,kind:'do',category:'',text:String(actor.action.text),position:{x:actor.position.x,y:actor.position.y,z:actor.position.z+roleplayDoOffsetCm},distance:d});
  }
 }
 for(const scene of state.scenes){
  if(!scene||![scene.x,scene.y,scene.z,scene.viewDistance].every(Number.isFinite))continue;
  if(!readableWithoutKey(scene)&&!inspect)continue;
  const d=Math.hypot(p.x-scene.x,p.y-scene.y,p.z-scene.z);
  if(d>Math.min(max,scene.viewDistance))continue;
  labels.push({id:'scene:'+scene.id,kind:'scene',category:getCategory(scene),text:String(scene.text||''),position:{x:scene.x,y:scene.y,z:scene.z},style:scene.style||{},distance:d});
 }
 labels.sort((a,b)=>a.distance-b.distance);
 return labels.slice(0,multiConfig.maxLabels).map(({distance,...label})=>label);
}
function renderMulti(force=false){
 if(placement||stopped)return;
 if(!ensureMultiView()||!multiReady)return;
 const now=Date.now();
 if(!force&&now-multiLastSend<multiConfig.refreshMs)return;
 multiLastSend=now;
 try{
  const capture=Camera.capture?.();
  const origin=getCameraOrigin();
  const rotation=getCameraRotation();
  if(!validPoint(origin))return;
  const fov=Number(capture?.fov??capture?.fieldOfView??multiConfig.defaultFov);
  Web.emit(multiView,'scenes:labels',{
   camera:{position:origin,yaw:rotation.yaw,pitch:rotation.pitch,fov:Number.isFinite(fov)&&fov>=20&&fov<=150?fov:multiConfig.defaultFov},
   labels:eligibleLabels()
  });
 }catch(e){
  if(!multiWarned){console.warn('[fm_scenes] overlay update error:',String(e));multiWarned=true;}
 }
}

const toRad=d=>Number(d||0)*Math.PI/180;
const getCategory=s=>{const c=String(s?.style?.category||'scene').toLowerCase();return c==='writing'||c==='note'?'Writing':c==='letter'?'Letter':c==='parchment'?'Parchment':'Scene';};
const validPoint=p=>p&&[p.x,p.y,p.z].every(Number.isFinite);
function hide(){if(shown){shown='';Hud.hidePrompt();}lastPromptPosition=null;promptSignature='';promptPosition=null;}
function emitPreviewStop(){ try{ Events.emitServer('fm_scenes:placementPreviewStop','{}'); }catch(_){} }
function endPlacement(){ emitPreviewStop(); placement=null; if(placementTimer!==null){clearInterval(placementTimer);placementTimer=null;} while(placementBinds.length)placementBinds.pop()(); hide(); if(multiReady&&multiView>=0){try{Web.showView(multiView);}catch(_){}} }
function placementKey(id,key,fn){try{const dispose=Hmp.input.shortcuts.register({resource:'fm_scenes',id,key,state:'down',priority:100,when:()=>!stopped&&!!placement,handler:fn});if(typeof dispose==='function'){placementBinds.push(dispose);return true;}return false;}catch(e){console.warn('[fm_scenes] Input binding '+key+' unavailable: '+String(e));return false;}}
function getCameraOrigin(){
 try{ const capture=Camera.capture?.(); const p=capture?.position; if(validPoint(p)) return {x:Number(p.x),y:Number(p.y),z:Number(p.z)}; }catch(_){}
 const base=LocalPlayer.getPosition?.(); if(!validPoint(base)) return null;
 const units=Number(state.config.unitsPerMeter||100); const eyeHeightMeters=Number(state.config.fallbackEyeHeightMeters||1.6);
 return {x:Number(base.x), y:Number(base.y), z:Number(base.z)+eyeHeightMeters*units};
}
function getCameraRotation(){
 try{ const capture=Camera.capture?.(); const r=capture?.rotation; if(r&&Number.isFinite(Number(r.yaw))) return {yaw:Number(r.yaw), pitch:Number(r.pitch||0)}; }catch(_){}
 try{ const r=LocalPlayer.getControlRotation?.(); if(r&&Number.isFinite(Number(r.yaw))) return {yaw:Number(r.yaw), pitch:Number(r.pitch||0)}; }catch(_){}
 return {yaw:0,pitch:0};
}
function getPlacementPoint(){
 if(!placement) return null; const origin=getCameraOrigin(); if(!origin) return null; const rot=getCameraRotation();
 const yaw=toRad(rot.yaw), pitch=toRad(rot.pitch), cosPitch=Math.cos(pitch);
 const forward={x:Math.cos(yaw)*cosPitch, y:Math.sin(yaw)*cosPitch, z:Math.sin(pitch)}; const distance=placement.distance;
 return {x:origin.x+forward.x*distance, y:origin.y+forward.y*distance, z:origin.z+forward.z*distance};
}
function sendPreview(force=false){
 if(!placement||!validPoint(placement.position)||!['Letter','Parchment'].includes(placement.category))return;
 const now=Date.now();
 const threshold=Number(placement.previewMoveThreshold||15);
 const last=placement.lastSentPosition;
 const moved=!last || Math.hypot(placement.position.x-last.x,placement.position.y-last.y,placement.position.z-last.z)>=threshold;
 if(!force && !moved && now-(placement.lastSentAt||0)<placement.previewUpdateMs) return;
 placement.lastSentAt=now; placement.lastSentPosition={...placement.position};
 const rot=getCameraRotation();
 try{ Events.emitServer('fm_scenes:placementPreview', JSON.stringify({position:placement.position,yaw:Number(rot.yaw)||0})); }catch(e){ console.warn('[fm_scenes] placement preview sync failed: '+String(e)); }
}
function showPlacement(forceRelocate=false){
 if(!placement) return; const p=placement.position; if(!validPoint(p)){ hide(); return; }
 const label=String(placement.category||'Scene');
 // Native Hud.showPrompt may cache its first world-space anchor. Refresh only
 // when the actual preview point has moved, not every 33ms poll.
 const shift=lastPromptPosition?Math.hypot(p.x-lastPromptPosition.x,p.y-lastPromptPosition.y,p.z-lastPromptPosition.z):Infinity;
 const now=Date.now();
 const redraw=forceRelocate||shown!=='preview'||(shift>=3 && now-lastPromptRedraw>=65);
 if(redraw){
  if(shown){Hud.hidePrompt();shown='';}
  Hud.showPrompt(label,placement.description,p.x,p.y,p.z);
  shown='preview';lastPromptPosition={...p};lastPromptRedraw=now;
 }
 sendPreview(forceRelocate);
}
// Hold-to-move: poll physical key state rather than relying on a one-shot shortcut.
// This mirrors the Key.isDown pattern used by the bundled hmp-admin no-clip controller.
function isHeld(key){
 try{return !!Key.isDown(key);}catch(_){return false;}
}
function tickPlacement(forceRelocate=false){
 if(!placement)return;
 const now=Date.now();
 const dt=placement.lastTick?Math.min(0.075,Math.max(0,(now-placement.lastTick)/1000)):0;
 placement.lastTick=now;
 const farther=isHeld(placement.farKey);
 const closer=isHeld(placement.nearKey);
 const axis=(farther?1:0)-(closer?1:0);
 if(axis!==placement.lastAxis){placement.heldSeconds=0;placement.lastAxis=axis;}
 if(axis){
  placement.heldSeconds+=dt;
  // Ease into full travel speed after a short hold; no discrete increments.
  const ramp=Math.min(1,placement.heldSeconds/placement.accelerationSeconds);
  const speed=placement.slideSpeed*(0.30+0.70*ramp);
  placement.distance=Math.max(placement.min,Math.min(placement.max,placement.distance+axis*speed*dt));
 }
 const next=getPlacementPoint();if(!validPoint(next))return hide();
 placement.position=next;
 showPlacement(forceRelocate);
}
Events.on('fm_scenes:placement',raw=>{
 let d; try{ d=typeof raw==='string'?JSON.parse(raw):raw; }catch{return;} if(!d||!d.position) return;
 endPlacement();
 if(multiView>=0){try{Web.hideView(multiView);}catch(_){}}
 const p=d.position, units=Number(d.units)||100, near=Math.max(0.1,Number(d.minimumDistanceMeters)||0.5)*units, far=Math.max(near,Number(d.maximumDistanceMeters)||10)*units;
 placement={position:{x:p.x,y:p.y,z:p.z},units,min:near,max:far,distance:Math.min(far,Math.max(near,Number(d.previewDistance)||2.5*units)),slideSpeed:Math.max(0.25,Number(d.distanceSlideSpeedMetersPerSecond)||2.5)*units,accelerationSeconds:Math.max(0.01,Number(d.distanceHoldAccelerationMs)||180)/1000,farKey:String(d.distanceFarKey||'e').toLowerCase(),nearKey:String(d.distanceNearKey||'q').toLowerCase(),heldSeconds:0,lastAxis:0,lastTick:0,description:String(d.previewText??'').slice(0,220),category:(()=>{const c=String(d.previewCategory||'scene').toLowerCase(); return c==='writing'||c==='note'?'Writing':c==='letter'?'Letter':c==='parchment'?'Parchment':'Scene';})(), previewUpdateMs:Math.max(20,Number(d.previewMarkerUpdateMs)||50), previewMoveThreshold:Math.max(1,Number(d.previewMarkerMoveThreshold)||15), lastSentAt:0, lastSentPosition:null};
 placementKey('place-confirm','mouse3',()=>{ if(!placement||!validPoint(placement.position)) return; tickPlacement(true); const pos={...placement.position,yaw:getCameraRotation().yaw}; endPlacement(); Events.emitServer('fm_scenes:placementConfirm',JSON.stringify(pos)); });
 placementKey('place-cancel','escape',()=>{ endPlacement(); Events.emitServer('fm_scenes:placementCancel','{}'); });
 // Key.isDown is polled every placement tick; do not register edge-only Q/E shortcuts.
 console.info('[fm_scenes] Hold-to-move controls: farther='+placement.farKey+', closer='+placement.nearKey);
 tickPlacement(true);
 Game.notify('[scenes] Hold '+placement.farKey.toUpperCase()+' to move farther / '+placement.nearKey.toUpperCase()+' to move closer. Middle mouse: save.');
 placementTimer=setInterval(()=>tickPlacement(false),Math.max(16,Math.min(100,Number(d.placementRefreshMs)||33)));
});
function receive(raw){
 let data;try{data=typeof raw==='string'?JSON.parse(raw):raw;}catch{return;}
 if(!data||!Array.isArray(data.scenes)||!Number.isSafeInteger(data.revision)||data.revision<state.revision)return;
 state.revision=data.revision;state.scenes=data.scenes.slice(0,5000);state.config={...state.config,...(data.config||{})};
 const multi=data.multiLabelRenderer||{};
 if(Number.isFinite(Number(multi.refreshMs)))multiConfig.refreshMs=Math.max(16,Math.min(250,Number(multi.refreshMs)));
 if(Number.isFinite(Number(multi.maxLabels)))multiConfig.maxLabels=Math.max(1,Math.min(100,Number(multi.maxLabels)));
 if(Number.isFinite(Number(multi.defaultHorizontalFovDegrees)))multiConfig.defaultFov=Math.max(20,Math.min(150,Number(multi.defaultHorizontalFovDegrees)));
 const nextMode=['always','hold','toggle'].includes(data.mode)?data.mode:'always';
 const nextKey=String(state.config.categoryInspectKey||'lalt').toLowerCase(); const shouldRebind=nextMode!==state.mode || nextKey!==boundKey; if(nextMode!==state.mode){state.holding=false;state.visible=false;} state.mode=nextMode; if(shouldRebind)bind(); scan();
}
// Category visibility is authoritative: classroom/environmental text stays visible,
// while physical notes must be deliberately examined by holding Left Alt.
function readableWithoutKey(scene){
 const category=String(scene?.style?.category||'scene').toLowerCase();
 return category==='scene'||category==='writing'||category==='detail';
}
function isInspectHeld(){
 try{return Key.isDown(String(state.config.categoryInspectKey||'lalt').toLowerCase())===true;}catch(_){return state.holding;}
}
function scan(){
 if(placement){ tickPlacement(false); return; }
 if(ensureMultiView()){
  if(multiReady){hide();renderMulti();}
  else hide();
  return;
 }
 if(stopped||Game.areControlsLocked()){hide();return;}
 const p=LocalPlayer.getPosition();if(!p){hide();return;}
 const maximum=Number(state.config.maxDistanceMeters||80)*Number(state.config.unitsPerMeter||100);
 const inspecting=isInspectHeld();
 let selected=null,best=Infinity;
 // Ephemeral roleplay is anchored above moving characters and takes precedence over static scenes.
 // The native HUD can display only one fm_scenes prompt at a time.
 if(Date.now()-lastRoleplayReceived<1200){
  for(const actor of roleplayEntries){
   if(!validPoint(actor.position))continue;
   const dist=Math.hypot(p.x-actor.position.x,p.y-actor.position.y,p.z-actor.position.z);
   const action=actor.action&&actor.action.expiresAt>Date.now()?actor.action:null;
   const text=action?.text||actor.me;
   if(!text)continue;
   const priority=action?0:1;
   // Position returned by server already satisfies the per-command radius rules.
   const score=priority*1000000+dist;
   if(score<best){best=score;selected={key:'rp:'+actor.id+':'+text,label:'',text,x:actor.position.x,y:actor.position.y,z:actor.position.z+(action?roleplayDoOffsetCm:roleplayMeOffsetCm),follow:true};}
  }
 }
 if(!selected){
  let bestStatic=Infinity;
  for(const s of state.scenes){
   if(!s||![s.x,s.y,s.z,s.viewDistance].every(Number.isFinite))continue;
   if(!readableWithoutKey(s)&&!inspecting)continue;
   const d=Math.hypot(p.x-s.x,p.y-s.y,p.z-s.z);
   if(d<=Math.min(maximum,s.viewDistance)&&d<bestStatic){bestStatic=d;selected={key:'scene:'+s.id+':'+s.text,label:getCategory(s),text:s.text,x:s.x,y:s.y,z:s.z,follow:false};}
  }
 }
 if(!selected){hide();return;}
 const position={x:selected.x,y:selected.y,z:selected.z};
 const shift=promptPosition?Math.hypot(position.x-promptPosition.x,position.y-promptPosition.y,position.z-promptPosition.z):Infinity;
 const now=Date.now();
 const needsUpdate=promptSignature!==selected.key || (selected.follow&&shift>=5&&now-promptUpdated>=75);
 if(needsUpdate){
  if(shown)Hud.hidePrompt();
  Hud.showPrompt(selected.label,selected.text,position.x,position.y,position.z);
  shown=selected.key;promptSignature=selected.key;promptPosition=position;promptUpdated=now;
 }
}

function bind(){
 removeDown();removeUp();removeDown=()=>{};removeUp=()=>{};
 const key=String(state.config.categoryInspectKey||'lalt').toLowerCase();boundKey=key;
 // Fall back to input events if Key.isDown cannot be used by this build.
 try{removeDown=Hmp.input.shortcuts.register({resource:'fm_scenes',id:'visibility-down',key,state:'down',priority:-20,when:()=>!stopped,handler:()=>{state.holding=true;scan();}})||(()=>{});}catch(e){console.warn('[fm_scenes] inspect down key registration failed:',String(e));}
 try{removeUp=Hmp.input.shortcuts.register({resource:'fm_scenes',id:'visibility-up',key,state:'up',priority:-20,when:()=>!stopped,handler:()=>{state.holding=false;scan();}})||(()=>{});}catch(e){console.warn('[fm_scenes] inspect up key registration failed:',String(e));}
}
Events.on('fm_scenes:roleplay',raw=>{
 let data;try{data=typeof raw==='string'?JSON.parse(raw):raw;}catch{return;}
 if(!data||!Array.isArray(data.entries))return;
 roleplayEntries=data.entries.slice(0,64);roleplayMeOffsetCm=Number(data.meOffsetCm??0);roleplayDoOffsetCm=Number(data.doOffsetCm??100);lastRoleplayReceived=Date.now();
});
Events.on('fm_scenes:snapshot',receive);
Events.on('resourceStop',name=>{if(!name||name==='fm_scenes'){stopped=true;clearInterval(timer);removeDown();removeUp();endPlacement();closeMultiView();hide();}});
const timer=setInterval(scan,33);
Events.emitServer('fm_scenes:ready','{}');
console.info('[fm_scenes] multi-label client ready');
