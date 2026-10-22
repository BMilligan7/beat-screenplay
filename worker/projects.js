import * as Y from "yjs";
import { encodeRoomUpdate, seedRoomDocument, applyRoomUpdate, readRoomDocument } from "../shared/room-document.js";

// Reuse the existing room store; project entries do not alter screenplay documents.
const TABLE = `CREATE TABLE IF NOT EXISTS screenplay_rooms (room_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, draft_name TEXT NOT NULL, blocks_json TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL)`;
const ID = /^[a-z0-9_-]{8,128}$/i;
const KEY = /^[a-f0-9]{16,128}$/i;
const json = (data, status = 200) => new Response(JSON.stringify(data), {status,headers:{"content-type":"application/json", "cache-control":"no-store"}});
const fail = (status, message) => { const error = new Error(message); error.status = status; throw error; };
async function hash(key) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(key))),v=>v.toString(16).padStart(2,"0")).join(""); }
function title(value) { if (typeof value !== "string" || !value.trim() || value.trim().length > 120) fail(400,"Enter a project title of up to 120 characters.");return value.trim(); }
function secret(request) { const key=(request.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");if(!KEY.test(key))fail(401,"A valid project link is required.");return key; }
async function row(db,id) { return db.prepare("SELECT room_id,key_hash,draft_name,blocks_json,updated_at,revision FROM screenplay_rooms WHERE room_id=?").bind(id).first(); }
function decode(entry) { const data=JSON.parse(entry.blocks_json);if(data.kind!=="project")fail(404,"Project not found.");return data; }
function project(entry) { const data=decode(entry);return {roomId:data.roomId,name:data.name,key:data.key,createdAt:data.createdAt,revision:Number(entry.revision)}; }
export async function readProject(db,roomId) { const entry=await row(db,`projects/${roomId}`);if(!entry)return null;const data=project(entry);return {roomId:data.roomId,name:data.name,revision:data.revision}; }
function statement(db,id,keyHash,name,data,at) { return db.prepare("INSERT INTO screenplay_rooms (room_id,key_hash,draft_name,blocks_json,updated_at,revision) VALUES (?,?,?,?,?,1)").bind(id,keyHash,name,JSON.stringify(data),at); }
function defaultTitle(root) {
  const stored=JSON.parse(root.blocks_json);let blocks=stored;
  if(!Array.isArray(stored)){const doc=new Y.Doc();try{applyRoomUpdate(doc,stored.update);blocks=readRoomDocument(doc).blocks;}finally{doc.destroy();}}
  return blocks.find(b=>b.type==="title" && b.text.trim())?.text.trim().slice(0,120) || "Untitled screenplay";
}
async function create(db,payload) {
  const name=title(payload.name),roomId=payload.roomId,key=payload.key;
  if(!ID.test(roomId||"")||!KEY.test(key||""))fail(400,"The new project identity is invalid.");
  const keyHash=await hash(key);
  const prior=await row(db,`projects/${roomId}`);
  if(prior){if(prior.key_hash!==keyHash||decode(prior).creationName!==name)fail(409,"That project identity is already in use.");return {project:project(prior)};}
  if(await row(db,roomId))fail(409,"That script already exists. Open its link to add it to the library.");
  const timestamp=new Date().toISOString();
  const doc=new Y.Doc();let update;
  try{seedRoomDocument(doc,{draftName:"Draft 1",blocks:[{id:crypto.randomUUID(),type:"title",text:name.toUpperCase()},{id:crypto.randomUUID(),type:"divider",text:""},{id:crypto.randomUUID(),type:"scene",text:""}]});update=encodeRoomUpdate(doc);}finally{doc.destroy();}
  const record={kind:"project",version:1,roomId,name,key,creationName:name,createdAt:timestamp};
  try { await db.batch([statement(db,roomId,keyHash,"Draft 1",{format:2,update},timestamp),statement(db,`projects/${roomId}`,keyHash,name,record,timestamp)]); }
  catch(error) { const concurrent=await row(db,`projects/${roomId}`);if(concurrent?.key_hash===keyHash && decode(concurrent).creationName===name)return {project:project(concurrent)};throw error; }
  return {project:project(await row(db,`projects/${roomId}`))};
}
async function register(db,roomId,request,payload) {
  const key=secret(request),keyHash=await hash(key),root=await row(db,roomId);
  if(!root)fail(404,"This script could not be found.");if(root.key_hash!==keyHash)fail(403,"The project link does not match this script.");
  const prior=await row(db,`projects/${roomId}`);if(prior)return {project:project(prior)};
  const name=payload.name===undefined?defaultTitle(root):title(payload.name);const timestamp=new Date().toISOString();
  const record={kind:"project",version:1,roomId,name,key,createdAt:timestamp};
  await db.prepare("INSERT INTO screenplay_rooms (room_id,key_hash,draft_name,blocks_json,updated_at,revision) VALUES (?,?,?,?,?,1) ON CONFLICT(room_id) DO NOTHING").bind(`projects/${roomId}`,keyHash,name,JSON.stringify(record),timestamp).run();
  return {project:project(await row(db,`projects/${roomId}`))};
}
async function rename(db,roomId,request,payload) {
  const keyHash=await hash(secret(request));const prior=await row(db,`projects/${roomId}`);
  if(!prior)fail(404,"Add this script to the shared library first.");if(prior.key_hash!==keyHash)fail(403,"The project link does not match.");
  const name=title(payload.name),data=decode(prior);
  if(data.name===name)return {project:project(prior)};
  if(!Number.isSafeInteger(payload.revision)||payload.revision!==Number(prior.revision))fail(409,"Another writer renamed this project. Reload the latest title and try again.");
  const result=await db.prepare("UPDATE screenplay_rooms SET draft_name=?,blocks_json=?,updated_at=?,revision=revision+1 WHERE room_id=? AND key_hash=? AND revision=?").bind(name,JSON.stringify({...data,name}),new Date().toISOString(),`projects/${roomId}`,keyHash,payload.revision).run();
  if(result.meta?.changes!==1)fail(409,"Another writer renamed this project. Reload the latest title and try again.");
  return {project:project(await row(db,`projects/${roomId}`))};
}
export async function handleProjects(request,env) {
  try{
    if(!env.DB)fail(503,"The project library is temporarily unavailable.");const db=env.DB;await db.prepare(TABLE).run();
    const path=new URL(request.url).pathname;
    if(path==="/api/projects" && request.method==="GET"){
      // Only deliberately registered projects are public. Never enumerate raw rooms.
      const result=await db.prepare("SELECT p.*,r.draft_name AS current_draft,r.updated_at AS script_updated_at FROM screenplay_rooms p JOIN screenplay_rooms r ON r.room_id=json_extract(p.blocks_json,'$.roomId') WHERE p.room_id >= 'projects/' AND p.room_id < 'projects0' AND json_extract(p.blocks_json,'$.kind')='project' ORDER BY p.updated_at DESC,p.room_id").all();
      return json({projects:result.results.map(entry=>({...project(entry),draftName:entry.current_draft,updatedAt:entry.script_updated_at}))});
    }
    const text=await request.text();if(text.length>4096)fail(413,"The project details are too long.");let payload;try{payload=JSON.parse(text);}catch{fail(400,"The project details could not be read.");}if(!payload||typeof payload!=="object")fail(400,"Invalid project details.");
    if(path==="/api/projects" && request.method==="POST")return json(await create(db,payload));
    const match=path.match(/^\/api\/projects\/([a-z0-9_-]{8,128})$/i);
    if(match && request.method==="POST")return json(await register(db,match[1],request,payload));
    if(match && request.method==="PATCH")return json(await rename(db,match[1],request,payload));
    return json({error:"Method not allowed."},405);
  }catch(error){return json({error:error.status?error.message:"The project library could not save. Please try again."},error.status||503);}
}
