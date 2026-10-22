// All scripts, names, room identifiers, and keys below are fictional test fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { createOperationId, createWorkspaceApi, WorkspaceApiError } from "../src/workspace-api.js";

const roomConfig = { roomId: "workspace-room", key: "workspace-room-key" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}

test("session creation stores its secure token and operation before sending, then retries across reloads", async () => {
  const storage = memoryStorage();
  const writes = [];
  let attempts = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(url, "/api/rooms/workspace-room/sessions");
    assert.equal(options.headers.authorization, "Bearer workspace-room-key");
    const body = JSON.parse(options.body);
    const pending = JSON.parse(storage.getItem("beat-workspace-v1:workspace-room:pending-session"));
    assert.deepEqual(pending.body, body);
    assert.match(body.sessionToken, /^[a-f0-9]{64}$/);
    assert.ok(body.operationId.length >= 16);
    writes.push(body);
    if (++attempts === 1) throw new TypeError("Response lost after creation");
    return Response.json({ session: { id: "session-1", authorName: "Robot", status: "editing" }, revision: 1 });
  };
  const first = createWorkspaceApi({ roomConfig, storage, fetchImpl });
  await assert.rejects(first.createSession({ authorName: "Robot", source: { historyId: "history-9" } }), (error) => error.offline);
  const reloaded = createWorkspaceApi({ roomConfig, storage, fetchImpl });
  const result = await reloaded.createSession({ authorName: "Robot", source: { historyId: "history-9" } });
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(result.sessionToken, writes[0].sessionToken);
  assert.equal(reloaded.getSessionToken("session-1"), writes[0].sessionToken);
  assert.deepEqual(reloaded.listLocalSessions(), ["session-1"]);
  assert.equal(storage.getItem("beat-workspace-v1:workspace-room:pending-session"), null);
});

test("refuses a draft write if its retry identity cannot be saved locally", async () => {
  let requests = 0;
  const api = createWorkspaceApi({
    roomConfig,
    storage: { getItem: () => null, setItem: () => { throw new Error("Storage full"); } },
    fetchImpl: async () => { requests += 1; return Response.json({}); },
  });
  await assert.rejects(api.createSession({ authorName: "Guide" }), /Storage full/);
  assert.equal(requests, 0);
});

test("unavailable browser storage still permits workspace and review reads", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("Storage blocked"); } });
  try {
    const calls = [];
    const api = createWorkspaceApi({ roomConfig, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ ok: true });
    } });
    assert.equal(api.getSessionToken("draft-9"), null);
    assert.deepEqual(api.listLocalSessions(), []);
    await api.getWorkspace();
    await api.getReview("draft-9");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].options.headers["X-Beat-Session-Token"], undefined);
    await assert.rejects(api.createSession({ authorName: "Robot" }), /Allow browser storage/);
    assert.equal(calls.length, 2);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete globalThis.localStorage;
  }
});

test("the exposed request supports authenticated initial room creation", async () => {
  let sent;
  const api = createWorkspaceApi({ roomConfig, storage: null, fetchImpl: async (url, options) => {
    sent = { url, options };
    return Response.json({ revision: 1 });
  } });
  const snapshot = { draftName: "Draft 9", blocks: [{ id: "title", type: "title", text: "MOON STATION" }] };
  await api.request("", { method: "PUT", body: snapshot });
  assert.equal(sent.url, "/api/rooms/workspace-room");
  assert.equal(sent.options.headers.authorization, "Bearer workspace-room-key");
  assert.deepEqual(JSON.parse(sent.options.body), snapshot);
});

