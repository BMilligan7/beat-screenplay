// All scripts, names, room identifiers, and keys below are fictional test fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { createRoomSync } from "../src/room-sync.js";
import { applyRoomUpdate, encodeRoomUpdate, readRoomDocument, seedRoomDocument } from "../shared/room-document.js";

const roomConfig = { roomId: "test-room", key: "test-room-key" };
const initialSnapshot = {
  draftName: "Draft 8",
  blocks: [{ id: "opening", type: "action", text: "A robot checks a dial." }],
  drafts: [],
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

function scheduler() {
  let nextId = 0;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) { const id = ++nextId; tasks.set(id, { callback, delay }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    async fire(delay) {
      const item = [...tasks].find(([, task]) => task.delay === delay);
      assert.ok(item, `Expected a timer for ${delay} ms`);
      tasks.delete(item[0]);
      item[1].callback();
      await tick();
    },
    get size() { return tasks.size; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function repository(snapshot = initialSnapshot) {
  let canonical = snapshot ? new Y.Doc() : null;
  if (canonical) seedRoomDocument(canonical, snapshot);
  let revision = canonical ? 1 : 0;
  const requests = [];
  const failures = [];
  let postGate = null;
  const payload = () => ({ update: encodeRoomUpdate(canonical), revision, updatedAt: `revision-${revision}`, ...readRoomDocument(canonical) });
  return {
    requests,
    failures,
    get doc() { return canonical; },
    get revision() { return revision; },
    pausePost() { postGate = deferred(); return postGate; },
    async fetchImpl(url, options) {
      assert.equal(url, "/api/rooms/test-room/sync");
      assert.equal(options.headers.authorization, "Bearer test-room-key");
      requests.push(options);
      const failure = failures.findIndex((entry) => entry.method === options.method);
      if (failure >= 0) throw failures.splice(failure, 1)[0].error;
      if (options.method === "GET") return canonical ? Response.json(payload()) : Response.json({ error: "Not found" }, { status: 404 });
      const gate = postGate;
      postGate = null;
      if (gate) await gate.promise;
      const before = canonical ? encodeRoomUpdate(canonical) : null;
      canonical ||= new Y.Doc();
      applyRoomUpdate(canonical, JSON.parse(options.body).update, "server");
      if (before !== encodeRoomUpdate(canonical)) revision += 1;
      return Response.json(payload());
    },
  };
}

function client(server, options = {}) {
  const doc = options.doc || new Y.Doc();
  const timers = scheduler();
  const statuses = [];
  const ready = [];
  const sync = createRoomSync({
    doc, roomConfig, initialSnapshot, fetchImpl: server.fetchImpl, timers,
    debounceMs: 7, pollMs: 30, retryMs: 40,
    onStatus: (value, info) => statuses.push({ value, info }),
    onReady: (snapshot) => ready.push(snapshot),
    ...options,
  });
  return { doc, sync, timers, statuses, ready };
}

function textOf(doc) { return doc.getMap("screenplay").get("opening").get("text"); }

test("merges saved room data before becoming ready and does not rewrite an unchanged room", async (t) => {
  const server = repository();
  const app = client(server);
  t.after(() => app.sync.stop());
  await app.sync.start();
  assert.deepEqual(readRoomDocument(app.doc), initialSnapshot);
  assert.equal(app.ready.length, 1);
  assert.deepEqual(server.requests.map((entry) => entry.method), ["GET", "POST"]);
  assert.equal(server.revision, 1);
  assert.equal(app.statuses.at(-1).value, "saved");
  await app.timers.fire(30);
  assert.deepEqual(server.requests.map((entry) => entry.method), ["GET", "POST", "GET"]);
});

test("waits for a successful missing-room lookup before seeding a new room", async (t) => {
  const server = repository(null);
  server.failures.push({ method: "GET", error: new TypeError("Network unavailable") });
  const app = client(server);
  t.after(() => app.sync.stop());
  await app.sync.start();
  assert.equal(readRoomDocument(app.doc).blocks.length, 0);
  assert.equal(app.ready.length, 0);
  assert.equal(app.statuses.at(-1).value, "offline");
  assert.deepEqual(server.requests.map((entry) => entry.method), ["GET"]);
  await app.timers.fire(40);
  assert.deepEqual(readRoomDocument(server.doc), initialSnapshot);
  assert.equal(app.ready.length, 1);
  assert.deepEqual(server.requests.map((entry) => entry.method), ["GET", "GET", "POST"]);
});

test("a guest opening before the owner saves waits for the shared script without creating an empty room", async (t) => {
  const server = repository(null);
  const guest = client(server, { initialSnapshot: { draftName: "Current draft", blocks: [] } });
  t.after(() => guest.sync.stop());
  await guest.sync.start();
  assert.equal(guest.ready.length, 0);
  assert.equal(guest.doc.getMap("metadata").size, 0);
  assert.equal(server.doc, null);
  assert.deepEqual(server.requests.map((entry) => entry.method), ["GET"]);
  assert.match(guest.statuses.at(-1).info.error, /still saving/);

  const owner = new Y.Doc();
  seedRoomDocument(owner, initialSnapshot);
  await server.fetchImpl("/api/rooms/test-room/sync", {
    method: "POST",
    headers: { authorization: "Bearer test-room-key" },
    body: JSON.stringify({ update: encodeRoomUpdate(owner) }),
  });
  await guest.timers.fire(40);
  assert.deepEqual(readRoomDocument(guest.doc), initialSnapshot);
  assert.equal(guest.ready.length, 1);
  assert.equal(guest.statuses.at(-1).value, "saved");
  assert.equal(server.revision, 1, "The guest's initial merge does not rewrite the owner's script");
  assert.deepEqual(server.requests.map((entry) => entry.method), ["GET", "POST", "GET", "POST"]);
});

test("uploads cached deletions when reconnecting without reseeding canonical elements", async (t) => {
  const server = repository();
  const cached = new Y.Doc();
  applyRoomUpdate(cached, encodeRoomUpdate(server.doc), "cache");
  textOf(cached).delete(0, 8);
  const app = client(server, { doc: cached });
  t.after(() => app.sync.stop());
  await app.sync.start();
  assert.equal(textOf(server.doc).toString(), "checks a dial.");
  assert.equal(textOf(app.doc).toString(), "checks a dial.");
  assert.equal(server.revision, 2);
  assert.equal(readRoomDocument(app.doc).blocks.length, 1);
});

test("serializes edits made during a delayed save and persists the later edit too", async (t) => {
  const server = repository();
  const app = client(server);
  t.after(() => app.sync.stop());
  await app.sync.start();
  const gate = server.pausePost();
  textOf(app.doc).insert(0, "First. ");
  const saving = app.sync.flush();
  await tick();
  textOf(app.doc).insert(0, "Second. ");
  assert.equal(server.requests.filter((entry) => entry.method === "POST").length, 2);
  gate.resolve();
  await saving;
  assert.equal(server.requests.filter((entry) => entry.method === "POST").length, 3);
  assert.equal(textOf(server.doc).toString(), "Second. First. A robot checks a dial.");
  assert.equal(app.statuses.at(-1).value, "saved");
});

test("retries a failed save and retains changes made while offline", async (t) => {
  const server = repository();
  const app = client(server);
  t.after(() => app.sync.stop());
  await app.sync.start();
  server.failures.push({ method: "POST", error: new TypeError("Connection lost") });
  textOf(app.doc).insert(0, "New. ");
  await app.timers.fire(7);
  assert.equal(app.statuses.at(-1).value, "offline");
  textOf(app.doc).insert(0, "Newest. ");
  await app.timers.fire(40);
  assert.equal(textOf(server.doc).toString(), "Newest. New. A robot checks a dial.");
  assert.equal(app.statuses.at(-1).value, "saved");
});

test("reuses a write operation for an identical retry and assigns a new one after edits", async (t) => {
  const server = repository();
  const app = client(server);
  t.after(() => app.sync.stop());
  await app.sync.start();
  server.failures.push(
    { method: "POST", error: new TypeError("Response lost") },
    { method: "POST", error: new TypeError("Still unavailable") },
  );
  textOf(app.doc).insert(0, "First edit. ");
  await app.sync.flush();
  await app.sync.flush();
  textOf(app.doc).insert(0, "Second edit. ");
  await app.sync.flush();
  const writes = server.requests.filter((entry) => entry.method === "POST").map((entry) => JSON.parse(entry.body));
  assert.ok(writes.every((entry) => typeof entry.operationId === "string" && entry.operationId.length >= 16));
  assert.equal(writes[1].operationId, writes[2].operationId);
  assert.equal(writes[1].update, writes[2].update);
  assert.notEqual(writes[2].operationId, writes[3].operationId);
  assert.notEqual(writes[2].update, writes[3].update);
});

test("uses a session endpoint and token while exposing session metadata", async (t) => {
  const server = repository();
  const endpoint = "/api/rooms/test-room/sessions/session-one/sync";
  const session = { id: "session-one", status: "editing", draftName: "Draft 9", revision: 2 };
  const app = client(server, {
    endpoint,
    sessionToken: "private-session-token",
    headers: { "X-Client-Test": "session" },
    fetchImpl: async (url, options) => {
      assert.equal(url, endpoint);
      assert.equal(options.headers["X-Beat-Session-Token"], "private-session-token");
      assert.equal(options.headers["X-Client-Test"], "session");
      const response = await server.fetchImpl("/api/rooms/test-room/sync", options);
      return Response.json({ ...await response.json(), session });
    },
  });
  t.after(() => app.sync.stop());
  await app.sync.start();
  assert.deepEqual(app.ready[0].session, session);
  assert.deepEqual(app.statuses.at(-1).info.session, session);
});

test("read-only synchronization never posts, seeds an empty document, or reports pending writes", async (t) => {
  const server = repository();
  const app = client(server, { readOnly: true });
  t.after(() => app.sync.stop());
  await app.sync.start();
  textOf(app.doc).insert(0, "An accidental local mutation. ");
  await app.sync.flush();
  await app.timers.fire(30);
  assert.ok(server.requests.every((entry) => entry.method === "GET"));
  assert.equal(app.sync.hasPendingChanges(), false);
  assert.equal(textOf(server.doc).toString(), initialSnapshot.blocks[0].text);

  const missingServer = repository(null);
  const missing = client(missingServer, { readOnly: true });
  t.after(() => missing.sync.stop());
  await missing.sync.start();
  assert.equal(readRoomDocument(missing.doc).blocks.length, 0);
  assert.equal(missing.doc.getMap("metadata").size, 0);
  assert.equal(missing.ready.length, 0);
  assert.equal(missing.sync.hasPendingChanges(), false);
  assert.deepEqual(missingServer.requests.map((entry) => entry.method), ["GET"]);
});

test("an already applied session opens without an initial write", async (t) => {
  const server = repository();
  const app = client(server, { fetchImpl: async (url, options) => {
    const response = await server.fetchImpl(url, options);
    return Response.json({ ...await response.json(), session: { id: "done", status: "applied" } });
  } });
  t.after(() => app.sync.stop());
  await app.sync.start();
  assert.deepEqual(server.requests.map((entry) => entry.method), ["GET"]);
  assert.equal(app.statuses.at(-1).info.session.status, "applied");
  assert.equal(app.statuses.at(-1).info.hasUnpublishedChanges, false);
  assert.equal(app.sync.hasPendingChanges(), false);
});

test("a rejected save refreshes session status and stops writing when another collaborator made it current", async (t) => {
  const server = repository();
  let applied = false;
  let gate = null;
  const methods = [];
  const app = client(server, { fetchImpl: async (url, options) => {
    methods.push(options.method);
    if (gate && options.method === "POST") await gate.promise;
    if (applied && options.method === "POST") return Response.json({ error: "The session was already made current" }, { status: 409 });
    const response = await server.fetchImpl(url, options);
    return Response.json({ ...await response.json(), session: { id: "draft-9", status: applied ? "applied" : "active" } });
  } });
  t.after(() => app.sync.stop());
  await app.sync.start();
  gate = deferred();
  textOf(app.doc).insert(0, "A late local edit. ");
  const saving = app.sync.flush();
  await tick();
  textOf(app.doc).insert(0, "Still typing. ");
  applied = true;
  gate.resolve();
  await saving;
  assert.equal(app.statuses.at(-1).info.statusCode, 409);
  await app.timers.fire(40);
  assert.deepEqual(methods, ["GET", "POST", "POST", "GET"]);
  assert.equal(app.statuses.at(-1).info.session.status, "applied");
  assert.equal(app.statuses.at(-1).info.hasUnpublishedChanges, true);
  assert.equal(textOf(app.doc).toString(), "Still typing. A late local edit. A robot checks a dial.");
  assert.equal(app.sync.hasPendingChanges(), false);
});

test("applied-session recovery detects cached edits before a local update listener has seen them", async (t) => {
  const server = repository();
  const cached = new Y.Doc();
  applyRoomUpdate(cached, encodeRoomUpdate(server.doc), "cache");
  textOf(cached).insert(0, "Recovered from cache. ");
  const app = client(server, { doc: cached, fetchImpl: async (url, options) => {
    const response = await server.fetchImpl(url, options);
    return Response.json({ ...await response.json(), session: { id: "done", status: "applied" } });
  } });
  t.after(() => app.sync.stop());
  await app.sync.start();
  assert.equal(app.ready[0].hasUnpublishedChanges, true);
  assert.equal(app.statuses.at(-1).info.hasUnpublishedChanges, true);
  assert.deepEqual(server.requests.map((entry) => entry.method), ["GET"]);
});

test("aborts a hung response body and retries the unsaved document", async (t) => {
  const server = repository();
  let hangNextPost = false;
  let hungSignal;
  const app = client(server, {
    requestTimeoutMs: 50,
    fetchImpl: async (url, options) => {
      if (hangNextPost && options.method === "POST") {
        hangNextPost = false;
        hungSignal = options.signal;
        return { status: 200, ok: true, json: () => new Promise(() => {}) };
      }
      return server.fetchImpl(url, options);
    },
  });
  t.after(() => app.sync.stop());
  await app.sync.start();
  hangNextPost = true;
  textOf(app.doc).insert(0, "Keep this edit. ");
  const saving = app.sync.flush();
  await tick();
  assert.equal(app.statuses.at(-1).value, "saving");
  await app.timers.fire(50);
  await saving;
  assert.equal(hungSignal.aborted, true);
  assert.equal(app.statuses.at(-1).value, "offline");
  assert.match(app.statuses.at(-1).info.error, /too long/);
  await app.timers.fire(40);
  assert.equal(textOf(server.doc).toString(), "Keep this edit. A robot checks a dial.");
  assert.equal(app.statuses.at(-1).value, "saved");
});

test("propagates script, draft name and saved drafts through the same room without peers", async (t) => {
  const server = repository();
  const writer = client(server);
  const collaborator = client(server);
  t.after(() => { writer.sync.stop(); collaborator.sync.stop(); });
  await writer.sync.start();
  await collaborator.sync.start();
  writer.doc.transact(() => {
    textOf(writer.doc).insert(0, "They sit. ");
    writer.doc.getMap("metadata").set("draftName", "Draft 9");
    writer.doc.getMap("drafts").set("draft-8", { id: "draft-8", name: "Draft 8", blocks: initialSnapshot.blocks });
  }, "author");
  await writer.sync.flush();
  const posts = server.requests.filter((entry) => entry.method === "POST").length;
  await collaborator.timers.fire(30);
  assert.deepEqual(readRoomDocument(collaborator.doc), readRoomDocument(writer.doc));
  assert.equal(readRoomDocument(collaborator.doc).draftName, "Draft 9");
  assert.equal(readRoomDocument(collaborator.doc).drafts[0].name, "Draft 8");
  assert.equal(server.requests.filter((entry) => entry.method === "POST").length, posts, "A remote merge should not trigger another save");
  assert.ok(server.requests.every((entry) => entry.headers.authorization === "Bearer test-room-key"));
});

test("merges simultaneous independent edits from two clients instead of replacing snapshots", async (t) => {
  const server = repository();
  const first = client(server);
  const second = client(server);
  t.after(() => { first.sync.stop(); second.sync.stop(); });
  await first.sync.start();
  await second.sync.start();
  textOf(first.doc).insert(0, "First addition. ");
  textOf(second.doc).insert(textOf(second.doc).length, " Second addition.");
  await Promise.all([first.sync.flush(), second.sync.flush()]);
  await first.sync.flush();
  assert.equal(textOf(first.doc).toString(), "First addition. A robot checks a dial. Second addition.");
  assert.equal(textOf(second.doc).toString(), textOf(first.doc).toString());
});

test("stop cancels timers and ignores a response that arrives after the room is closed", async () => {
  const server = repository();
  const app = client(server);
  await app.sync.start();
  const gate = server.pausePost();
  textOf(app.doc).insert(0, "Pending. ");
  const saving = app.sync.flush();
  await tick();
  const activeRequest = server.requests.at(-1);
  app.sync.stop();
  const statusCount = app.statuses.length;
  assert.equal(app.timers.size, 0);
  assert.equal(activeRequest.signal.aborted, true);
  gate.resolve();
  await saving;
  textOf(app.doc).insert(0, "After close. ");
  await tick();
  assert.equal(app.timers.size, 0);
  assert.equal(app.statuses.length, statusCount);
});
