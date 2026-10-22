// All scripts, names, room identifiers, and keys below are fictional test fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import * as Y from "yjs";
import worker from "../worker/index.js";
import { applyRoomUpdate, encodeRoomUpdate, readRoomDocument, seedRoomDocument } from "../shared/room-document.js";

const ROOM = "workspace-test-room";
const KEY = "1234567890abcdef1234567890abcdef";
const BLOCKS = [{ id: "title", type: "title", text: "MOON STATION" }, { id: "scene", type: "scene", text: "INT. TEST LAB — DAY" }, { id: "action", type: "action", text: "The lamp turns blue." }];
const DRAFTS = [{ id: "prior-draft-9", name: "Draft 9", blocks: [...BLOCKS.slice(0, 2), { ...BLOCKS[2], text: "The previous version." }] }];
const op = () => crypto.randomUUID();
const secret = () => op().replaceAll("-", "");

function database() {
  const sqlite = new DatabaseSync(":memory:");
  let barrier;
  const db = {
    sqlite,
    failAt: null,
    collideReads(id = ROOM, count = 2) { barrier = { id, count, waiting: [] }; },
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
  return async (path, method = "GET", body, headers = {}) => {
    const response = await worker.fetch(new Request(`https://example.test/api/rooms/${ROOM}${path}`, { method, headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }), { DB: db, ASSETS: { fetch: async () => new Response("missing", { status: 404 }) } });
    return { status: response.status, ...await response.json() };
  };
}
async function setup() {
  const db = database(); const call = api(db);
  const doc = new Y.Doc(); seedRoomDocument(doc, { draftName: "Draft 3", blocks: BLOCKS, drafts: DRAFTS });
  const initial = await call("/sync", "POST", { update: encodeRoomUpdate(doc) });
  doc.destroy(); assert.equal(initial.status, 200);
  return { db, call, initial };
}
async function start(call, authorName = "Writer A", extra = {}) {
  const body = { authorName, operationId: op(), sessionToken: secret(), ...extra };
  const result = await call("/sessions", "POST", body);
  assert.equal(result.status, 200, JSON.stringify(result));
  return { ...result, body };
}
function edit(session, prefix = "Quietly, ") {
  const doc = new Y.Doc(); applyRoomUpdate(doc, session.update);
  doc.getMap("screenplay").get("action").get("text").insert(0, prefix);
  const update = encodeRoomUpdate(doc); doc.destroy(); return update;
}
function save(call, session, update, operationId = op()) { return call(`/sessions/${session.session.id}/sync`, "POST", { update, operationId }, { "x-beat-session-token": session.sessionToken }); }
function promote(call, session, review, operationId = op(), authorName = "Guide") { return call(`/sessions/${session.session.id}/promote`, "POST", { expectedMainRevision: review.main.revision, reviewedSessionRevision: review.draft.revision, authorName, operationId }); }

 test("workspace activation preserves exact main content, archived drafts, and honest baseline history", async () => {
  const { db, call, initial } = await setup();
  const current = await call("/workspace");
  assert.equal(current.status, 200);
  assert.deepEqual(current.main, { draftName: "Draft 3", blocks: BLOCKS, drafts: DRAFTS, revision: initial.revision, updatedAt: initial.updatedAt });
  assert.equal(current.history.length, 1);
  assert.equal(current.history[0].kind, "baseline");
  assert.equal(current.history[0].authorName, null);
  assert.equal(current.history[0].authorIdentity, "unknown");
  const revision = db.sqlite.prepare("SELECT revision FROM screenplay_rooms WHERE room_id=?").get(ROOM).revision;
  await call("/workspace");
  assert.equal(db.sqlite.prepare("SELECT revision FROM screenplay_rooms WHERE room_id=?").get(ROOM).revision, revision);
  assert.deepEqual((await call("/sync")).blocks, BLOCKS);
  assert.equal((await call("/sync")).revision, initial.revision);
});

test("session creation allocates Draft10/11 atomically and never changes main revision or text", async () => {
  const { db, call } = await setup();
  const main = (await call("/workspace")).main;
  db.collideReads();
  const sessions = await Promise.all([start(call, "Writer A"), start(call, "Guide")]);
  assert.deepEqual(sessions.map((value) => value.draftName).sort(), ["Draft 10", "Draft 11"]);
  assert.equal(new Set(sessions.map((value) => value.session.id)).size, 2);
  const overview = await call("/workspace");
  assert.deepEqual(overview.main, main);
  assert.equal(overview.sessions.length, 2);
  assert.ok(overview.sessions.every((session) => session.baseMainRevision === main.revision));
  assert.equal(overview.history.filter((event) => event.kind === "session_created").length, 2);
});

test("session creation retry reuses its session and rejects mismatched operation IDs", async () => {
  const { call } = await setup();
  const session = await start(call);
  const retry = await call("/sessions", "POST", session.body);
  assert.equal(retry.status, 200);
  assert.equal(retry.session.id, session.session.id);
  assert.equal(retry.sessionToken, session.sessionToken);
  const wrong = await call("/sessions", "POST", { ...session.body, sessionToken: secret() });
  assert.equal(wrong.status, 409);
  assert.equal((await call("/workspace")).sessions.length, 1);
});

test("a token-protected save records who changed what without changing the current script", async () => {
  const { call } = await setup();
  const session = await start(call, "Guide");
  const main = (await call("/workspace")).main;
  const operationId = op();
  const saved = await save(call, session, edit(session), operationId);
  assert.equal(saved.status, 200);
  assert.equal(saved.blocks[2].text, "Quietly, The lamp turns blue.");
  assert.deepEqual((await call("/workspace")).main, main);
  const history = await call(`/history/${operationId}`);
  assert.equal(history.event.authorName, "Guide");
  assert.equal(history.event.authorIdentity, "self-reported");
  assert.equal(history.event.kind, "session_saved");
  assert.equal(history.changes[0].before.text, BLOCKS[2].text);
  assert.equal(history.changes[0].after.text, saved.blocks[2].text);
  assert.deepEqual(history.snapshot.blocks, saved.blocks);
  assert.equal((await call(`/sessions/${session.session.id}/sync`)).sessionToken, undefined);
  assert.equal((await call(`/sessions/${session.session.id}/sync`, "POST", { update: edit(session), operationId: op() }, { "x-beat-session-token": secret() })).status, 403);
});

test("save retries and no-op requests create no duplicate events", async () => {
  const { call } = await setup();
  const session = await start(call);
  const operationId = op(); const update = edit(session);
  const first = await save(call, session, update, operationId);
  const retry = await save(call, session, update, operationId);
  const noop = await save(call, session, update);
  assert.equal(retry.revision, first.revision);
  assert.equal(noop.revision, first.revision);
  assert.equal((await call("/history")).events.filter((event) => event.kind === "session_saved").length, 1);
});

test("concurrent edits within one session merge with two accurate history events", async () => {
  const { db, call } = await setup();
  const session = await start(call);
  db.collideReads(`${ROOM}/sessions/${session.session.id}`);
  const results = await Promise.all([save(call, session, edit(session, "First. ")), save(call, session, edit(session, "Second. "))]);
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  const current = await call(`/sessions/${session.session.id}/sync`);
  assert.match(current.blocks[2].text, /First\. /); assert.match(current.blocks[2].text, /Second\. /);
  assert.equal(current.revision, 3);
  assert.equal((await call("/history")).events.filter((event) => event.kind === "session_saved").length, 2);
  assert.deepEqual((await call("/workspace")).main.blocks, BLOCKS);
});

test("failed atomic history write rolls back the screenplay update too", async () => {
  const { db, call } = await setup();
  const session = await start(call);
  const operationId = op();
  db.failAt = 1;
  const result = await save(call, session, edit(session), operationId);
  assert.equal(result.status, 503);
  assert.equal((await call(`/sessions/${session.session.id}/sync`)).revision, 1);
  assert.equal((await call(`/history/${operationId}`)).status, 404);
  assert.equal((await save(call, session, edit(session), operationId)).status, 200);
});

test("old clients may read and send exact no-ops but cannot mutate main after workspace activation", async () => {
  const { call, initial } = await setup();
  await call("/workspace");
  assert.equal((await call("/sync", "POST", { update: initial.update })).status, 200);
  assert.equal((await call("/sync", "POST", { update: edit(initial) })).status, 428);
  assert.equal((await call("", "PUT", { draftName: "Old draft", blocks: BLOCKS })).status, 428);
  assert.deepEqual((await call("/workspace")).main.blocks, BLOCKS);
});

test("making a reviewed session current is explicit, recorded, idempotent, and closes that session", async () => {
  const { call } = await setup();
  const session = await start(call, "Writer A");
  await save(call, session, edit(session));
  const review = await call(`/sessions/${session.session.id}/review`);
  assert.equal(review.summary.changed, 1);
  assert.equal(review.summary.renamed, true);
  assert.equal(review.main.draftName, "Draft 3");
  assert.equal(review.draft.draftName, "Draft 10");
  const operationId = op();
  const applied = await promote(call, session, review, operationId);
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.main.blocks, review.draft.blocks);
  assert.equal(applied.main.revision, review.main.revision + 1);
  assert.equal(applied.session.status, "applied");
  assert.equal(applied.event.kind, "made_current");
  assert.equal(applied.event.authorName, "Guide");
  assert.equal((await promote(call, session, review, operationId)).main.revision, applied.main.revision);
  assert.equal((await save(call, session, edit(session))).status, 409);
});