test("preserves API status and stale-review details while a newly reviewed promotion gets a new identity", async () => {
  const storage = memoryStorage();
  const bodies = [];
  const api = createWorkspaceApi({
    roomConfig, storage,
    fetchImpl: async (url, options) => {
      assert.equal(url, "/api/rooms/workspace-room/sessions/draft-9/promote");
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) return Response.json({ error: "The current script changed", code: "stale_review", mainRevision: 5 }, { status: 409 });
      return Response.json({ main: { revision: 6 } });
    },
  });
  await assert.rejects(api.promoteSession("draft-9", { expectedMainRevision: 4, reviewedSessionRevision: 2, authorName: "Guide" }), (error) => {
    assert.ok(error instanceof WorkspaceApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "stale_review");
    assert.equal(error.payload.mainRevision, 5);
    return true;
  });
  await api.promoteSession("draft-9", { expectedMainRevision: 5, reviewedSessionRevision: 2, authorName: "Guide" });
  assert.notEqual(bodies[0].operationId, bodies[1].operationId);
});

test("retries uncertain promotions with the same identity and review revisions", async () => {
  const storage = memoryStorage();
  const writes = [];
  const fetchImpl = async (_url, options) => {
    writes.push(JSON.parse(options.body));
    if (writes.length === 1) throw new TypeError("Lost response");
    return Response.json({ main: { revision: 10 } });
  };
  const review = { expectedMainRevision: 9, reviewedSessionRevision: 7, authorName: "Robot" };
  await assert.rejects(createWorkspaceApi({ roomConfig, storage, fetchImpl }).promoteSession("draft-10", review));
  const reloaded = createWorkspaceApi({ roomConfig, storage, fetchImpl });
  await assert.rejects(reloaded.promoteSession("draft-10", { ...review, expectedMainRevision: 10 }), /previous draft request is still pending/);
  await reloaded.promoteSession("draft-10", review);
  assert.deepEqual(writes[1], writes[0]);
});

test("workspace, review and history reads preserve authentication, tokens and cursor encoding", async () => {
  const storage = memoryStorage();
  storage.setItem("beat-workspace-v1:workspace-room:sessions", JSON.stringify({ "draft/9": { sessionToken: "saved-session-token" } }));
  const calls = [];
  const api = createWorkspaceApi({ roomConfig, storage, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ ok: true });
  } });
  await api.getWorkspace();
  await api.getReview("draft/9");
  await api.getHistory({ limit: 10, cursor: "next page/+" });
  await api.getHistoryEvent("history/9");
  assert.deepEqual(calls.map((call) => call.url), [
    "/api/rooms/workspace-room/workspace",
    "/api/rooms/workspace-room/sessions/draft%2F9/review",
    "/api/rooms/workspace-room/history?limit=10&cursor=next+page%2F%2B",
    "/api/rooms/workspace-room/history/history%2F9",
  ]);
  assert.ok(calls.every((call) => call.options.method === "GET" && call.options.headers.authorization === "Bearer workspace-room-key"));
  assert.equal(calls[1].options.headers["X-Beat-Session-Token"], "saved-session-token");
  assert.equal(api.sessionEndpoint("draft/9"), "/api/rooms/workspace-room/sessions/draft%2F9/sync");
});

test("request timeout covers a stalled JSON body, aborts it and leaves creation retry credentials intact", async () => {
  const storage = memoryStorage();
  let timeout;
  let signal;
  let cleared = false;
  const api = createWorkspaceApi({
    roomConfig, storage, requestTimeoutMs: 50,
    timers: { setTimeout: (callback, ms) => { assert.equal(ms, 50); timeout = callback; return 1; }, clearTimeout: () => { cleared = true; } },
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return { status: 200, ok: true, json: () => new Promise(() => {}) };
    },
  });
  const pending = api.createSession({ authorName: "Robot" });
  const rejected = assert.rejects(pending, (error) => error instanceof WorkspaceApiError && error.offline && /too long/.test(error.message));
  await tick();
  timeout();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(cleared, true);
  assert.ok(storage.getItem("beat-workspace-v1:workspace-room:pending-session"));
});

test("secure operation identity has a cryptographic fallback and never silently uses weak randomness", () => {
  let calls = 0;
  const operationId = createOperationId({ getRandomValues: (bytes) => { calls += 1; bytes.fill(42); return bytes; } });
  assert.equal(operationId, "2a".repeat(16));
  assert.equal(calls, 1);
  assert.throws(() => createOperationId({}), /Secure draft storage is unavailable/);
});
