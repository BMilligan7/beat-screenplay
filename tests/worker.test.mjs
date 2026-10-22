// All scripts, names, room identifiers, and keys below are fictional test fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker/index.js";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import { applyRoomUpdate, encodeRoomUpdate, readRoomDocument, seedRoomDocument } from "../shared/room-document.js";

function createDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  let readBarrier = null;
  return {
    sqlite,
    holdNextReads(count = 2) { readBarrier = { count, waiting: [] }; },
    prepare(sql) {
      const bind = (...values) => ({
        async first() {
          const row = sqlite.prepare(sql).get(...values) || null;
          if (readBarrier && sql.startsWith("SELECT")) {
            const barrier = readBarrier;
            await new Promise((resolve) => {
              barrier.waiting.push(resolve);
              if (barrier.waiting.length === barrier.count) {
                readBarrier = null;
                barrier.waiting.forEach((release) => release());
              }
            });
          }
          return row;
        },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      });
      return { bind, run: () => bind().run() };
    },
  };
}

function roomFetch(database) {
  return (input, init) => worker.fetch(new Request(new URL(input, "https://example.test"), init), {
    DB: database,
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  });
}

const ROOM = { roomId: "test-screenplay-room", key: "1234567890abcdef1234567890abcdef" };
const BLOCKS = [
  { id: "title", type: "title", text: "MOON STATION" },
  { id: "scene", type: "scene", text: "INT. TEST LAB — DAY" },
  { id: "action", type: "action", text: "The lamp turns blue." },
];

function roomRequest(fetchImpl, method = "GET", payload, { sync = true, key = ROOM.key } = {}) {
  return fetchImpl(`/api/rooms/${ROOM.roomId}${sync ? "/sync" : ""}`, {
    method,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
}

async function createRoom(fetchImpl, draftName = "Draft 8") {
  const doc = new Y.Doc();
  seedRoomDocument(doc, { draftName, blocks: BLOCKS });
  const response = await roomRequest(fetchImpl, "POST", { update: encodeRoomUpdate(doc) });
  doc.destroy();
  assert.equal(response.status, 200);
  return response.json();
}

function documentFrom(snapshot) {
  const doc = new Y.Doc();
  applyRoomUpdate(doc, snapshot.update);
  return doc;
}

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
});

