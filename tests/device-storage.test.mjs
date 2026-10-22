// All scripts, names, room identifiers, and keys below are fictional test fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import * as Y from "yjs";
import { createDeviceCache, getDeviceItem, setDeviceItem } from "../src/device-storage.js";

function clock() {
  let now = 0;
  let nextId = 0;
  const jobs = new Map();
  return {
    timers: {
      setTimeout(callback, delay) { const id = ++nextId; jobs.set(id, { at: now + delay, callback }); return id; },
      clearTimeout(id) { jobs.delete(id); },
    },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, job] of [...jobs]) {
        if (job.at <= now && jobs.delete(id)) job.callback();
      }
    },
    get pending() { return jobs.size; },
  };
}

function probe({ stores = ["updates", "custom"] } = {}) {
  const names = new Set(stores);
  const request = {};
  const database = {
    objectStoreNames: { contains: (name) => names.has(name) },
    createObjectStore: (name) => names.add(name),
    closed: 0,
    close() { this.closed += 1; },
  };
  return {
    request,
    database,
    indexedDB: { open: () => request },
    succeed() { request.onsuccess({ target: { result: database } }); },
    upgrade() { request.onupgradeneeded({ target: { result: database } }); },
  };
}

test("importing the helper does not read browser storage globals", async (t) => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let reads = 0;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { reads += 1; throw new Error("Storage blocked"); } });
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, "localStorage", prior);
    else delete globalThis.localStorage;
  });
  const imported = await import(`../src/device-storage.js?without-storage=${Date.now()}`);
  assert.equal(reads, 0);
  assert.equal(imported.getDeviceItem("script"), null);
  assert.equal(imported.setDeviceItem("script", "test"), false);
  assert.equal(reads, 2);
});

test("guarded storage reads and writes tolerate unavailable storage and quota errors", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  assert.equal(getDeviceItem("room", storage), null);
  assert.equal(setDeviceItem("room", "saved-room", storage), true);
  assert.equal(getDeviceItem("room", storage), "saved-room");
  assert.equal(getDeviceItem("room", { getItem() { throw new Error("Blocked"); } }), null);
  assert.equal(setDeviceItem("room", "saved-room", { setItem() { throw new Error("Quota exceeded"); } }), false);
  assert.equal(getDeviceItem("room", null), null);
  assert.equal(setDeviceItem("room", "saved-room", null), false);
});

test("unavailable or synchronously denied IndexedDB never constructs the cache library", async () => {
  for (const getIndexedDB of [() => undefined, () => { throw new Error("Denied getter"); }, () => ({ open() { throw new Error("Denied open"); } })]) {
    let constructed = false;
    const time = clock();
    const cache = createDeviceCache("room", {}, { getIndexedDB, timers: time.timers, createPersistence() { constructed = true; } });
    assert.deepEqual(await cache.ready, { status: "unavailable" });
    assert.equal(constructed, false);
    assert.equal(time.pending, 0);
    await cache.destroy();
  }
});

test("failed or blocked open requests release readiness without invoking IndexeddbPersistence", async () => {
  for (const event of ["onerror", "onblocked"]) {
    const browser = probe();
    let constructed = false;
    const cache = createDeviceCache("room", {}, { getIndexedDB: () => browser.indexedDB, createPersistence() { constructed = true; } });
    browser.request[event]({ preventDefault() {} });
    assert.deepEqual(await cache.ready, { status: "unavailable" });
    assert.equal(constructed, false);
    await cache.destroy();
  }
});

test("a silent open request times out within 1500ms and late cached updates still merge", async () => {
  const browser = probe();
  const time = clock();
  const doc = new Y.Doc();
  let finishSync;
  let receivedDoc;
  const binding = { whenSynced: new Promise((resolve) => { finishSync = resolve; }), destroy() {} };
  const cache = createDeviceCache("room", doc, {
    getIndexedDB: () => browser.indexedDB,
    timers: time.timers,
    createPersistence(_name, target) { receivedDoc = target; return binding; },
  });
  let ready = false;
  cache.ready.then(() => { ready = true; });
  time.advance(1499);
  await Promise.resolve();
  assert.equal(ready, false);
  time.advance(1);
  assert.deepEqual(await cache.ready, { status: "timeout" });
  doc.getMap("screenplay").set("server", "Fresh server content");
  browser.succeed();
  await Promise.resolve();
  assert.equal(receivedDoc, doc);
  const cached = new Y.Doc();
  cached.getMap("screenplay").set("offline", "An unsent local edit");
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(cached), binding);
  finishSync();
  await Promise.resolve();
  assert.deepEqual(doc.getMap("screenplay").toJSON(), { server: "Fresh server content", offline: "An unsent local edit" });
  await cache.destroy();
  doc.destroy(); cached.destroy();
});

test("a fresh database gets the existing cache schema and resolves when loaded", async () => {
  const browser = probe({ stores: [] });
  const time = clock();
  let destroyed = 0;
  const binding = { whenSynced: Promise.resolve(), destroy() { destroyed += 1; } };
  const cache = createDeviceCache("room", {}, { getIndexedDB: () => browser.indexedDB, timers: time.timers, createPersistence: () => binding });
  browser.upgrade();
  browser.succeed();
  assert.deepEqual(await cache.ready, { status: "ready" });
  assert.equal(browser.database.closed, 1);
  assert.equal(time.pending, 0);
  await cache.destroy();
  await cache.destroy();
  assert.equal(destroyed, 1);
});

test("a broken cache schema is ignored instead of blocking the server", async () => {
  const browser = probe({ stores: [] });
  let constructed = false;
  const cache = createDeviceCache("room", {}, { getIndexedDB: () => browser.indexedDB, createPersistence() { constructed = true; } });
  browser.succeed();
  assert.deepEqual(await cache.ready, { status: "unavailable" });
  assert.equal(constructed, false);
  assert.equal(browser.database.closed, 1);
  await cache.destroy();
});

test("constructor failures, load rejection, and reachable open rejection settle safely", async () => {
  for (const factory of [
    () => { throw new Error("Constructor unavailable"); },
    () => Promise.reject(new Error("Import unavailable")),
    () => ({ whenSynced: Promise.reject(new Error("Read unavailable")), destroy() {} }),
    () => ({ _db: Promise.reject(new Error("Open unavailable")), whenSynced: new Promise(() => {}), destroy() {} }),
  ]) {
    const browser = probe();
    const cache = createDeviceCache("room", {}, { getIndexedDB: () => browser.indexedDB, createPersistence: factory });
    browser.succeed();
    assert.deepEqual(await cache.ready, { status: "unavailable" });
    await cache.destroy();
  }
});

test("closing during an open prevents a late cache from attaching", async () => {
  const browser = probe();
  let constructed = false;
  const cache = createDeviceCache("room", {}, { getIndexedDB: () => browser.indexedDB, createPersistence() { constructed = true; } });
  await cache.destroy();
  assert.deepEqual(await cache.ready, { status: "closed" });
  browser.succeed();
  assert.equal(constructed, false);
  assert.equal(browser.database.closed, 1);
});

test("cleanup remains safe when library destroy throws or waits forever", async () => {
  for (const destroy of [() => { throw new Error("No database"); }, () => Promise.reject(new Error("Close failed")), () => new Promise(() => {})]) {
    const browser = probe();
    const cache = createDeviceCache("room", {}, {
      getIndexedDB: () => browser.indexedDB,
      createPersistence: () => ({ whenSynced: Promise.resolve(), destroy }),
    });
    browser.succeed();
    assert.deepEqual(await cache.ready, { status: "ready" });
    await cache.destroy();
  }
});
