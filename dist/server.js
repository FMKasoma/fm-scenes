'use strict';
// fm_scenes HogwartsMP - server-authoritative scenes. Coordinates in Unreal centimetres.
const fs = require('fs');
const path = require('path');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname,'../config.json'),'utf8'));
const Hmp = Imports.get('hmp-lib');
const UI = Imports.get('hmp-ui');
const MySQL = Imports.get('hmp-mysql');
const Core = Imports.get('hmp-core');
const router = Hmp.command.createRouter({prefix:'[fm_scenes]'});
const scenes = new Map();
let booted=false, revision=0;
const pending=new Map();
const preference = new Map();
const roleplayStatuses = new Map(); // ephemeral player-attached /me and /do data
const lastRoleplayCommand = new Map();
const previewMarkers = new Map();
const worldObjects = typeof WorldObject === 'undefined' ? null : WorldObject;
let previewWarningIssued=false;
const CATEGORIES = Object.freeze({scene:'Scene',writing:'Writing',letter:'Letter',parchment:'Parchment'});
const categoryFor = style => {const raw=String(style?.category||'scene').toLowerCase();return raw==='note'?'writing':raw==='detail'?'scene':(CATEGORIES[raw]?raw:'scene');};
const modelFor = style => {
 const cat=categoryFor(style);
 if(cat==='letter') return String(CONFIG.previewMarker?.categoryModels?.letter||'');
 if(cat==='parchment'){
  const variant=String(style?.parchmentVariant||'B').toUpperCase();
  return String(CONFIG.previewMarker?.parchmentVariants?.[variant==='B'?'B':'E']||CONFIG.previewMarker?.categoryModels?.parchment||'');
 }
 return ''; // Scene and Writing have no visible mesh.
};
const propId = id => `fm_scenes:scene:${id}`;
const sceneCategory = style => CATEGORIES[categoryFor(style)];
const visibilityDefaultMeters=style=>Number(CONFIG.visibility.categoryDefaultDistanceMeters?.[categoryFor(style)]||8);
const effectiveViewDistance=s=>s.viewDistance;