test("falls back to index.html for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/index.html" ? "app" : "missing", {
            status: url.pathname === "/index.html" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", { headers: { accept: "application/json" } }),
    new Request("https://example.test/flow", { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  }
});

test("persists an authenticated room and exposes its projection to legacy readers", async () => {
  const fetchImpl = roomFetch(createDatabase());
  const saved = await createRoom(fetchImpl);
  const loaded = await roomRequest(fetchImpl).then((response) => response.json());
  assert.equal(saved.revision, 1);
  assert.equal(loaded.draftName, "Draft 8");
  assert.deepEqual(loaded.blocks, BLOCKS);
  assert.deepEqual(loaded.drafts, []);
  const legacy = await roomRequest(fetchImpl, "GET", undefined, { sync: false }).then((response) => response.json());
  assert.deepEqual(legacy.blocks, BLOCKS);
  assert.equal(legacy.update, undefined);
  assert.equal((await roomRequest(fetchImpl, "GET", undefined, { key: "0000000000000000" })).status, 403);
});

test("reports a missing room and rejects unauthenticated sync", async () => {
  const fetchImpl = roomFetch(createDatabase());
  assert.equal((await roomRequest(fetchImpl)).status, 404);
  assert.equal((await fetchImpl(`/api/rooms/${ROOM.roomId}/sync`)).status, 401);
});

test("existing room rejects legacy full-snapshot writers without changing anything", async () => {
  const fetchImpl = roomFetch(createDatabase());
  const saved = await createRoom(fetchImpl, "Draft 9");
  const response = await roomRequest(fetchImpl, "PUT", { draftName: "Draft 6", blocks: BLOCKS.slice(0, 1) }, { sync: false });
  assert.equal(response.status, 428);
  assert.deepEqual(await roomRequest(fetchImpl).then((value) => value.json()), saved);
});

test("a legacy client may create a new room but cannot replace it on retry", async () => {
  const fetchImpl = roomFetch(createDatabase());
  const response = await roomRequest(fetchImpl, "PUT", { draftName: "Draft 9", blocks: BLOCKS }, { sync: false });
  assert.equal(response.status, 200);
  assert.equal((await roomRequest(fetchImpl, "PUT", { draftName: "Draft 6", blocks: BLOCKS }, { sync: false })).status, 428);
  const saved = await roomRequest(fetchImpl).then((value) => value.json());
  assert.equal(saved.draftName, "Draft 9");
  assert.ok(saved.update);
});

test("concurrent text edits are merged after an actual SQL compare-and-swap collision", async () => {
  const database = createDatabase();
  const fetchImpl = roomFetch(database);
  const base = await createRoom(fetchImpl);
  const left = documentFrom(base);
  const right = documentFrom(base);
  left.getMap("screenplay").get("action").get("text").insert(0, "Together, ");
  const rightText = right.getMap("screenplay").get("action").get("text");
  rightText.insert(rightText.length, " A knock interrupts them.");
  database.holdNextReads();
  const responses = await Promise.all([left, right].map((doc) => roomRequest(fetchImpl, "POST", { update: encodeRoomUpdate(doc) })));
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const saved = await roomRequest(fetchImpl).then((response) => response.json());
  assert.equal(saved.revision, 3);
  assert.equal(saved.blocks[2].text, "Together, The lamp turns blue. A knock interrupts them.");
  left.destroy(); right.destroy();
});

test("an offline text edit cannot roll a concurrent draft rename back", async () => {
  const fetchImpl = roomFetch(createDatabase());
  const base = await createRoom(fetchImpl);
  const renamed = documentFrom(base);
  const offline = documentFrom(base);
  renamed.getMap("metadata").set("draftName", "Draft 9");
  await roomRequest(fetchImpl, "POST", { update: encodeRoomUpdate(renamed) });
  offline.getMap("screenplay").get("action").get("text").insert(0, "Quietly, ");
  const response = await roomRequest(fetchImpl, "POST", { update: encodeRoomUpdate(offline) });
  const saved = await response.json();
  assert.equal(saved.draftName, "Draft 9");
  assert.equal(saved.blocks[2].text, "Quietly, The lamp turns blue.");
  const collaborator = documentFrom(await roomRequest(fetchImpl).then((value) => value.json()));
  assert.equal(readRoomDocument(collaborator).draftName, "Draft 9");
  renamed.destroy(); offline.destroy(); collaborator.destroy();
});

test("saved drafts reach another client through the same room", async () => {
  const fetchImpl = roomFetch(createDatabase());
  const base = await createRoom(fetchImpl);
  const doc = documentFrom(base);
  doc.transact(() => {
    doc.getMap("drafts").set("draft-8", { id: "draft-8", name: "Draft 8", blocks: BLOCKS });
    doc.getMap("metadata").set("draftName", "Draft 9");
  });
  assert.equal((await roomRequest(fetchImpl, "POST", { update: encodeRoomUpdate(doc) })).status, 200);
  const collaborator = documentFrom(await roomRequest(fetchImpl).then((response) => response.json()));
  assert.deepEqual(readRoomDocument(collaborator), { draftName: "Draft 9", blocks: BLOCKS, drafts: [{ id: "draft-8", name: "Draft 8", blocks: BLOCKS }] });
  doc.destroy(); collaborator.destroy();
});

test("a stale full update preserves a committed deletion and merges an unrelated edit", async () => {
  const fetchImpl = roomFetch(createDatabase());
  const base = await createRoom(fetchImpl);
  const deleting = documentFrom(base);
  const offline = documentFrom(base);
  deleting.getMap("screenplay").delete("title");
  await roomRequest(fetchImpl, "POST", { update: encodeRoomUpdate(deleting) });
  offline.getMap("screenplay").get("action").get("text").insert(0, "Quietly, ");
  const saved = await roomRequest(fetchImpl, "POST", { update: encodeRoomUpdate(offline) }).then((response) => response.json());
  assert.deepEqual(saved.blocks.map((block) => block.id), ["scene", "action"]);
  assert.equal(saved.blocks[1].text, "Quietly, The lamp turns blue.");
  deleting.destroy(); offline.destroy();
});

test("repeated delivery and a lost-response retry do not duplicate edits or advance revision", async () => {
  const fetchImpl = roomFetch(createDatabase());
  const doc = documentFrom(await createRoom(fetchImpl));
  doc.getMap("screenplay").get("action").get("text").insert(0, "Now, ");
  const payload = { update: encodeRoomUpdate(doc) };
  const first = await roomRequest(fetchImpl, "POST", payload).then((response) => response.json());
  const retry = await roomRequest(fetchImpl, "POST", payload).then((response) => response.json());
  assert.deepEqual(retry, first);
  assert.equal(retry.blocks[2].text, "Now, The lamp turns blue.");
  doc.destroy();
});

test("out-of-order incremental edits survive until their dependency arrives", async () => {
  const fetchImpl = roomFetch(createDatabase());
  const doc = documentFrom(await createRoom(fetchImpl));
  const text = doc.getMap("screenplay").get("action").get("text");
  text.insert(0, "First. ");
  const earlier = encodeRoomUpdate(doc);
  const vector = Y.encodeStateVector(doc);
  text.insert(0, "Second. ");
  const later = encodeRoomUpdate(doc, vector);
  assert.equal((await roomRequest(fetchImpl, "POST", { update: later })).status, 200);
  const response = await roomRequest(fetchImpl, "POST", { update: earlier });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).blocks[2].text, "Second. First. The lamp turns blue.");
  doc.destroy();
});

