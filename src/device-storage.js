export function getDeviceItem(key, storage) {
  try {
    return (storage === undefined ? globalThis.localStorage : storage)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function setDeviceItem(key, value, storage) {
  try {
    const target = storage === undefined ? globalThis.localStorage : storage;
    if (!target) return false;
    target.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

async function defaultPersistenceFactory(documentId, doc) {
  const { IndexeddbPersistence } = await import("y-indexeddb");
  return new IndexeddbPersistence(documentId, doc);
}

/** Device caching may finish late, but it must never prevent opening a saved room. */
export function createDeviceCache(documentId, doc, {
  getIndexedDB = () => globalThis.indexedDB,
  createPersistence = defaultPersistenceFactory,
  timeoutMs = 1500,
  timers = { setTimeout: (...args) => setTimeout(...args), clearTimeout: (timer) => clearTimeout(timer) },
} = {}) {
  let closed = false;
  let settled = false;
  let persistence = null;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const timer = timers.setTimeout(() => finish("timeout"), Math.min(1500, Math.max(0, timeoutMs)));

  function finish(status) {
    if (settled) return;
    settled = true;
    timers.clearTimeout(timer);
    resolveReady({ status });
  }

  function destroyPersistence(value) {
    try {
      // The library detaches listeners immediately but may await an open request
      // before closing. Do not let that pending request block component cleanup.
      void Promise.resolve(value?.destroy()).catch(() => {});
    } catch { /* Server synchronization remains independent of device storage. */ }
  }

  async function startPersistence() {
    try {
      const value = await createPersistence(documentId, doc);
      if (closed) { destroyPersistence(value); return; }
      persistence = value;
      if (!value?.whenSynced) { finish("unavailable"); return; }
      // whenSynced itself never rejects in y-indexeddb. Observe its opening
      // promise too so a reachable open failure releases this readiness gate.
      if (value._db?.catch) void value._db.catch(() => finish("unavailable"));
      void Promise.resolve(value.whenSynced).then(() => finish("ready"), () => finish("unavailable"));
    } catch {
      finish("unavailable");
    }
  }

  try {
    const indexedDB = getIndexedDB();
    if (!indexedDB?.open) {
      finish("unavailable");
    } else {
      // y-indexeddb has no public failure hook and does not catch its initial
      // open failure. Probe first so denied/blocked storage never constructs it.
      const request = indexedDB.open(documentId);
      request.onerror = (event) => { event?.preventDefault?.(); finish("unavailable"); };
      request.onblocked = () => finish("unavailable");
      request.onupgradeneeded = (event) => {
        try {
          const database = event.target.result;
          if (!database.objectStoreNames.contains("updates")) database.createObjectStore("updates", { autoIncrement: true });
          if (!database.objectStoreNames.contains("custom")) database.createObjectStore("custom");
        } catch {
          try { request.transaction?.abort(); } catch { /* The open error will settle the probe. */ }
          finish("unavailable");
        }
      };
      request.onsuccess = (event) => {
        const database = event.target.result;
        let compatible = false;
        try {
          compatible = database.objectStoreNames.contains("updates") && database.objectStoreNames.contains("custom");
        } catch { /* An incomplete cache must not stop the saved room loading. */ }
        try { database.close(); } catch { /* Continue without relying on this handle. */ }
        if (closed) return;
        if (!compatible) { finish("unavailable"); return; }
        void startPersistence();
      };
    }
  } catch {
    finish("unavailable");
  }

  return {
    ready,
    async destroy() {
      if (closed) return;
      closed = true;
      finish("closed");
      destroyPersistence(persistence);
      persistence = null;
    },
  };
}
