import { applyRoomUpdate, encodeRoomUpdate, readRoomDocument, seedRoomDocument } from "../shared/room-document.js";
import { createOperationId as newOperationId } from "./workspace-api.js";

const REMOTE_ORIGIN = "room-server-sync";

function snapshotSignature(snapshot) {
  const blocks = (items = []) => items.map(({ id, type, text }) => [id, type, text]);
  const drafts = (snapshot.drafts || []).map((draft) => [draft.id, draft.name, blocks(draft.blocks)])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return JSON.stringify([snapshot.draftName, blocks(snapshot.blocks), drafts]);
}

/** Keeps a room's Yjs document current through the saved room, without a peer connection. */
export function createRoomSync({
  doc,
  roomConfig,
  endpoint = `/api/rooms/${encodeURIComponent(roomConfig.roomId)}/sync`,
  headers = {},
  sessionToken,
  readOnly = false,
  createOperationId = newOperationId,
  initialSnapshot = {},
  onStatus = () => {},
  onReady = () => {},
  fetchImpl = fetch,
  debounceMs = 700,
  pollMs = 3000,
  retryMs = 3000,
  requestTimeoutMs = 15000,
  timers = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (timer) => clearTimeout(timer),
  },
}) {
  let started = false;
  let stopped = false;
  let initialized = false;
  let localVersion = 0;
  let savedVersion = 0;
  let initialPush = false;
  let pendingPull = false;
  let inFlight = null;
  let controller = null;
  let cancelRequest = null;
  let requestTimer = null;
  let debounceTimer = null;
  let pollTimer = null;
  let retryTimer = null;
  let remoteInfo = {};
  let lastStatus = "";
  let pendingOperation = null;
  let serverReadOnly = false;
  let refreshBeforeSave = false;
  const canWrite = () => !readOnly && !serverReadOnly;

  function status(value, error) {
    if (stopped) return;
    const info = { ...remoteInfo, ...(error ? { error: error.message, statusCode: error.status, payload: error.payload } : {}) };
    const signature = JSON.stringify([value, info.revision, info.updatedAt, info.session, info.hasUnpublishedChanges, info.error, info.statusCode]);
    if (signature === lastStatus) return;
    lastStatus = signature;
    onStatus(value, info);
  }

  function clearTimer(name) {
    if (name === "debounce") {
      if (debounceTimer !== null) timers.clearTimeout(debounceTimer);
      debounceTimer = null;
    } else if (name === "poll") {
      if (pollTimer !== null) timers.clearTimeout(pollTimer);
      pollTimer = null;
    } else if (name === "request") {
      if (requestTimer !== null) timers.clearTimeout(requestTimer);
      requestTimer = null;
    } else {
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function remember(payload) {
    if (payload) {
      remoteInfo = { revision: payload.revision, updatedAt: payload.updatedAt, ...(payload.session ? { session: payload.session } : {}) };
      if (payload.session?.status === "applied") {
        serverReadOnly = true;
        // A session can be made current while this device still has unsaved
        // edits, including edits recovered from its local document cache.
        remoteInfo.hasUnpublishedChanges = snapshotSignature(readRoomDocument(doc)) !== snapshotSignature(payload);
      }
    }
  }

  async function request(method, update) {
    if (method === "POST" && pendingOperation?.update !== update) {
      pendingOperation = { update, operationId: createOperationId() };
    }
    const activeController = new AbortController();
    controller = activeController;
    const deadline = new Promise((_, reject) => {
      cancelRequest = () => {
        const error = new Error("Room sync stopped");
        error.name = "AbortError";
        reject(error);
        activeController.abort();
      };
      requestTimer = timers.setTimeout(() => {
        const error = new Error("Saving took too long. Retrying the connection.");
        error.offline = true;
        reject(error);
        activeController.abort();
      }, requestTimeoutMs);
    });
    const exchange = async () => {
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method,
          headers: {
            ...headers,
            authorization: `Bearer ${roomConfig.key}`,
            ...(method === "POST" ? { "content-type": "application/json" } : {}),
            ...(sessionToken ? { "X-Beat-Session-Token": sessionToken } : {}),
          },
          cache: "no-store",
          signal: activeController.signal,
          ...(method === "POST" ? { body: JSON.stringify({ update, operationId: pendingOperation.operationId }) } : {}),
        });
      } catch (error) {
        error.offline = true;
        throw error;
      }
      if (method === "GET" && response.status === 404) return null;
      const payload = await response.json();
      if (!response.ok) {
        const error = new Error(payload?.error || `Room sync failed (${response.status})`);
        error.status = response.status;
        error.payload = payload;
        error.offline = response.status >= 500;
        throw error;
      }
      if (typeof payload.update !== "string") throw new Error("The saved room returned an invalid document");
      return payload;
    };
    try {
      // Include the response body in the deadline: headers can arrive while a
      // disconnected response stream never finishes. Race also settles adapters
      // that do not reject their promise when their abort signal fires.
      return await Promise.race([exchange(), deadline]);
    } finally {
      clearTimer("request");
      cancelRequest = null;
      controller = null;
    }
  }

  function schedulePoll() {
    if (stopped || !initialized || pollTimer !== null || retryTimer !== null) return;
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      pendingPull = true;
      void run();
    }, pollMs);
  }

  function scheduleRetry() {
    clearTimer("poll");
    if (stopped || retryTimer !== null) return;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      pendingPull = true;
      void run();
    }, retryMs);
  }

  async function drain() {
    try {
      if (!initialized) {
        status("loading");
        const saved = await request("GET");
        if (stopped) return;
        if (saved) {
          applyRoomUpdate(doc, saved.update, REMOTE_ORIGIN);
          remember(saved);
        } else if (readOnly) {
          const error = new Error("The shared script is still saving. Retrying…");
          error.offline = true;
          throw error;
        } else if (!readRoomDocument(doc).blocks.length) {
          const snapshot = typeof initialSnapshot === "function" ? initialSnapshot() : initialSnapshot;
          if (!snapshot?.blocks?.length) {
            const error = new Error("The shared script is still saving. Retrying…");
            error.offline = true;
            throw error;
          }
          seedRoomDocument(doc, snapshot, REMOTE_ORIGIN);
        }
        initialized = true;
        pendingPull = false;
        // The cached document can contain deletions as well as new structs. Sending
        // the merged state once preserves both; a server no-op leaves its revision alone.
        initialPush = canWrite();
        onReady({ ...readRoomDocument(doc), ...remoteInfo });
      }

      while (!stopped) {
        if (refreshBeforeSave) {
          const saved = await request("GET");
          if (stopped) return;
          if (!saved) throw new Error("The shared room could not be found");
          applyRoomUpdate(doc, saved.update, REMOTE_ORIGIN);
          remember(saved);
          refreshBeforeSave = false;
          pendingPull = false;
          continue;
        }
        if (canWrite() && (initialPush || localVersion > savedVersion)) {
          clearTimer("debounce");
          status("saving");
          const sentVersion = localVersion;
          const saved = await request("POST", encodeRoomUpdate(doc));
          if (stopped) return;
          applyRoomUpdate(doc, saved.update, REMOTE_ORIGIN);
          remember(saved);
          pendingOperation = null;
          savedVersion = sentVersion;
          initialPush = false;
          pendingPull = false;
          continue;
        }
        if (pendingPull) {
          pendingPull = false;
          const saved = await request("GET");
          if (stopped) return;
          if (!saved) throw new Error("The shared room could not be found");
          applyRoomUpdate(doc, saved.update, REMOTE_ORIGIN);
          remember(saved);
          continue;
        }
        break;
      }
      clearTimer("retry");
      status("saved");
    } catch (error) {
      if (!stopped) {
        if (error.status === 409) refreshBeforeSave = true;
        status(error.offline ? "offline" : "error", error);
        scheduleRetry();
      }
    }
  }

  function run() {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = drain().finally(() => {
      inFlight = null;
      controller = null;
      schedulePoll();
    });
    return inFlight;
  }

  function changed(_update, origin) {
    if (stopped || !canWrite() || origin === REMOTE_ORIGIN) return;
    localVersion += 1;
    if (!initialized) return;
    status("saving");
    clearTimer("debounce");
    debounceTimer = timers.setTimeout(() => {
      debounceTimer = null;
      void run();
    }, debounceMs);
  }

  function start() {
    if (stopped) return Promise.resolve();
    if (!started) {
      started = true;
      if (!readOnly) doc.on("update", changed);
    }
    return run();
  }

  return {
    start,
    hasPendingChanges: () => canWrite() && (initialPush || localVersion > savedVersion),
    flush() {
      if (!started) return start();
      clearTimer("debounce");
      clearTimer("retry");
      pendingPull = true;
      return run();
    },
    stop() {
      stopped = true;
      doc.off("update", changed);
      clearTimer("debounce");
      clearTimer("poll");
      clearTimer("retry");
      clearTimer("request");
      cancelRequest?.();
      controller?.abort();
    },
  };
}
