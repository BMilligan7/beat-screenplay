import * as Y from "yjs";
import { applyRoomUpdate, encodeRoomUpdate, readRoomDocument, seedRoomDocument } from "../shared/room-document.js";
import { handleProjects } from "./projects.js";
import { handleWorkspaceRequest } from "./workspace.js";

const ROOM_TABLE_SQL = `CREATE TABLE IF NOT EXISTS screenplay_rooms (
  room_id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  draft_name TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL
)`;
const ROOM_SELECT_SQL = "SELECT key_hash, draft_name, blocks_json, updated_at, revision FROM screenplay_rooms WHERE room_id = ?";
const ROOM_UPDATE_SQL = `UPDATE screenplay_rooms SET draft_name = ?, blocks_json = ?, updated_at = ?, revision = revision + 1
  WHERE room_id = ? AND key_hash = ? AND revision = ?`;
const ROOM_INSERT_SQL = `INSERT INTO screenplay_rooms (room_id, key_hash, draft_name, blocks_json, updated_at, revision)
  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(room_id) DO NOTHING`;
const ROOM_TYPES = new Set(["scene", "action", "character", "dialogue", "parenthetical", "transition", "title", "centered", "section", "divider"]);
const MAX_UPDATE_LENGTH = 2000000;
const MAX_STORED_LENGTH = 1800000;
const MAX_WRITE_ATTEMPTS = 8;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function secretHash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function roomSecret(request) {
  const match = (request.headers.get("authorization") || "").match(/^Bearer\s+([a-f0-9]{16,128})$/i);
  return match?.[1] || "";
}

function validName(name) {
  return typeof name === "string" && name.trim().length > 0 && name.length <= 120;
}

function validBlocks(blocks) {
  if (!Array.isArray(blocks) || !blocks.length || blocks.length > 2000) return false;
  const ids = new Set();
  return blocks.every((block) => {
    if (!block || typeof block.id !== "string" || !block.id || block.id.length > 200 || ids.has(block.id) || !ROOM_TYPES.has(block.type) || typeof block.text !== "string" || block.text.length > 50000) return false;
    ids.add(block.id);
    return true;
  });
}

function validDocument(snapshot) {
  return validName(snapshot.draftName) && validBlocks(snapshot.blocks) && Array.isArray(snapshot.drafts) && snapshot.drafts.length <= 50 && snapshot.drafts.every((draft) => typeof draft.id === "string" && draft.id.length > 0 && draft.id.length <= 200 && validName(draft.name) && validBlocks(draft.blocks));
}

