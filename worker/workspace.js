import { readProject } from "./projects.js";
import * as Y from "yjs";
import { applyRoomUpdate, encodeRoomUpdate, readRoomDocument, seedRoomDocument } from "../shared/room-document.js";

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS screenplay_rooms (room_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, draft_name TEXT NOT NULL, blocks_json TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL)`;
const SELECT_ROW = "SELECT room_id, key_hash, draft_name, blocks_json, updated_at, revision FROM screenplay_rooms WHERE room_id = ?";
const TYPES = new Set(["scene", "action", "character", "dialogue", "parenthetical", "transition", "title", "centered", "section", "divider"]);
const LIMIT = 1800000;
const ATTEMPTS = 8;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new HttpError(status, message); }
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
async function hash(value) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function validId(id) { return typeof id === "string" && /^[a-z0-9_-]{8,128}$/i.test(id); }
function name(value) { if (typeof value !== "string" || !value.trim() || value.length > 80) fail(400, "Enter your display name (up to 80 characters)."); return value.trim(); }
function operation(value) { if (!validId(value)) fail(400, "A valid operation ID is required."); return value; }
function token(value) { if (typeof value !== "string" || !/^[a-z0-9_-]{32,128}$/i.test(value)) fail(400, "A valid session editing token is required."); return value; }
function serial(value) { const text = JSON.stringify(value); if (text.length > LIMIT) fail(413, "This change is too large to save with its history. Download a backup before reducing it."); return text; }
function validBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 2000) return false;
  const ids = new Set();
  return blocks.every((block) => {
    if (!block || typeof block.id !== "string" || !block.id || block.id.length > 200 || ids.has(block.id) || !TYPES.has(block.type) || typeof block.text !== "string" || block.text.length > 50000) return false;
    ids.add(block.id); return true;
  });
}
function validate(snapshot) {
  if (typeof snapshot.draftName !== "string" || !snapshot.draftName.trim() || snapshot.draftName.length > 120 || !validBlocks(snapshot.blocks) || !Array.isArray(snapshot.drafts) || snapshot.drafts.length > 50 || snapshot.drafts.some((draft) => typeof draft.name !== "string" || !draft.name.trim() || draft.name.length > 120 || !validBlocks(draft.blocks))) fail(400, "The session contains invalid screenplay data.");
  return snapshot;
}
function inspect(update) {
  const doc = new Y.Doc();
  try { applyRoomUpdate(doc, update); return validate(readRoomDocument(doc)); }
  finally { doc.destroy(); }
}
function parse(row, kind) {
  let data;
  try { data = JSON.parse(row.blocks_json); } catch { fail(503, "The saved workspace could not be read."); }
  if (kind && data.kind !== kind) fail(404, "That workspace item could not be found.");
  return data;
}
function rootData(row) {
  let data = parse(row);
  if (Array.isArray(data)) {
    const doc = new Y.Doc();
    try { seedRoomDocument(doc, { draftName: row.draft_name, blocks: data }); data = { format: 2, update: encodeRoomUpdate(doc) }; }
    finally { doc.destroy(); }
  }
  if (![2, 3].includes(data.format) || !data.update) fail(503, "The saved workspace could not be read.");
  return { ...data, snapshot: inspect(data.update) };
}
function mainProjection(row, data = rootData(row)) {
  return { draftName: data.snapshot.draftName, blocks: data.snapshot.blocks, drafts: data.snapshot.drafts, revision: data.mainRevision ?? Number(row.revision), updatedAt: data.mainUpdatedAt ?? row.updated_at };
}
function sessionProjection(row, data = parse(row, "session")) { return { ...data.meta, revision: Number(row.revision), updatedAt: row.updated_at }; }
function sessionResponse(row) {
  const data = parse(row, "session");
  return { session: sessionProjection(row, data), update: data.update, ...inspect(data.update), revision: Number(row.revision), updatedAt: row.updated_at };
}
function eventResponse(row) { const data = parse(row, "history"); return { event: data.event, changes: data.changes, snapshot: data.snapshot }; }
async function readRow(db, id) { return db.prepare(SELECT_ROW).bind(id).first(); }
async function requireRoot(db, rootId, keyHash) { const row = await readRow(db, rootId); if (!row) fail(404, "The shared script could not be found."); if (row.key_hash !== keyHash) fail(403, "The room key does not match."); return row; }
async function requireSession(db, rootId, id, keyHash) { if (!validId(id)) fail(404, "That session could not be found."); const row = await readRow(db, `${rootId}/sessions/${id}`); if (!row || row.key_hash !== keyHash) fail(404, "That session could not be found."); parse(row, "session"); return row; }
function changeSet(before, after) {
  const left = new Map(before.blocks.map((block, index) => [block.id, { ...block, index }]));
  const right = new Map(after.blocks.map((block, index) => [block.id, { ...block, index }]));
  const leftOrder = new Map([...left.keys()].filter((id) => right.has(id)).map((id, index) => [id, index]));
  const rightOrder = new Map([...right.keys()].filter((id) => left.has(id)).map((id, index) => [id, index]));
  const changes = [];
  const summary = { added: 0, removed: 0, changed: 0, moved: 0, renamed: before.draftName !== after.draftName };
  for (const id of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(id); const b = right.get(id);
    let kind;
    if (!a) { kind = "added"; summary.added += 1; }
    else if (!b) { kind = "removed"; summary.removed += 1; }
    else {
      const moved = leftOrder.get(id) !== rightOrder.get(id);
      if (moved) summary.moved += 1;
      if (a.type !== b.type || a.text !== b.text) { kind = "changed"; summary.changed += 1; }
      else if (moved) kind = "moved";
    }
    if (kind) changes.push({ id, kind, ...(a ? { before: a } : {}), ...(b ? { after: b } : {}) });
  }
  return { changes, summary };
}
function draftNumber(value) {
  const number = Number(value.match(/\d+/)?.[0] || 0);
  return Number.isSafeInteger(number) && number >= 0 && number < 1000000000 ? number : 0;
}
function updateMainDocument(currentUpdate, snapshot) {
  const doc = new Y.Doc();
  try {
    applyRoomUpdate(doc, currentUpdate);
    doc.transact(() => {
      // This is the explicit reviewed replacement. Make it a causal change to
      // the canonical document, so older readers also observe removals correctly.
      const root = doc.getMap("screenplay");
      root.clear();
      snapshot.blocks.forEach((block, order) => {
        const value = new Y.Map();
        value.set("type", block.type); value.set("order", order); value.set("text", new Y.Text(block.text));
        root.set(block.id, value);
      });
      doc.getMap("metadata").set("draftName", snapshot.draftName);
      // Earlier named drafts belong to the current workspace, not this session.
      // Keep that archive even when the reviewed session came from older history.
    }, "reviewed-session-promotion");
    return encodeRoomUpdate(doc);
  } finally { doc.destroy(); }
}
function historyData({ id, kind, authorName = null, sessionId, snapshot, before, mainRevision, sessionRevision, createdAt = new Date().toISOString(), requestHash }) {
  const diff = changeSet(before ?? snapshot, snapshot);
  return { kind: "history", version: 1, requestHash, event: { id, kind, authorName, authorIdentity: authorName ? "self-reported" : "unknown", ...(sessionId ? { sessionId } : {}), draftName: snapshot.draftName, createdAt, mainRevision, ...(sessionRevision !== undefined ? { sessionRevision } : {}), summary: diff.summary }, changes: diff.changes, snapshot: { draftName: snapshot.draftName, blocks: snapshot.blocks } };
}
function guards(rows, keyHash) {
  return { sql: rows.map(() => "EXISTS (SELECT 1 FROM screenplay_rooms WHERE room_id = ? AND revision = ? AND key_hash = ?)").join(" AND "), values: rows.flatMap((row) => [row.room_id, Number(row.revision), keyHash]) };
}
function insertGuarded(db, id, keyHash, draftName, data, timestamp, guard) {
  return db.prepare(`INSERT INTO screenplay_rooms (room_id, key_hash, draft_name, blocks_json, updated_at, revision) SELECT ?, ?, ?, ?, ?, 1 WHERE ${guard.sql}`)
    .bind(id, keyHash, draftName, serial(data), timestamp, ...guard.values);
}
function updateGuarded(db, row, keyHash, draftName, data, timestamp, extra = "", values = []) {
  return db.prepare(`UPDATE screenplay_rooms SET draft_name = ?, blocks_json = ?, updated_at = ?, revision = revision + 1 WHERE room_id = ? AND revision = ? AND key_hash = ?${extra}`)
    .bind(draftName, serial(data), timestamp, row.room_id, Number(row.revision), keyHash, ...values);
}
async function batch(db, statements) {
  if (typeof db.batch !== "function") fail(503, "Saving with history is temporarily unavailable. Nothing was changed.");
  return db.batch(statements);
}
function changed(result) { return Number(result?.meta?.changes) === 1; }
async function existingOperation(db, rootId, id, requestHash, keyHash) {
  const row = await readRow(db, `${rootId}/history/${id}`);
  if (!row) return null;
  const data = parse(row, "history");
  if (row.key_hash !== keyHash || data.requestHash !== requestHash) fail(409, "That operation ID was already used for a different change.");
  return data;
}

async function activateWorkspace(db, rootId, keyHash) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const row = await requireRoot(db, rootId, keyHash);
    const data = rootData(row);
    if (data.format === 3 && data.kind === "workspace") return row;
    const nextDraftNumber = Math.max(1, ...[data.snapshot.draftName, ...data.snapshot.drafts.map((draft) => draft.name)].map(draftNumber)) + 1;
    const next = { format: 3, kind: "workspace", update: data.update, mainRevision: Number(row.revision), mainUpdatedAt: row.updated_at, nextDraftNumber, enabledAt: new Date().toISOString() };
    const baseline = historyData({ id: "baseline", kind: "baseline", snapshot: data.snapshot, mainRevision: Number(row.revision), createdAt: row.updated_at });
    const result = await batch(db, [
      insertGuarded(db, `${rootId}/history/baseline`, keyHash, data.snapshot.draftName, baseline, row.updated_at, guards([row], keyHash)),
      updateGuarded(db, row, keyHash, data.snapshot.draftName, next, row.updated_at),
    ]);
    if (changed(result[1])) return { ...row, blocks_json: serial(next), revision: Number(row.revision) + 1 };
  }
  fail(503, "Other writers are connecting. Please try again.");
}
async function historyList(db, rootId, keyHash, url) {
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20));
  const prefix = `${rootId}/history/`;
  let cursor;
  if (url.searchParams.has("cursor")) {
    try { cursor = JSON.parse(atob(url.searchParams.get("cursor"))); } catch { fail(400, "The history cursor is invalid."); }
    if (typeof cursor?.id !== "string" || !cursor.id.startsWith(prefix) || typeof cursor?.at !== "string") fail(400, "The history cursor is invalid.");
  }
  const sql = `SELECT room_id, updated_at, json_extract(blocks_json, '$.event') AS event_json FROM screenplay_rooms WHERE substr(room_id, 1, ?) = ? AND key_hash = ?${cursor ? " AND (updated_at < ? OR (updated_at = ? AND room_id < ?))" : ""} ORDER BY updated_at DESC, room_id DESC LIMIT ?`;
  const values = [prefix.length, prefix, keyHash, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []), limit + 1];
  const response = await db.prepare(sql).bind(...values).all();
  const rows = response.results || [];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { events: page.map((row) => JSON.parse(row.event_json)), nextCursor: rows.length > limit ? btoa(JSON.stringify({ id: last.room_id, at: last.updated_at })) : null };
}
async function overview(db, rootId, keyHash, url) {
  const row = await activateWorkspace(db, rootId, keyHash);
  const prefix = `${rootId}/sessions/`;
  const listed = await db.prepare("SELECT revision, updated_at, json_extract(blocks_json, '$.meta') AS meta_json FROM screenplay_rooms WHERE substr(room_id, 1, ?) = ? AND key_hash = ? ORDER BY updated_at DESC, room_id DESC LIMIT 100").bind(prefix.length, prefix, keyHash).all();
  const history = await historyList(db, rootId, keyHash, url);
  return { project: await readProject(db, rootId), main: mainProjection(row), sessions: (listed.results || []).map((item) => ({ ...JSON.parse(item.meta_json), revision: Number(item.revision), updatedAt: item.updated_at })), history: history.events, nextCursor: history.nextCursor, promotionPolicy: "any" };
}
async function createSession(db, rootId, keyHash, payload) {
  const authorName = name(payload.authorName);
  const operationId = operation(payload.operationId);
  const sessionToken = token(payload.sessionToken);
  const sessionTokenHash = await hash(sessionToken);
  const historyId = payload.source?.historyId;
  const draftId = payload.source?.draftId;
  if (historyId !== undefined && !validId(historyId)) fail(400, "The source history entry is invalid.");
  if (draftId !== undefined && (typeof draftId !== "string" || !draftId || draftId.length > 200)) fail(400, "The source saved draft is invalid.");
  if (historyId && draftId) fail(400, "Choose one source for the writing session.");
  const requestHash = await hash(JSON.stringify({ kind: "session_created", authorName, sessionTokenHash, historyId, draftId }));
  const id = crypto.randomUUID();
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const prior = await existingOperation(db, rootId, operationId, requestHash, keyHash);
    if (prior) return { ...sessionResponse(await requireSession(db, rootId, prior.event.sessionId, keyHash)), sessionToken };
    const row = await activateWorkspace(db, rootId, keyHash);
    const data = rootData(row);
    let source = data.snapshot;
    if (historyId) {
      const history = await readRow(db, `${rootId}/history/${historyId}`);
      if (!history || history.key_hash !== keyHash) fail(404, "That history entry could not be found.");
      source = parse(history, "history").snapshot;
    }
    if (draftId) {
      const draft = data.snapshot.drafts.find((item) => item.id === draftId);
      if (!draft) fail(404, "That saved draft could not be found.");
      source = { draftName: draft.name, blocks: draft.blocks };
    }
    const draftName = `Draft ${data.nextDraftNumber}`;
    const doc = new Y.Doc();
    let update;
    let snapshot;
    try {
      if (historyId || draftId) seedRoomDocument(doc, { ...source, draftName, drafts: data.snapshot.drafts });
      else { applyRoomUpdate(doc, data.update); doc.getMap("metadata").set("draftName", draftName); }
      update = encodeRoomUpdate(doc); snapshot = validate(readRoomDocument(doc));
    } finally { doc.destroy(); }
    const timestamp = new Date().toISOString();
    const meta = { id, draftName, authorName, baseMainRevision: data.mainRevision, baseDraftName: data.snapshot.draftName, status: "active", createdAt: timestamp, ...(historyId ? { sourceHistoryId: historyId } : {}), ...(draftId ? { sourceDraftId: draftId } : {}) };
    const session = { kind: "session", version: 1, update, meta, sessionTokenHash };
    const event = historyData({ id: operationId, kind: "session_created", authorName, sessionId: id, snapshot, before: source, mainRevision: data.mainRevision, sessionRevision: 1, createdAt: timestamp, requestHash });
    const next = { ...data, nextDraftNumber: data.nextDraftNumber + 1 }; delete next.snapshot;
    const guard = guards([row], keyHash);
    const result = await batch(db, [
      insertGuarded(db, `${rootId}/history/${operationId}`, keyHash, draftName, event, timestamp, guard),
      insertGuarded(db, `${rootId}/sessions/${id}`, keyHash, draftName, session, timestamp, guard),
      updateGuarded(db, row, keyHash, data.snapshot.draftName, next, row.updated_at),
    ]);
    if (changed(result[2])) return { ...sessionResponse({ room_id: `${rootId}/sessions/${id}`, key_hash: keyHash, blocks_json: serial(session), updated_at: timestamp, revision: 1 }), sessionToken };
  }
  fail(503, "Another session is starting. Please try again.");
}
async function saveSession(db, rootId, sessionId, keyHash, request, payload) {
  const operationId = operation(payload.operationId);
  const sessionTokenHash = await hash(token(request.headers.get("x-beat-session-token")));
  if (typeof payload.update !== "string" || payload.update.length > 2000000) fail(400, "The session update is invalid or too large.");
  const requestHash = await hash(JSON.stringify({ kind: "session_saved", sessionId, update: payload.update, sessionTokenHash }));
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const row = await requireSession(db, rootId, sessionId, keyHash);
    const data = parse(row, "session");
    if (data.sessionTokenHash !== sessionTokenHash) fail(403, "This writing session belongs to another device. Start your own session to write.");
    const prior = await existingOperation(db, rootId, operationId, requestHash, keyHash);
    if (prior) return sessionResponse(row);
    if (data.meta.status !== "active") fail(409, "This session was already made current. Start a new session to keep writing.");
    const before = inspect(data.update);
    const doc = new Y.Doc();
    let update; let snapshot;
    try {
      applyRoomUpdate(doc, data.update);
      try { applyRoomUpdate(doc, payload.update); snapshot = validate(readRoomDocument(doc)); }
      catch (error) { if (error instanceof HttpError) throw error; fail(400, "The session update could not be read."); }
      update = encodeRoomUpdate(doc);
    } finally { doc.destroy(); }
    if (update === data.update) return sessionResponse(row);
    const timestamp = new Date().toISOString();
    const next = { ...data, update, meta: { ...data.meta, draftName: snapshot.draftName } };
    const event = historyData({ id: operationId, kind: "session_saved", authorName: data.meta.authorName, sessionId, snapshot, before, mainRevision: data.meta.baseMainRevision, sessionRevision: Number(row.revision) + 1, createdAt: timestamp, requestHash });
    const result = await batch(db, [
      insertGuarded(db, `${rootId}/history/${operationId}`, keyHash, snapshot.draftName, event, timestamp, guards([row], keyHash)),
      updateGuarded(db, row, keyHash, snapshot.draftName, next, timestamp),
    ]);
    if (changed(result[1])) return sessionResponse({ ...row, blocks_json: serial(next), draft_name: snapshot.draftName, updated_at: timestamp, revision: Number(row.revision) + 1 });
  }
  fail(503, "Other changes are saving. Your writing will retry shortly.");
}
async function reviewSession(db, rootId, sessionId, keyHash) {
  const row = await activateWorkspace(db, rootId, keyHash);
  const sessionRow = await requireSession(db, rootId, sessionId, keyHash);
  const data = parse(sessionRow, "session");
  const main = mainProjection(row);
  const snapshot = inspect(data.update);
  return { main, session: sessionProjection(sessionRow, data), draft: { draftName: snapshot.draftName, blocks: snapshot.blocks, revision: Number(sessionRow.revision) }, ...changeSet(main, snapshot) };
}
async function promoteSession(db, rootId, sessionId, keyHash, payload) {
  const authorName = name(payload.authorName);
  const operationId = operation(payload.operationId);
  const mainRevision = payload.expectedMainRevision;
  const sessionRevision = payload.reviewedSessionRevision;
  if (!Number.isSafeInteger(mainRevision) || !Number.isSafeInteger(sessionRevision) || mainRevision < 1 || sessionRevision < 1) fail(400, "Review the current script and session before making it current.");
  const requestHash = await hash(JSON.stringify({ kind: "made_current", sessionId, authorName, mainRevision, sessionRevision }));
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const row = await activateWorkspace(db, rootId, keyHash);
    const sessionRow = await requireSession(db, rootId, sessionId, keyHash);
    const prior = await existingOperation(db, rootId, operationId, requestHash, keyHash);
    if (prior) return { main: mainProjection(row), session: sessionProjection(sessionRow), event: prior.event };
    const data = rootData(row);
    const session = parse(sessionRow, "session");
    if (data.mainRevision !== mainRevision || Number(sessionRow.revision) !== sessionRevision) fail(409, "The main script or session changed after your review. Review the latest comparison before making it current.");
    if (session.meta.status !== "active") fail(409, "This session was already made current. Start a new session to keep writing.");
    const snapshot = inspect(session.update);
    const timestamp = new Date().toISOString();
    const next = { ...data, update: updateMainDocument(data.update, snapshot), mainRevision: data.mainRevision + 1, mainUpdatedAt: timestamp, nextDraftNumber: Math.max(data.nextDraftNumber, draftNumber(snapshot.draftName) + 1) }; delete next.snapshot;
    const nextSession = { ...session, meta: { ...session.meta, status: "applied", appliedAt: timestamp, appliedBy: authorName, appliedMainRevision: next.mainRevision } };
    const event = historyData({ id: operationId, kind: "made_current", authorName, sessionId, snapshot, before: data.snapshot, mainRevision: next.mainRevision, sessionRevision: Number(sessionRow.revision) + 1, createdAt: timestamp, requestHash });
    const guard = guards([row, sessionRow], keyHash);
    const eventId = `${rootId}/history/${operationId}`;
    const gate = " AND EXISTS (SELECT 1 FROM screenplay_rooms WHERE room_id = ? AND key_hash = ? AND json_extract(blocks_json, '$.requestHash') = ?)";
    const result = await batch(db, [
      insertGuarded(db, eventId, keyHash, snapshot.draftName, event, timestamp, guard),
      updateGuarded(db, row, keyHash, snapshot.draftName, next, timestamp, gate, [eventId, keyHash, requestHash]),
      updateGuarded(db, sessionRow, keyHash, snapshot.draftName, nextSession, timestamp, gate, [eventId, keyHash, requestHash]),
    ]);
    if (changed(result[1]) && changed(result[2])) return { main: mainProjection({ ...row, blocks_json: serial(next), updated_at: timestamp, revision: Number(row.revision) + 1 }), session: sessionProjection({ ...sessionRow, blocks_json: serial(nextSession), updated_at: timestamp, revision: Number(sessionRow.revision) + 1 }), event: event.event };
  }
  fail(409, "The workspace changed after your review. Review the latest comparison before making it current.");
}

export async function handleWorkspaceRequest(request, env, rootId, path) {
  try {
    if (!env.DB) fail(503, "Room storage is unavailable.");
    const match = (request.headers.get("authorization") || "").match(/^Bearer\s+([a-f0-9]{16,128})$/i);
    if (!match) fail(401, "A valid room key is required.");
    const keyHash = await hash(match[1]);
    await env.DB.prepare(CREATE_TABLE).run();
    await requireRoot(env.DB, rootId, keyHash);
    const url = new URL(request.url);
    let payload;
    if (request.method === "POST") {
      const text = await request.text();
      if (text.length > 2100000) fail(413, "This request is too large.");
      try { payload = JSON.parse(text); } catch { fail(400, "The request could not be read."); }
      if (!payload || typeof payload !== "object") fail(400, "The request could not be read.");
    }
    if (path === "/workspace" && request.method === "GET") return json(await overview(env.DB, rootId, keyHash, url));
    if (path === "/sessions" && request.method === "POST") return json(await createSession(env.DB, rootId, keyHash, payload));
    if (path === "/history" && request.method === "GET") { await activateWorkspace(env.DB, rootId, keyHash); return json(await historyList(env.DB, rootId, keyHash, url)); }
    const historical = path.match(/^\/history\/([a-z0-9_-]{8,128})$/i);
    if (historical && request.method === "GET") {
      const row = await readRow(env.DB, `${rootId}/history/${historical[1]}`);
      if (!row || row.key_hash !== keyHash) fail(404, "That history entry could not be found.");
      return json(eventResponse(row));
    }
    const session = path.match(/^\/sessions\/([a-z0-9_-]{8,128})\/(sync|review|promote)$/i);
    if (session) {
      const [, id, action] = session;
      if (action === "sync" && request.method === "GET") return json(sessionResponse(await requireSession(env.DB, rootId, id, keyHash)));
      if (action === "sync" && request.method === "POST") return json(await saveSession(env.DB, rootId, id, keyHash, request, payload));
      if (action === "review" && request.method === "GET") return json(await reviewSession(env.DB, rootId, id, keyHash));
      if (action === "promote" && request.method === "POST") return json(await promoteSession(env.DB, rootId, id, keyHash, payload));
    }
    fail(405, "Method not allowed.");
  } catch (error) {
    return json({ error: error.status ? error.message : "The workspace could not save with its history. Please try again." }, error.status || 503);
  }
}