const clean = (v,max) => String(v??'').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,max);
const cleanMultiline = (v,max) => String(v??'').replace(/\\n/g,'\n').replace(/\r\n?/g,'\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g,' ').split('\n').map(line=>line.trimEnd()).join('\n').trim().slice(0,max);
const writingQuoted = t => {const v=String(t??'').trim();return v.startsWith('“')&&v.endsWith('”')?v:`“${v.replace(/^[\"“]+|[\"”]+$/g,'')}”`;};
const unquoteWriting = t => String(t??'').replace(/^[\"“]/,'').replace(/[\"”]$/,'');
const identity = p => String(p.accountId ?? p.account?.id ?? p.id);
const asNum = (v,def,min,max) => { const n=Number(v);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):def; };
const units = CONFIG.unitsPerMeter || 100;
const message = (p,text) => UI.notify(p,{title:'Scenes',description:text});
const location = p => {try{return p.location?.()||{};}catch{return {};}};
const worldKey = p => {const loc=location(p);return {areaId:String(loc.areaId??''),regionId:String(loc.regionId??''),virtualWorld:Number(p.virtualWorld??0)};};
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const previewId = player => `fm_scenes:preview:${identity(player)}`;
function markerConfig(){ return CONFIG.previewMarker||{}; }
function clearPreviewMarker(player){
 const id=previewId(player); previewMarkers.delete(id);
 if(!worldObjects||typeof worldObjects.destroy!=='function') return false;
 try{ worldObjects.destroy(id); return true; }catch(error){ console.warn('[fm_scenes] preview marker destroy failed:', error); return false; }
}
function spawnSceneProp(scene){
 const model=modelFor(scene.style);
 if(!model||!worldObjects||typeof worldObjects.create!=='function')return;
 // Prop and text are one scene record. The text anchor uses the same x/y/z, not an offset.
 const transform={x:scene.x,y:scene.y,z:scene.z,yaw:Number(scene.style?.yaw)||0,scale:Number(markerConfig().categoryScales?.[categoryFor(scene.style)])||1,collision:false};
 try{
  const created=worldObjects.create(propId(scene.id),model,transform);
  if(!created) console.warn(`[fm_scenes] WorldObject refused scene prop #${scene.id}: ${model}`);
 }catch(e){console.warn(`[fm_scenes] Scene prop #${scene.id} failed for ${model}:`,e);}
}

function removeSceneProp(id){if(!worldObjects||typeof worldObjects.destroy!=='function')return;try{worldObjects.destroy(propId(id));}catch(_){}}
function upsertPreviewMarker(player,pos,yaw){
 const job=pending.get(identity(player)); if(!job)return false;
 const model=modelFor(job.values.style); if(!model){clearPreviewMarker(player);return false;}
 const cfg=markerConfig();if(cfg.enabled===false)return false;
 if(!worldObjects||typeof worldObjects.create!=='function'){
  if(!previewWarningIssued){previewWarningIssued=true;console.warn('[fm_scenes] WorldObject API unavailable; placement marker disabled.');}return false;
 }
 const id=previewId(player), last=previewMarkers.get(id);
 const opts={x:pos.x,y:pos.y,z:pos.z,yaw:Number(yaw)||0,scale:Number(cfg.categoryScales?.[categoryFor(job.values.style)])||1,collision:false};
 const threshold=Math.max(1,Number(cfg.moveThresholdCm)||15);
 const delta=last?distance(pos,last):Infinity;
 if(last&&last.model===model&&delta<threshold)return true;
 try{
  if(last&&last.model===model){
   // Prefer a true transform update when provided by a later framework build.
   const methods=['update','move','setTransform','setPosition'];
   for(const method of methods){
    if(typeof worldObjects[method]!=='function')continue;
    const ok=worldObjects[method](id,opts);
    if(ok!==false){previewMarkers.set(id,{...opts,created:last.created,model});return true;}
   }
   // HogwartsMP 1.8.0 normally has create/destroy, not an exposed move method.
   // Opt-in bounded respawn keeps physical position matched to text instead of freezing.
   if(cfg.fallbackRecreate!==true)return false;
   const interval=Math.max(120,Number(cfg.recreateIntervalMs)||200);
   if(Date.now()-last.created<interval)return false;
  }
  if(last){worldObjects.destroy(id);previewMarkers.delete(id);}
  const created=worldObjects.create(id,model,opts);
  if(created)previewMarkers.set(id,{...opts,created:Date.now(),model});
  return !!created;
 }catch(error){console.warn('[fm_scenes] preview marker relocation failed:',error);return false;}
}

// /me and /do follow a player, not a static world scene. Nothing is saved to SQL.
const roleConfig=()=>CONFIG.roleplay||{};
const playerId=p=>String(p.id);
function characterOf(player){
 try{return Core.characters.active(player)||Core.sessions.get(player)?.character||null;}catch(_){return null;}
}
function rpName(player){
 const name=String(characterOf(player)?.name||'').trim();
 // hmp-core character names, rather than account nicknames, control /do roleplay identity.
 return clean(name.split(/\s+/)[0]||'Someone',40);
}
function rpReady(player){
 const now=Date.now(), id=playerId(player), last=lastRoleplayCommand.get(id)||0;
 if(now-last<Math.max(250,Number(roleConfig().commandCooldownMs)||700))return false;
 lastRoleplayCommand.set(id,now);return true;
}
function rpSnapshot(viewer){
 const cfg=roleConfig();if(cfg.enabled===false)return;
 const view=viewer.position;
 if(!validPosition(view))return;
 const world=worldKey(viewer);
 const now=Date.now(), entries=[];
 const meRange=Math.max(1,Number(cfg.meRangeMeters)||5)*units;
 const doRange=Math.max(1,Number(cfg.doRangeMeters)||10)*units;
 for(const actor of PlayerManager.getAll()){
  const id=playerId(actor), record=roleplayStatuses.get(id);
  if(!record||!validPosition(actor.position))continue;
  const actualCharacter=characterOf(actor);
  if(!actualCharacter||String(actualCharacter.id)!==String(record.characterId)){roleplayStatuses.delete(id);continue;}
  const actorWorld=worldKey(actor);
  if(actorWorld.virtualWorld!==world.virtualWorld||actorWorld.areaId!==world.areaId||actorWorld.regionId!==world.regionId)continue;
  const dist=distance(view,actor.position);
  const me=record.me&&dist<=meRange?record.me:null;
  const action=record.action&&record.action.expiresAt>now&&dist<=doRange?record.action:null;
  if(!me&&!action)continue;
  entries.push({id,position:{x:actor.position.x,y:actor.position.y,z:actor.position.z},me,action:action?{text:action.text,expiresAt:action.expiresAt}:null});
 }
 try{viewer.emit('fm_scenes:roleplay',JSON.stringify({entries,meOffsetCm:Number(cfg.meOffsetMeters??0)*units,doOffsetCm:Number(cfg.doOffsetMeters??1.0)*units}));}catch(e){console.warn('[fm_scenes] Roleplay sync failed:',e);}
}
// Send /do as a local chat emote too. The same text is used for the overhead display.
function broadcastDoChat(actor,text){
 const cfg=roleConfig(), range=Math.max(1,Number(cfg.doRangeMeters)||10)*units;
 const origin=actor.position, originWorld=worldKey(actor);
 for(const recipient of PlayerManager.getAll()){
  if(typeof recipient.sendChat!=='function')continue;
  if(recipient!==actor){
   if(!validPosition(origin)||!validPosition(recipient.position))continue;
   const recipientWorld=worldKey(recipient);
   if(originWorld.virtualWorld!==recipientWorld.virtualWorld||originWorld.areaId!==recipientWorld.areaId||originWorld.regionId!==recipientWorld.regionId)continue;
   if(distance(origin,recipient.position)>range)continue;
  }
  try{recipient.sendChat(text);}catch(error){console.warn('[fm_scenes] /do chat delivery failed:',error);}
 }
}
function syncRoleplay(){
 const now=Date.now();
 for(const [id,record] of roleplayStatuses){
  if(record.action&&record.action.expiresAt<=now)record.action=null;
  if(!record.me&&!record.action)roleplayStatuses.delete(id);
 }
 for(const viewer of PlayerManager.getAll())rpSnapshot(viewer);
}
function emitSnapshot(player) {
 const loc=worldKey(player);
 const payload=[...scenes.values()].filter(s=>s.areaId===loc.areaId && s.regionId===loc.regionId && s.virtualWorld===loc.virtualWorld && (!s.expiresAt || s.expiresAt>Date.now())).map(s=>({...s,viewDistance:effectiveViewDistance(s)}));
 player.emit('fm_scenes:snapshot',JSON.stringify({revision,scenes:payload,config:{...CONFIG.visibility,unitsPerMeter:units,promptKey:CONFIG.render.promptKey,refreshMs:CONFIG.render.refreshMs,fallbackEyeHeightMeters:CONFIG.creation.fallbackEyeHeightMeters||1.6},multiLabelRenderer:CONFIG.multiLabelRenderer||{},mode:preference.get(identity(player))||CONFIG.visibility.mode}));
}
function publish(){revision++;for(const p of PlayerManager.getAll())emitSnapshot(p);}
function normalize(row){return {id:Number(row.id),owner:String(row.owner),text:row.text,x:Number(row.x),y:Number(row.y),z:Number(row.z),areaId:row.area_id||'',regionId:row.region_id||'',virtualWorld:Number(row.virtual_world||0),viewDistance:Number(row.view_distance),style:JSON.parse(row.style_json||'{}'),createdAt:Number(row.created_at),expiresAt:row.expires_at===null?null:Number(row.expires_at)};}
async function load(){
 try{const rows=await MySQL.query('SELECT * FROM fm_scenes WHERE expires_at IS NULL OR expires_at > ?', [Date.now()]);for(const row of rows) {const scene=normalize(row);scenes.set(scene.id,scene);}try { const prefs=await MySQL.query('SELECT owner, mode FROM fm_scenes_preferences'); for(const row of prefs)if(['always','hold','toggle'].includes(row.mode))preference.set(String(row.owner),row.mode); } catch(e){console.warn('[fm_scenes] Preferences table unavailable: import sql/fm_scenes.sql',e);}
 for(const scene of scenes.values())spawnSceneProp(scene);booted=true;publish();console.info(`[fm_scenes] loaded ${scenes.size} scenes`);}catch(err){console.error('[fm_scenes] Database load failed; import sql/fm_scenes.sql and check hmp-mysql: ',err);}
}
function validPosition(p){return p&&[p.x,p.y,p.z].every(Number.isFinite);}
function clampPosition(player,pos){
 if(!validPosition(player.position)||!validPosition(pos))return null;
 const maximum=CONFIG.creation.maximumPlacementDistanceMeters*units;
 if(distance(player.position,pos)>maximum+1)return null;
 return {x:pos.x,y:pos.y,z:pos.z};
}
const COLOR_CHOICES=[
 {label:'🟡 Parchment — warm cream',value:'parchment',description:'Aged parchment / warm ivory'},
 {label:'⚪ White — bright',value:'white',description:'Pure white text'},
 {label:'⚫ Grey — muted silver',value:'grey',description:'Soft grey text'},
 {label:'🔴 Red — ink red',value:'red',description:'Dusty red text'},
 {label:'🟢 Green — emerald',value:'green',description:'Rich green text'},
 {label:'🔵 Blue — midnight',value:'blue',description:'Cool pale blue text'},
 {label:'🟣 Violet — amethyst',value:'violet',description:'Soft purple text'},
 {label:'🟠 Gold — gilded',value:'gold',description:'Gold ink text'},
 {label:'🟤 Brown — sepia',value:'sepia',description:'Dark brown ink text'}
];
const FONT_CHOICES=[
 {label:'Traditional — The quick brown fox',value:'serif',description:'Georgia / traditional book serif'},
 {label:'Simple — The quick brown fox',value:'plain',description:'Arial / clear sans serif'},
 {label:'Bold — THE QUICK BROWN FOX',value:'bold',description:'Heavy serif lettering'},
 {label:'Elegant — The quick brown fox',value:'elegant',description:'Italic literary serif'},
 {label:'Handwritten-inspired — The quick brown fox',value:'handwritten',description:'Loose italic penmanship styling (no installed script font required)'},
 {label:'Typewriter — THE QUICK BROWN FOX',value:'typewriter',description:'Monospaced typewriter lettering'},
 {label:'Old print — THE QUICK BROWN FOX',value:'blackletter',description:'Heavy old-print small capitals (not true blackletter)'},
 {label:'Small caps — THE QUICK BROWN FOX',value:'smallcaps',description:'Letterspaced small capitals'}
];
async function sceneForm(player,old){
 const oldCategory=categoryFor(old?.style);
 const oldDuration=old?(old.expiresAt===null?0:Math.max(0,Math.ceil((old.expiresAt-Date.now())/60000))):60;
 const oldText=old?(oldCategory==='writing'?unquoteWriting(old.text):old.text):'';
 const fields=[
 {name:'category',label:'Category',type:'select',default:oldCategory,options:[{label:'Scene',value:'scene'},{label:'Writing',value:'writing'},{label:'Letter',value:'letter'},{label:'Parchment',value:'parchment'}]},
 {name:'parchmentVariant',label:'Parchment model',description:'B = Flat Parchment; E = Curved Parchment',type:'select',default:String(old?.style?.parchmentVariant||'B').toUpperCase(),options:[{label:'Flat Parchment (Scroll B)',value:'B'},{label:'Curved Parchment (Scroll E)',value:'E'}]},
 {name:'text',label:'Description (use \\n to insert a line break)',type:'textarea',required:true,default:oldText,description:'Enter may be intercepted by HogwartsMP. Type \\n between lines; it becomes a real line break in the scene. Writing is quoted automatically. Use **bold** for bold and __underline__ for underlined words.'},
 {name:'duration',label:'Duration (minutes; 0 = permanent)',type:'number',required:true,min:0,max:CONFIG.creation.maxDurationMinutes,default:oldDuration},
 {name:'distance',label:'Visibility distance (2–80 meters)',type:'number',required:true,min:2,max:CONFIG.visibility.maxDistanceMeters,default:old?old.viewDistance/units:visibilityDefaultMeters({category:oldCategory})},
 {name:'color',label:'Text color — swatches are approximate',type:'select',default:old?.style?.color||'parchment',options:COLOR_CHOICES},
 {name:'font',label:'Font style — browser-safe options',type:'select',default:old?.style?.font||'serif',options:FONT_CHOICES}
 ];
 const input=await UI.input(player,{title:old?'Edit environmental scene':'Place environmental scene',fields});
 if(!input)return null;
 const selectedCategory=['scene','writing','letter','parchment'].includes(String(input.category||'').toLowerCase())?String(input.category).toLowerCase():oldCategory;
 let content=cleanMultiline(input.text??oldText,CONFIG.creation.maxTextLength);
 if(!content){message(player,'Scene text cannot be empty.');return null;}
 if(selectedCategory==='writing')content=writingQuoted(content);
 // Preserve the existing expiry exactly if duration was left at its displayed value.
 const duration=asNum(input.duration,oldDuration,0,CONFIG.creation.maxDurationMinutes);
 if(duration===0&&!CONFIG.creation.allowPermanent){message(player,'Permanent scenes are disabled.');return null;}
 const requestedDistance=asNum(input.distance,old?old.viewDistance/units:visibilityDefaultMeters({category:selectedCategory}),2,CONFIG.visibility.maxDistanceMeters);
 const color=COLOR_CHOICES.some(c=>c.value===input.color)?input.color:(old?.style?.color||'parchment');
 const font=FONT_CHOICES.some(f=>f.value===input.font)?input.font:(old?.style?.font||'serif');
 const variant=String(input.parchmentVariant??old?.style?.parchmentVariant??'B').toUpperCase();
 const expiresAt=old && duration===oldDuration ? old.expiresAt : duration?Date.now()+duration*60000:null;
 return {text:content,viewDistance:requestedDistance*units,
  style:{...(old?.style||{}),category:selectedCategory,color,font,parchmentVariant:variant==='B'?'B':'E'},expiresAt};
}

async function create(player){
 if(!booted)return message(player,'Database is not ready. Check server console.');
 const owner=identity(player);
 if([...scenes.values()].filter(s=>s.owner===owner).length>=CONFIG.creation.maxScenesPerPlayer)return message(player,'You have reached your scene limit.');
 if(!validPosition(player.position))return message(player,'No valid character position.');
 const values=await sceneForm(player);if(!values)return;
 if(!validPosition(player.position))return message(player,'Character position unavailable.');
 clearPreviewMarker(player);
 const key=identity(player), loc=worldKey(player), now=Date.now();
 pending.set(key,{action:'create',values,loc,started:now});
 player.emit('fm_scenes:placement',JSON.stringify({action:'create',position:player.position,range:CONFIG.creation.maximumPlacementDistanceMeters*units,units,previewDistance:(CONFIG.creation.defaultPlacementDistanceMeters||2.5)*units,minimumDistanceMeters:CONFIG.creation.minimumPlacementDistanceMeters||0.5,maximumDistanceMeters:CONFIG.creation.maximumCameraDistanceMeters||10,wheelStepMeters:CONFIG.render.wheelStepMeters||0.5,wheelOutKey:CONFIG.render.wheelOutKey||'mousewheeldown',wheelInKey:CONFIG.render.wheelInKey||'mousewheelup',distanceFarKey:CONFIG.render.distanceFarKey||'e',distanceNearKey:CONFIG.render.distanceNearKey||'q',placementRefreshMs:CONFIG.render.placementRefreshMs||33,distanceSlideSpeedMetersPerSecond:CONFIG.render.distanceSlideSpeedMetersPerSecond||3,distanceHoldAccelerationMs:CONFIG.render.distanceHoldAccelerationMs||180,previewText:values.text,previewCategory:values.style.category||'Scene',previewModel:modelFor(values.style),previewMarkerUpdateMs:(CONFIG.previewMarker?.updateMs||50),previewMarkerMoveThreshold:(CONFIG.previewMarker?.moveThresholdCm||15)}));
 message(player,'Aim with the screen center. Q/E adjust depth; Middle Mouse confirms; Escape cancels. Scene/Writing use invisible anchors.');
}
async function beginEdit(player,id){
 const old=scenes.get(id);
 if(!old||old.owner!==identity(player))return message(player,'Scene not found or not owned by you.');
 if(!validPosition(player.position)||distance(player.position,old)>CONFIG.visibility.maxDistanceMeters*units)return message(player,'Move closer to your scene.');
 const values=await sceneForm(player,old);if(!values)return;
 clearPreviewMarker(player);
 pending.set(identity(player),{action:'edit',id,values,loc:worldKey(player),started:Date.now()});
 player.emit('fm_scenes:placement',JSON.stringify({action:'edit',position:old,origin:player.position,range:CONFIG.creation.maximumPlacementDistanceMeters*units,units,previewDistance:(CONFIG.creation.defaultPlacementDistanceMeters||2.5)*units,minimumDistanceMeters:CONFIG.creation.minimumPlacementDistanceMeters||0.5,maximumDistanceMeters:CONFIG.creation.maximumCameraDistanceMeters||10,wheelStepMeters:CONFIG.render.wheelStepMeters||0.5,wheelOutKey:CONFIG.render.wheelOutKey||'mousewheeldown',wheelInKey:CONFIG.render.wheelInKey||'mousewheelup',distanceFarKey:CONFIG.render.distanceFarKey||'e',distanceNearKey:CONFIG.render.distanceNearKey||'q',placementRefreshMs:CONFIG.render.placementRefreshMs||33,distanceSlideSpeedMetersPerSecond:CONFIG.render.distanceSlideSpeedMetersPerSecond||3,distanceHoldAccelerationMs:CONFIG.render.distanceHoldAccelerationMs||180,previewText:values.text,previewCategory:values.style.category||'Scene',previewModel:modelFor(values.style),previewMarkerUpdateMs:(CONFIG.previewMarker?.updateMs||50),previewMarkerMoveThreshold:(CONFIG.previewMarker?.moveThresholdCm||15)}));
 message(player,'Aim with the screen center. Q/E adjust depth; Middle Mouse confirms; Escape cancels. Scene/Writing use invisible anchors.');
}
Events.onClient('fm_scenes:placementPreview',(player,raw)=>{
 const job=pending.get(identity(player)); if(!job) return;
 let data; try{ data=typeof raw==='string'?JSON.parse(raw):raw; }catch{return;}
 const pos=clampPosition(player,data?.position); if(!pos) return;
 upsertPreviewMarker(player,pos,data?.yaw);
});
Events.onClient('fm_scenes:placementPreviewStop',player=>{ clearPreviewMarker(player); });
Events.onClient('fm_scenes:placementCancel',player=>{ pending.delete(identity(player)); clearPreviewMarker(player); });
Events.onClient('fm_scenes:placementConfirm',async(player,raw)=>{
 const key=identity(player), job=pending.get(key);
 if(!job)return;
 pending.delete(key);
 clearPreviewMarker(player);
 if(Date.now()-job.started>180000)return message(player,'Placement timed out.');
 let data;try{data=typeof raw==='string'?JSON.parse(raw):raw;}catch{return;}
 const pos=clampPosition(player,data);
 if(!pos)return message(player,'Placement rejected: outside the permitted range.');
 const yaw=Number(data?.yaw); if(Number.isFinite(yaw))job.values.style.yaw=((yaw%360)+360)%360;
 const loc=worldKey(player);
 if(loc.areaId!==job.loc.areaId||loc.regionId!==job.loc.regionId||loc.virtualWorld!==job.loc.virtualWorld)return message(player,'Placement cancelled after changing location.');
 if(job.action==='create'){
  if([...scenes.values()].filter(s=>s.owner===key).length>=CONFIG.creation.maxScenesPerPlayer)return message(player,'Scene limit reached.');
  const now=Date.now(),s={owner:key,...job.values,...pos,...loc,createdAt:now};
  try{const id=await MySQL.insert('INSERT INTO fm_scenes (owner,text,x,y,z,area_id,region_id,virtual_world,view_distance,style_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[s.owner,s.text,s.x,s.y,s.z,s.areaId,s.regionId,s.virtualWorld,s.viewDistance,JSON.stringify(s.style),s.createdAt,s.expiresAt]);
   s.id=Number(id);if(!Number.isSafeInteger(s.id)||s.id<=0)throw new Error('Invalid insert id');scenes.set(s.id,s);spawnSceneProp(s);publish();message(player,`Scene #${s.id} created.`);
  }catch(e){console.error('[fm_scenes] create:',e);message(player,'Scene save failed.');}
 } else {
  const old=scenes.get(job.id);
  if(!old||old.owner!==key)return message(player,'Scene no longer available.');
  const changed={...old,...job.values,...pos};
  try{await MySQL.query('UPDATE fm_scenes SET text=?,x=?,y=?,z=?,view_distance=?,style_json=?,expires_at=? WHERE id=? AND owner=?',[changed.text,changed.x,changed.y,changed.z,changed.viewDistance,JSON.stringify(changed.style),changed.expiresAt,old.id,key]);
  removeSceneProp(old.id);scenes.set(old.id,changed);spawnSceneProp(changed);publish();message(player,`Scene #${old.id} updated.`);
  }catch(e){console.error('[fm_scenes] edit:',e);message(player,'Scene edit failed.');}
 }
});
async function canModerateScenes(player){
 if(!CONFIG.creation.allowAdminDeleteAll)return false;
 try{
  const admin=Imports.get('hmp-admin');
  return Boolean(await admin.permissions.has(player,CONFIG.creation.adminDeleteCapability||'admin.view'));
 }catch(error){
  console.warn('[fm_scenes] Admin permission lookup failed:',error);
  return false; // Fail closed: never trust a client-provided admin claim.
 }
}
async function adminErase(player,id){
 if(!await canModerateScenes(player))return message(player,'You do not have permission to delete other players’ scenes.');
 if(!Number.isSafeInteger(id)||id<1)return message(player,'Invalid scene ID.');
 const target=scenes.get(id);
 if(!target)return message(player,`Scene #${id} was not found.`);
 const result=await UI.alert(player,{title:`Delete scene #${id}?`,content:`Category: ${sceneCategory(target.style)}\nCreator: ${target.owner}\nDescription: ${target.text}\n\nThis permanently removes the scene for all players.`,confirmLabel:'Delete scene',cancel:true});
 if(result!=='confirm')return;
 // Reauthorize after the asynchronous confirmation.
 if(!await canModerateScenes(player))return message(player,'Permission denied.');
 const current=scenes.get(id);
 if(!current||current!==target)return message(player,'Scene changed or was deleted. Open the menu again.');
 try{
  await MySQL.query('DELETE FROM fm_scenes WHERE id=?',[id]);
  removeSceneProp(id);scenes.delete(id);publish();
  console.info(`[fm_scenes] Administrative deletion: player ${identity(player)} deleted scene #${id}, owner ${target.owner}, text=${JSON.stringify(target.text.slice(0,80))}`);
  message(player,`Deleted scene #${id} (owner ${target.owner}).`);
 }catch(error){console.error('[fm_scenes] admin delete:',error);message(player,'Unable to delete the scene.');}
}
async function erase(player,id){
 const s=scenes.get(id);if(!s)return message(player,'Scene not found.');
 if(s.owner!==identity(player))return message(player,'You may only delete scenes you created.');
 if(!player.position||distance(player.position,s)>CONFIG.visibility.maxDistanceMeters*units)return message(player,'Move closer to your scene.');
 try{await MySQL.query('DELETE FROM fm_scenes WHERE id=? AND owner=?',[id,s.owner]);removeSceneProp(id);scenes.delete(id);publish();message(player,`Deleted scene #${id}.`);}catch(e){console.error('[fm_scenes] delete:',e);message(player,'Deletion failed.');}
}
router.register('me',{usage:'/me <status> — use /me again to clear'},({player,args})=>{
 if(roleConfig().enabled===false)return;
 const character=characterOf(player);
 if(!character)return message(player,'Load a character before using /me.');
 if(!rpReady(player))return;
 const id=playerId(player), existing=roleplayStatuses.get(id);
 // One active status per player: issuing /me a second time toggles it off.
 if(existing?.me){existing.me=null;if(!existing.action)roleplayStatuses.delete(id);message(player,'Your /me status has been cleared.');syncRoleplay();return;}
 const text=clean(args.join(' '),Math.max(20,Number(roleConfig().maxMeLength)||140));
 if(!text)return message(player,'Usage: /me <status>. Use /me again to remove the status.');
 const record=existing&&String(existing.characterId)===String(character.id)?existing:{characterId:character.id,me:null,action:null};
 record.me=text;roleplayStatuses.set(id,record);
 message(player,'Status set: '+text);syncRoleplay();
});
router.register('do',{usage:'/do <action>'},({player,args})=>{
 if(roleConfig().enabled===false)return;
 const character=characterOf(player);
 if(!character)return message(player,'Load a character before using /do.');
 if(!rpReady(player))return;
 const action=clean(args.join(' '),Math.max(20,Number(roleConfig().maxDoLength)||140));
 if(!action)return message(player,'Usage: /do <action>.');
 const id=playerId(player),existing=roleplayStatuses.get(id);
 const record=existing&&String(existing.characterId)===String(character.id)?existing:{characterId:character.id,me:null,action:null};
 record.action={text:`*${rpName(player)} ${action.replace(/^[*\s]+|[*\s]+$/g,'')}*`,expiresAt:Date.now()+Math.max(1,Number(roleConfig().doDurationSeconds)||10)*1000};
 roleplayStatuses.set(id,record);syncRoleplay();
 broadcastDoChat(player,record.action.text);
});
router.register('scene',{usage:'/scene'},({player})=>{void create(player);});
router.register('scenes',{usage:'/scenes'},async({player})=>{
 const owned=[...scenes.values()].filter(s=>s.owner===identity(player)).slice(0,32);
 if(!owned.length)return message(player,'You have no scenes. Use /scene to create one.');
 const choice=await UI.context(player,{title:'My scenes',options:owned.map(s=>({id:String(s.id),title:`#${s.id} [${sceneCategory(s.style)}]: ${s.text.slice(0,39)}`,description:s.style?.category==='parchment'?(String(s.style?.parchmentVariant||'B').toUpperCase()==='B'?'Flat Parchment':'Curved Parchment'):'Edit or delete scene'}))});
 if(!choice)return;
 const id=Number(choice);if(!owned.some(s=>s.id===id))return;
 const operation=await UI.context(player,{title:`Scene #${id}`,options:[{id:'edit',title:'Edit and reposition'},{id:'delete',title:'Delete scene'}]});
 if(operation==='edit')return void beginEdit(player,id);
 if(operation==='delete'){
  const yes=await UI.alert(player,{title:`Delete scene #${id}?`,content:'This cannot be undone.',confirmLabel:'Delete',cancel:true});
  if(yes==='confirm')await erase(player,id);
 }
});
router.register('scenesadmin',{usage:'/scenesadmin'},async({player})=>{
 if(!await canModerateScenes(player))return message(player,'You do not have permission to manage other players’ scenes.');
 if(!booted)return message(player,'Database is not ready.');
 const pos=validPosition(player.position)?player.position:null;
 const loc=worldKey(player);
 const limit=Math.max(1,Math.min(500,Number(CONFIG.creation.adminDeleteMenuLimit)||200));
 const entries=[...scenes.values()]
  .sort((a,b)=>{
   const aSame=(a.areaId===loc.areaId&&a.regionId===loc.regionId&&a.virtualWorld===loc.virtualWorld)?0:1;
   const bSame=(b.areaId===loc.areaId&&b.regionId===loc.regionId&&b.virtualWorld===loc.virtualWorld)?0:1;
   if(aSame!==bSame)return aSame-bSame;
   const ad=pos?distance(pos,a):Number.POSITIVE_INFINITY;
   const bd=pos?distance(pos,b):Number.POSITIVE_INFINITY;
   if(ad!==bd)return ad-bd;
   return a.id-b.id;
  })
  .slice(0,limit);
 if(!entries.length)return message(player,'No scenes currently exist.');
 const describe=(s)=>{
   const same=s.areaId===loc.areaId&&s.regionId===loc.regionId&&s.virtualWorld===loc.virtualWorld;
   const dist=pos?`${(distance(pos,s)/units).toFixed(1)}m`:'n/a';
   const place=same?`Here | ${dist}`:`Other area | vw ${s.virtualWorld} | ${dist}`;
   return `Owner: ${s.owner} | ${place}`;
 };
 const choice=await UI.context(player,{title:`Scene moderation - all scenes (${Math.min(entries.length,limit)}/${scenes.size})`,options:entries.map(s=>({id:String(s.id),title:`#${s.id} [${sceneCategory(s.style)}] ${s.text.slice(0,37)}`,description:describe(s)}))});
 if(!choice)return;
 const id=Number(choice);
 if(!entries.some(s=>s.id===id))return;
 await adminErase(player,id);
});
router.register('scenewb',{usage:'/scenewb <x> <y> <z>'},async({player,args})=>{
 if(!await canModerateScenes(player))return message(player,'Admin permissions required for World Builder coordinate placement.');
 if(!booted)return message(player,'Database is not ready.');
 if(args.length<3)return message(player,'Usage: /scenewb <x> <y> <z> (Unreal centimetres from F6 World Builder).');
 const pos={x:Number(args[0]),y:Number(args[1]),z:Number(args[2])};
 if(!validPosition(pos))return message(player,'Invalid World Builder coordinates.');
 const values=await sceneForm(player);if(!values)return;
 const loc=worldKey(player),now=Date.now();
 const scene={owner:identity(player),...values,...pos,...loc,createdAt:now};
 try{
  const id=await MySQL.insert('INSERT INTO fm_scenes (owner,text,x,y,z,area_id,region_id,virtual_world,view_distance,style_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',[scene.owner,scene.text,scene.x,scene.y,scene.z,scene.areaId,scene.regionId,scene.virtualWorld,scene.viewDistance,JSON.stringify(scene.style),scene.createdAt,scene.expiresAt]);
  scene.id=Number(id);if(!Number.isSafeInteger(scene.id)||scene.id<1)throw new Error('Invalid scene ID');
  scenes.set(scene.id,scene);spawnSceneProp(scene);publish();message(player,`Scene #${scene.id} created at World Builder coordinates.`);
 }catch(e){console.error('[fm_scenes] World Builder coordinate placement failed:',e);message(player,'Scene save failed.');}
});
router.register('scenedelete',{usage:'/scenedelete <id>'},async({player,args})=>{
 const raw=String(args[0]||'');
 if(!/^[1-9]\d*$/.test(raw))return message(player,'Usage: /scenedelete <scene ID>');
 await adminErase(player,Number(raw));
});
// Visibility is fixed per category. Keep the command as a compatibility hint rather
// than silently accepting preferences that no longer affect visibility.
router.register('scenevisibility',{usage:'/scenevisibility'},({player})=>{
 message(player,'Scene and Writing are always visible. Hold Left Alt to view Letter and Parchment. The old visibility modes no longer override these category rules.');
});
Events.on('chatCommand',router.handle);
Events.on('playerConnect',p=>{if(booted)emitSnapshot(p);rpSnapshot(p);});
Events.on('playerLocationChanged',p=>{if(booted)emitSnapshot(p);});
Events.onClient('fm_scenes:ready',p=>{if(booted)emitSnapshot(p);rpSnapshot(p);});
Events.on('playerDisconnect',p=>{pending.delete(identity(p)); clearPreviewMarker(p);roleplayStatuses.delete(playerId(p));lastRoleplayCommand.delete(playerId(p));});
const sweep=setInterval(async()=>{if(!booted)return;const expired=[...scenes.values()].filter(s=>s.expiresAt&&s.expiresAt<=Date.now());if(!expired.length)return;try{await MySQL.query('DELETE FROM fm_scenes WHERE expires_at IS NOT NULL AND expires_at <= ?',[Date.now()]);for(const s of expired){removeSceneProp(s.id);scenes.delete(s.id);}publish();}catch(e){console.error('[fm_scenes] expiry cleanup:',e);}},60000);
const roleplayTicker=setInterval(syncRoleplay,Math.max(50,Number(roleConfig().syncIntervalMs)||75));
Events.on('resourceStop',name=>{if(!name||name==='fm_scenes'){clearInterval(roleplayTicker);roleplayStatuses.clear();clearInterval(sweep); for(const p of PlayerManager.getAll()) clearPreviewMarker(p);for(const scene of scenes.values())removeSceneProp(scene.id);} });
Exports.register('status',()=>({booted,count:scenes.size,revision}));
void load();