test("a review becomes stale after either script changes and explicit renewed review can apply", async () => {
  const { call } = await setup();
  const first = await start(call, "Writer A"); const second = await start(call, "Guide");
  const firstReview = await call(`/sessions/${first.session.id}/review`);
  await save(call, first, edit(first));
  assert.equal((await promote(call, first, firstReview)).status, 409);
  const secondReview = await call(`/sessions/${second.session.id}/review`);
  const latestFirst = await call(`/sessions/${first.session.id}/review`);
  assert.equal((await promote(call, first, latestFirst)).status, 200);
  assert.equal((await promote(call, second, secondReview)).status, 409);
  const refreshed = await call(`/sessions/${second.session.id}/review`);
  assert.notEqual(refreshed.main.revision, second.session.baseMainRevision);
  assert.equal((await promote(call, second, refreshed)).status, 200);
});

test("history restore and legacy saved drafts always fork a session without changing main", async () => {
  const { call } = await setup();
  const initialMain = (await call("/workspace")).main;
  const prior = await start(call, "Writer A", { source: { draftId: "prior-draft-9" } });
  assert.deepEqual(prior.blocks, DRAFTS[0].blocks);
  const historical = await start(call, "Guide", { source: { historyId: "baseline" } });
  assert.deepEqual(historical.blocks, BLOCKS);
  assert.deepEqual((await call("/workspace")).main, initialMain);
  assert.deepEqual(prior.drafts, DRAFTS);
});

