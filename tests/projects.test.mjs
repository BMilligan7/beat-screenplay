// All scripts, names, room identifiers, and keys below are fictional test fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import worker from "../worker/index.js";
import { seedRoomDocument, encodeRoomUpdate } from "../shared/room-document.js";
const KEY="1234567890abcdef1234567890abcdef";
function database() {
  const sqlite = new DatabaseSync(":memory:");
  let barrier;
  const db = {
    sqlite,
    failAt: null,
    collideReads(id = "project-test", count = 2) { barrier = { id, count, waiting: [] }; },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = (values = []) => ({
        bind: (...parameters) => bound(parameters),
        async first() {
          const row = statement.get(...values) || null;
          if (barrier && values[0] === barrier.id && sql.startsWith("SELECT room_id")) {
            const waiting = barrier;
            await new Promise((resolve) => {
              waiting.waiting.push(resolve);
              if (waiting.waiting.length === waiting.count) { barrier = null; waiting.waiting.forEach((release) => release()); }
            });
          }
          return row;
        },
        async all() { return { results: statement.all(...values), success: true }; },
        _run() { const result = statement.run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
        async run() { return this._run(); },
      });
      return bound();
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement, index) => {
          if (this.failAt === index) { this.failAt = null; throw new Error("Injected atomic write failure"); }
          return statement._run();
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  return db;
}

function api(db) {
  return async (path, method="GET", body, key=KEY) => {
    const response=await worker.fetch(new Request(`https://example.test/api/${path}`, {method,headers:{authorization:`Bearer ${key}`,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})}),{DB:db});
    return {status:response.status,...await response.json()};
  };
}
const create=(call,roomId="first-project",name="First screenplay")=>call("projects","POST",{roomId,key:KEY,name});
const rows=db=>db.sqlite.prepare("SELECT * FROM screenplay_rooms WHERE room_id NOT LIKE 'projects/%' ORDER BY room_id").all();

test("new projects are independent blank screenplays visible to a fresh reader",async()=>{
  const db=database(),call=api(db);
  assert.equal((await create(call)).status,200);
  assert.equal((await create(call,"second-project","Second screenplay")).status,200);
  const listed=await call("projects","GET",undefined,"");
  assert.equal(listed.projects.length,2);
  assert.deepEqual(new Set(listed.projects.map(p=>p.name)),new Set(["First screenplay","Second screenplay"]));
  for(const p of listed.projects){
    const workspace=await call(`rooms/${p.roomId}/workspace`);
    assert.equal(workspace.main.draftName,"Draft 1");
    assert.equal(workspace.main.blocks[0].text,p.name.toUpperCase());
    assert.equal(workspace.main.blocks.at(-1).text,"");
    assert.equal(workspace.sessions.length,0);
    assert.equal(workspace.project.name,p.name);
  }
  const a=await call("rooms/first-project/workspace"),b=await call("rooms/second-project/workspace");
  assert.ok(a.main.blocks.every(block=>!b.main.blocks.some(other=>other.id===block.id)));
});

test("registering an old script preserves current, archives, sessions and history byte for byte",async()=>{
  const db=database(),call=api(db),doc=new Y.Doc();
  const blocks=[{id:"title",type:"title",text:"MOON STATION"},{id:"action",type:"action",text:"Original text."}];
  seedRoomDocument(doc,{draftName:"Draft 3",blocks,drafts:[{id:"draft-nine",name:"Draft 9",blocks}]});
  assert.equal((await call("rooms/existing-demo/sync","POST",{update:encodeRoomUpdate(doc)})).status,200);doc.destroy();
  assert.equal((await call("rooms/existing-demo/sessions","POST",{authorName:"Writer",operationId:crypto.randomUUID(),sessionToken:crypto.randomUUID().replaceAll("-","")})).status,200);
  const before=rows(db);
  assert.equal((await call("projects")).projects.length,0);
  assert.equal((await call("projects/existing-demo","POST",{name:"Moon Station"},"a".repeat(32))).status,403);
  const added=await call("projects/existing-demo","POST",{name:"Moon Station"});
  assert.equal(added.status,200);
  assert.deepEqual(rows(db),before);
  assert.equal((await call("projects")).projects.length,1);
  assert.equal((await call("projects/existing-demo","POST",{name:"Accidental rename"})).project.name,"Moon Station");
  assert.deepEqual(rows(db),before);
});

test("creation retries return the original project and cannot overwrite an existing script",async()=>{
  const db=database(),call=api(db),first=await create(call),before=rows(db);
  assert.deepEqual(await create(call),first);
  assert.deepEqual(rows(db),before);
  assert.equal((await create(call,"first-project","Another name")).status,409);
  assert.equal((await call("projects","POST",{roomId:"first-project",key:"b".repeat(32),name:"First screenplay"})).status,409);
  db.sqlite.prepare("DELETE FROM screenplay_rooms WHERE room_id='projects/first-project'").run();
  assert.equal((await create(call)).status,409);
  assert.deepEqual(rows(db),before);
});

test("failed project creation rolls back both script and registration, then retries safely",async()=>{
  const db=database(),call=api(db);db.failAt=1;
  assert.equal((await create(call)).status,503);
  assert.equal(rows(db).length,0);
  assert.equal((await call("projects")).projects.length,0);
  assert.equal((await create(call)).status,200);
  assert.equal((await call("projects")).projects.length,1);
});

test("simultaneous retries create one project",async()=>{
  const db=database(),call=api(db);
  await call("projects");db.collideReads("first-project");
  const [a,b]=await Promise.all([create(call),create(call)]);
  assert.equal(a.status,200);assert.deepEqual(a,b);
  assert.equal((await call("projects")).projects.length,1);
});

test("shared rename detects stale titles and never rewrites script or session data",async()=>{
  const db=database(),call=api(db);await create(call);const before=rows(db);
  const renamed=await call("projects/first-project","PATCH",{name:"Renamed screenplay",revision:1});
  assert.equal(renamed.project.revision,2);
  assert.equal((await call("projects/first-project","PATCH",{name:"Stale screenplay",revision:1})).status,409);
  assert.equal((await call("projects/first-project","PATCH",{name:"Renamed screenplay",revision:1})).status,200);
  assert.equal((await create(call)).project.name,"Renamed screenplay");
  assert.equal((await call("projects")).projects[0].name,"Renamed screenplay");
  assert.deepEqual(rows(db),before);
});

test("session ownership and history are scoped to each project",async()=>{
  const db=database(),call=api(db);await create(call);await create(call,"second-project","Second");
  const sessionToken=crypto.randomUUID().replaceAll("-","");
  const started=await call("rooms/first-project/sessions","POST",{authorName:"Alex",operationId:crypto.randomUUID(),sessionToken});
  assert.equal(started.status,200);
  const first=await call("rooms/first-project/workspace"),second=await call("rooms/second-project/workspace");
  assert.equal(first.sessions.length,1);assert.equal(second.sessions.length,0);
  assert.equal(second.history.length,1);
  assert.equal(second.history[0].kind,"baseline");
  assert.ok(first.history.some(event=>event.kind==="session_created"));
  assert.equal((await call(`rooms/second-project/sessions/${first.sessions[0].id}/sync`)).status,404);
});