function decodeStoredRoom(row) {
  const doc = new Y.Doc();
  try {
    const stored = JSON.parse(row.blocks_json);
    const legacy = Array.isArray(stored);
    if (legacy) seedRoomDocument(doc, { draftName: row.draft_name, blocks: stored });
    else if ([2, 3].includes(stored?.format)) applyRoomUpdate(doc, stored.update, "stored-room");
    else throw new Error("Unrecognized room document");
    const snapshot = readRoomDocument(doc);
    if (!validDocument(snapshot)) throw new Error("Invalid stored room document");
    return { doc, snapshot, legacy };
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

function encodedStorage(doc) {
  const update = encodeRoomUpdate(doc);
  return { update, stored: JSON.stringify({ format: 2, update }) };
}

function projectedResponse(roomId, row, snapshot, update) {
  const stored = row.blocks_json ? JSON.parse(row.blocks_json) : null;
  return json({ roomId, ...snapshot, ...(update ? { update } : {}), updatedAt: stored?.mainUpdatedAt ?? row.updated_at, revision: stored?.mainRevision ?? Number(row.revision) });
}

async function readBody(request) {
  if (Number(request.headers.get("content-length")) > MAX_UPDATE_LENGTH + 10000) return null;
  const text = await request.text();
  if (text.length > MAX_UPDATE_LENGTH + 10000) return null;
  try { return JSON.parse(text); } catch { return null; }
}

async function roomResponse(request, env, roomId, sync) {
  if (!env.DB) return json({ error: "Room storage is unavailable" }, 503);
  const secret = roomSecret(request);
  if (!secret) return json({ error: "A valid room key is required" }, 401);
  const allowed = sync ? ["GET", "POST"] : ["GET", "PUT"];
  if (!allowed.includes(request.method)) return json({ error: "Method not allowed" }, 405);
  await env.DB.prepare(ROOM_TABLE_SQL).run();
  const keyHash = await secretHash(secret);
  let payload;
  if (request.method !== "GET") {
    payload = await readBody(request);
    if (sync && (typeof payload?.update !== "string" || !payload.update.length || payload.update.length > MAX_UPDATE_LENGTH)) return json({ error: "The room update is invalid or too large" }, 400);
  }

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const row = await env.DB.prepare(ROOM_SELECT_SQL).bind(roomId).first();
    if (row && row.key_hash !== keyHash) return json({ error: "The room key does not match" }, 403);
    if (!row && request.method === "GET") return json({ error: "Room not found" }, 404);
    // Old open tabs must reload before writing: their full snapshots omit the
    // shared edit identities and can otherwise roll back both text and draft name.
    if (row && request.method === "PUT") return json({ error: "Refresh Beat to save safely. This room now updates automatically." }, 428);

    const decoded = row ? decodeStoredRoom(row) : { doc: new Y.Doc(), legacy: false };
    const { doc, legacy } = decoded;
    try {
      if (request.method === "GET" && (!sync || !legacy)) {
        return projectedResponse(roomId, row, decoded.snapshot, sync ? encodeRoomUpdate(doc) : undefined);
      }

      // Commit a legacy room's canonical Yjs identities once before considering
      // any incoming edits. Competing readers reuse the winner after the CAS.
      if (legacy) {
        const { stored } = encodedStorage(doc);
        const changed = await env.DB.prepare(ROOM_UPDATE_SQL).bind(decoded.snapshot.draftName, stored, row.updated_at, roomId, keyHash, Number(row.revision)).run();
        if (Number(changed.meta?.changes) === 1) {
          if (request.method === "GET") return projectedResponse(roomId, { ...row, revision: Number(row.revision) + 1 }, decoded.snapshot, encodeRoomUpdate(doc));
        }
        continue;
      }

      const before = row ? encodeRoomUpdate(doc) : "";
      try {
        if (sync) applyRoomUpdate(doc, payload.update, "client-update");
        else {
          const draftName = typeof payload?.draftName === "string" ? payload.draftName.trim() : "Current draft";
          if (!validName(draftName) || !validBlocks(payload?.blocks)) return json({ error: "The screenplay snapshot is invalid" }, 400);
          seedRoomDocument(doc, { draftName, blocks: payload.blocks });
        }
      } catch {
        return json({ error: "The room update could not be read" }, 400);
      }
      let snapshot;
      try { snapshot = readRoomDocument(doc); } catch { return json({ error: "The room update contains invalid screenplay data" }, 400); }
      if (!validDocument(snapshot)) return json({ error: "The room update contains invalid screenplay data" }, 400);
      const { update, stored } = encodedStorage(doc);
      if (stored.length > MAX_STORED_LENGTH) return json({ error: "This room has reached its saved history limit. Download a backup before reducing saved drafts." }, 413);
      if (row && before === update) return projectedResponse(roomId, row, snapshot, sync ? update : undefined);
      if (row && JSON.parse(row.blocks_json)?.format === 3) return json({ error: "The current script is read-only. Refresh Beat and start a writing session to make changes." }, 428);

      const updatedAt = new Date().toISOString();
      const revision = row ? Number(row.revision) + 1 : 1;
      const changed = row
        ? await env.DB.prepare(ROOM_UPDATE_SQL).bind(snapshot.draftName, stored, updatedAt, roomId, keyHash, Number(row.revision)).run()
        : await env.DB.prepare(ROOM_INSERT_SQL).bind(roomId, keyHash, snapshot.draftName, stored, updatedAt, revision).run();
      if (Number(changed.meta?.changes) === 1) {
        return projectedResponse(roomId, { updated_at: updatedAt, revision }, snapshot, sync ? update : undefined);
      }
      // A concurrent writer won. Reload its document and merge the same update;
      // Yjs applies each edit once, including after a lost network response.
    } finally {
      doc.destroy();
    }
  }
  return json({ error: "Other writers are saving. Your changes will retry shortly." }, 503);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/projects" || url.pathname.startsWith("/api/projects/")) return handleProjects(request, env);
    const workspaceMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9_-]{8,128})(\/(?:workspace|sessions|history)(?:\/.*)?)$/i);
    if (workspaceMatch) return handleWorkspaceRequest(request, env, workspaceMatch[1], workspaceMatch[2]);
    const roomMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9_-]{8,128})(\/sync)?$/i);
    if (roomMatch) {
      try { return await roomResponse(request, env, roomMatch[1], !!roomMatch[2]); }
      catch { return json({ error: "Room storage is temporarily unavailable. Your saved screenplay is unchanged." }, 503); }
    }

    const response = await env.ASSETS.fetch(request);
    const acceptsHtml = request.headers.get("accept")?.includes("text/html");
    if (response.status !== 404 || !acceptsHtml || !["GET", "HEAD"].includes(request.method)) return response;
    const indexUrl = new URL(request.url);
    indexUrl.pathname = "/index.html";
    indexUrl.search = "";
    return env.ASSETS.fetch(new Request(indexUrl, request));
  },
};
