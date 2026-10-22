export class WorkspaceApiError extends Error {
  constructor(message, { status = 0, payload = null, offline = false, cause } = {}) {
    super(message, { cause });
    this.name = "WorkspaceApiError";
    this.status = status;
    this.payload = payload;
    this.code = payload?.code;
    this.offline = offline;
  }
}

export function createOperationId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === "function") return cryptoImpl.randomUUID();
  return secureToken(16, cryptoImpl);
}

function secureToken(length = 32, cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.getRandomValues !== "function") throw new Error("Secure draft storage is unavailable in this browser");
  return Array.from(cryptoImpl.getRandomValues(new Uint8Array(length)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function browserStorage() {
  try { return globalThis.localStorage || null; }
  catch { return null; }
}

/** Authenticated workspace requests and durable retry identities for deliberate writes. */
export function createWorkspaceApi({
  roomConfig,
  fetchImpl = fetch,
  storage = browserStorage(),
  cryptoImpl = globalThis.crypto,
  requestTimeoutMs = 15000,
  timers = {
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: (timer) => clearTimeout(timer),
  },
}) {
  const base = `/api/rooms/${encodeURIComponent(roomConfig.roomId)}`;
  const storagePrefix = `beat-workspace-v1:${roomConfig.roomId}:`;

  function readStored(key, fallback) {
    if (!storage) throw new Error("Allow browser storage to keep access to your draft before starting it");
    const value = storage.getItem(storagePrefix + key);
    if (value === null) return fallback;
    try { return JSON.parse(value); }
    catch { throw new Error("Saved draft access could not be read. Keep this browser's saved data intact."); }
  }

  function writeStored(key, value) {
    if (!storage) throw new Error("Allow browser storage to keep access to your draft before starting it");
    storage.setItem(storagePrefix + key, JSON.stringify(value));
  }

  function removeStored(key) {
    storage.removeItem(storagePrefix + key);
  }

  function getSessionToken(sessionId) {
    try {
      const sessions = readStored("sessions", {});
      return Object.hasOwn(sessions, sessionId) ? sessions[sessionId]?.sessionToken || null : null;
    } catch { return null; }
  }

  async function request(path, { method = "GET", body, sessionToken, signal } = {}) {
    const controller = new AbortController();
    let timer;
    let abort;
    const deadline = new Promise((_, reject) => {
      abort = () => {
        const error = new Error("The request was cancelled");
        error.name = "AbortError";
        reject(error);
        controller.abort();
      };
      timer = timers.setTimeout(() => {
        reject(new WorkspaceApiError("The connection took too long. Please retry.", { offline: true }));
        controller.abort();
      }, requestTimeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    const exchange = async () => {
      let response;
      try {
        response = await fetchImpl(base + path, {
          method,
          headers: {
            authorization: `Bearer ${roomConfig.key}`,
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...(sessionToken ? { "X-Beat-Session-Token": sessionToken } : {}),
          },
          cache: "no-store",
          signal: controller.signal,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (cause) {
        throw new WorkspaceApiError("The workspace could not connect. Please retry.", { offline: true, cause });
      }
      let payload;
      try { payload = await response.json(); }
      catch (cause) {
        throw new WorkspaceApiError(`The workspace returned an unreadable response (${response.status})`, { status: response.status, offline: response.status >= 500, cause });
      }
      if (!response.ok) {
        const message = typeof payload?.error === "string" ? payload.error : payload?.error?.message || payload?.message;
        throw new WorkspaceApiError(message || `Workspace request failed (${response.status})`, { status: response.status, payload, offline: response.status >= 500 });
      }
      return payload;
    };
    try { return await Promise.race([exchange(), deadline]); }
    finally {
      timers.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  function prepareIntent(key, body, withToken = false) {
    const existing = readStored(key, null);
    const signature = JSON.stringify(body);
    if (existing) {
      if (existing.signature !== signature) throw new Error("A previous draft request is still pending. Retry that request before starting another.");
      return existing;
    }
    const intent = {
      signature,
      body: { ...body, operationId: createOperationId(cryptoImpl), ...(withToken ? { sessionToken: secureToken(32, cryptoImpl) } : {}) },
    };
    // This must succeed before sending the write. A lost response can then be
    // retried after a reload with the same identity and draft access token.
    writeStored(key, intent);
    return intent;
  }

  function clearRejectedIntent(key, error) {
    if (error instanceof WorkspaceApiError && [400, 401, 403, 404, 409, 413, 422, 428].includes(error.status)) removeStored(key);
  }

  return {
    request,
    getWorkspace: (options) => request("/workspace", options),
    getSessionToken,
    listLocalSessions: () => {
      try { return Object.keys(readStored("sessions", {})); }
      catch { return []; }
    },
    sessionEndpoint: (sessionId) => `${base}/sessions/${encodeURIComponent(sessionId)}/sync`,
    async createSession({ authorName, source } = {}) {
      const key = "pending-session";
      const intent = prepareIntent(key, { authorName, ...(source ? { source } : {}) }, true);
      try {
        const payload = await request("/sessions", { method: "POST", body: intent.body });
        if (!payload?.session?.id) throw new Error("The new draft did not return its saved identity. Retry to recover it.");
        const sessions = readStored("sessions", {});
        writeStored("sessions", { ...sessions, [payload.session.id]: { sessionToken: intent.body.sessionToken, authorName } });
        removeStored(key);
        return { ...payload, sessionToken: intent.body.sessionToken };
      } catch (error) {
        clearRejectedIntent(key, error);
        throw error;
      }
    },
    getReview: (sessionId, options = {}) => request(`/sessions/${encodeURIComponent(sessionId)}/review`, { ...options, sessionToken: getSessionToken(sessionId) }),
    async promoteSession(sessionId, { expectedMainRevision, reviewedSessionRevision, authorName } = {}) {
      const key = `pending-promotion:${sessionId}`;
      const intent = prepareIntent(key, { expectedMainRevision, reviewedSessionRevision, authorName });
      try {
        const payload = await request(`/sessions/${encodeURIComponent(sessionId)}/promote`, {
          method: "POST", body: intent.body, sessionToken: getSessionToken(sessionId),
        });
        removeStored(key);
        return payload;
      } catch (error) {
        clearRejectedIntent(key, error);
        throw error;
      }
    },
    getHistory({ limit = 20, cursor, signal } = {}) {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set("cursor", cursor);
      return request(`/history?${params}`, { signal });
    },
    getHistoryEvent: (historyId, options) => request(`/history/${encodeURIComponent(historyId)}`, options),
  };
}