test("migration persists one canonical document when two clients open a legacy room", async () => {
  const database = createDatabase();
  const fetchImpl = roomFetch(database);
  await createRoom(fetchImpl, "Draft 9");
  database.sqlite.prepare("UPDATE screenplay_rooms SET blocks_json = ?, revision = 20 WHERE room_id = ?").run(JSON.stringify(BLOCKS), ROOM.roomId);
  database.holdNextReads();
  const responses = await Promise.all([roomRequest(fetchImpl), roomRequest(fetchImpl)]);
  const snapshots = await Promise.all(responses.map((response) => response.json()));
  assert.equal(snapshots[0].revision, 21);
  assert.deepEqual(snapshots[0], snapshots[1]);
  assert.deepEqual(snapshots[0].blocks, BLOCKS);
  const stored = database.sqlite.prepare("SELECT blocks_json FROM screenplay_rooms WHERE room_id = ?").get(ROOM.roomId);
  assert.equal(JSON.parse(stored.blocks_json).format, 2);
  assert.deepEqual(await roomRequest(fetchImpl).then((response) => response.json()), snapshots[0]);
});

test("simultaneous new-room creation merges authorized edits and never overwrites a different key", async () => {
  const database = createDatabase();
  const fetchImpl = roomFetch(database);
  const seed = new Y.Doc();
  seedRoomDocument(seed, { draftName: "Draft 9", blocks: BLOCKS });
  const first = documentFrom({ update: encodeRoomUpdate(seed) });
  const second = documentFrom({ update: encodeRoomUpdate(seed) });
  first.getMap("screenplay").get("action").get("text").insert(0, "First, ");
  second.getMap("screenplay").get("scene").get("text").insert(0, "EXT. ");
  database.holdNextReads();
  const responses = await Promise.all([first, second].map((doc) => roomRequest(fetchImpl, "POST", { update: encodeRoomUpdate(doc) })));
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const saved = await roomRequest(fetchImpl).then((response) => response.json());
  assert.equal(saved.blocks[2].text, "First, The lamp turns blue.");
  assert.equal(saved.blocks[1].text, "EXT. INT. TEST LAB — DAY");

  const otherDatabase = createDatabase();
  const otherFetch = roomFetch(otherDatabase);
  otherDatabase.holdNextReads();
  const contested = await Promise.all([ROOM.key, "0000000000000000"].map((key) => roomRequest(otherFetch, "POST", { update: encodeRoomUpdate(seed) }, { key })));
  assert.deepEqual(contested.map((response) => response.status).sort(), [200, 403]);
  assert.equal(otherDatabase.sqlite.prepare("SELECT revision FROM screenplay_rooms").get().revision, 1);
  seed.destroy(); first.destroy(); second.destroy();
});

test("invalid updates and invalid projected data leave the saved document intact", async () => {
  const fetchImpl = roomFetch(createDatabase());
  const saved = await createRoom(fetchImpl);
  assert.equal((await roomRequest(fetchImpl, "POST", { update: "not base64" })).status, 400);
  assert.equal((await roomRequest(fetchImpl, "POST", { update: "A".repeat(2000004) })).status, 400);
  const invalid = documentFrom(saved);
  invalid.getMap("screenplay").get("action").set("type", "invalid");
  assert.equal((await roomRequest(fetchImpl, "POST", { update: encodeRoomUpdate(invalid) })).status, 400);
  assert.deepEqual(await roomRequest(fetchImpl).then((response) => response.json()), saved);
  invalid.destroy();
});

test("shared helper preserves ties deterministically and refuses to reseed live data", () => {
  const doc = new Y.Doc();
  assert.deepEqual(readRoomDocument(doc), { draftName: "Current draft", blocks: [], drafts: [] });
  seedRoomDocument(doc, { draftName: "Draft 9", blocks: [...BLOCKS].reverse() });
  doc.getMap("screenplay").forEach((block) => block.set("order", 0));
  assert.deepEqual(readRoomDocument(doc).blocks.map((block) => block.id), ["action", "scene", "title"]);
  assert.throws(() => seedRoomDocument(doc, { blocks: BLOCKS }), /Cannot reseed/);
  doc.destroy();
});