test("history promotion remains a causal update for existing main readers and preserves their archive", async () => {
  const { call } = await setup();
  await call("/workspace");
  const oldReader = new Y.Doc();
  applyRoomUpdate(oldReader, (await call("/sync")).update);
  const restored = await start(call, "Writer A", { source: { draftId: "prior-draft-9" } });
  const review = await call(`/sessions/${restored.session.id}/review`);
  assert.equal((await promote(call, restored, review)).status, 200);
  const main = await call("/sync");
  applyRoomUpdate(oldReader, main.update);
  assert.deepEqual(readRoomDocument(oldReader), { draftName: restored.draftName, blocks: DRAFTS[0].blocks, drafts: DRAFTS });
  assert.deepEqual(readRoomDocument(oldReader).blocks, main.blocks);
  oldReader.destroy();
});

test("an inserted element does not mark every following element as moved", async () => {
  const { call } = await setup();
  const session = await start(call);
  const doc = new Y.Doc(); applyRoomUpdate(doc, session.update);
  const root = doc.getMap("screenplay");
  const inserted = new Y.Map(); inserted.set("type", "action"); inserted.set("order", 1); inserted.set("text", new Y.Text("An opening action."));
  root.get("scene").set("order", 2); root.get("action").set("order", 3); root.set("new-action", inserted);
  const saved = await save(call, session, encodeRoomUpdate(doc));
  assert.equal(saved.status, 200);
  const review = await call(`/sessions/${session.session.id}/review`);
  assert.equal(review.summary.added, 1); assert.equal(review.summary.moved, 0);
  assert.equal(review.changes.length, 1);
  doc.destroy();
});

test("promotion rolls back both main and history if marking the session fails", async () => {
  const { db, call } = await setup();
  const session = await start(call);
  const review = await call(`/sessions/${session.session.id}/review`);
  const operationId = op();
  db.failAt = 2;
  assert.equal((await promote(call, session, review, operationId)).status, 503);
  assert.deepEqual((await call("/workspace")).main, review.main);
  assert.equal((await call(`/sessions/${session.session.id}/sync`)).session.status, "active");
  assert.equal((await call(`/history/${operationId}`)).status, 404);
});

test("colliding promotion IDs cannot mark an unrelated session applied", async () => {
  const { db, call } = await setup();
  const a = await start(call, "Writer A"); const b = await start(call, "Guide");
  const ar = await call(`/sessions/${a.session.id}/review`); const br = await call(`/sessions/${b.session.id}/review`);
  const operationId = op();
  db.collideReads();
  const results = await Promise.all([promote(call, a, ar, operationId), promote(call, b, br, operationId)]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  const workspace = await call("/workspace");
  assert.equal(workspace.sessions.filter((session) => session.status === "applied").length, 1);
  assert.equal(workspace.history.filter((event) => event.kind === "made_current").length, 1);
});

test("history is paginated without duplicates and another room key cannot read it", async () => {
  const { call } = await setup();
  await start(call, "Writer A"); await start(call, "Guide");
  const first = await call("/history?limit=2");
  assert.equal(first.events.length, 2); assert.ok(first.nextCursor);
  const second = await call(`/history?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert.equal(second.events.length, 1);
  assert.equal(new Set([...first.events, ...second.events].map((event) => event.id)).size, 3);
  assert.equal((await call("/history", "GET", undefined, { authorization: "Bearer 0000000000000000" })).status, 403);
  assert.equal((await call("/workspace", "GET", undefined, { authorization: "Bearer 0000000000000000" })).status, 403);
});
