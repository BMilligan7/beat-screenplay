import * as Y from "yjs";

export function encodeRoomUpdate(doc, stateVector) {
  const bytes = Y.encodeStateAsUpdate(doc, stateVector);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  }
  return btoa(binary);
}

export function applyRoomUpdate(doc, encoded, origin) {
  if (typeof encoded !== "string" || !encoded.length || encoded.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error("Invalid room update encoding");
  }
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  Y.applyUpdate(doc, bytes, origin);
}

export function readRoomDocument(doc) {
  const blocks = Array.from(doc.getMap("screenplay"), ([id, block]) => {
    if (!(block instanceof Y.Map) || !(block.get("text") instanceof Y.Text)) throw new Error("Invalid screenplay element");
    const order = block.get("order");
    if (typeof order !== "number" || !Number.isFinite(order)) throw new Error("Invalid screenplay order");
    return { id, type: block.get("type"), text: block.get("text").toString(), order };
  }).sort((left, right) => left.order - right.order || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map(({ order, ...block }) => block);
  const drafts = Array.from(doc.getMap("drafts"), ([id, draft]) => {
    if (!draft || typeof draft !== "object" || draft.id !== id) throw new Error("Invalid saved draft");
    return draft;
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return { draftName: doc.getMap("metadata").get("draftName") ?? "Current draft", blocks, drafts };
}

// Seeding is reserved for a genuinely new room or the server's one-time migration.
// Existing clients must apply its update to retain the shared Yjs item identities.
export function seedRoomDocument(doc, { draftName = "Current draft", blocks = [], drafts = [] }, origin = "room-seed") {
  const root = doc.getMap("screenplay");
  const metadata = doc.getMap("metadata");
  const archive = doc.getMap("drafts");
  if (root.size || metadata.size || archive.size) throw new Error("Cannot reseed an existing room document");
  doc.transact(() => {
    metadata.set("draftName", draftName);
    blocks.forEach((block, order) => {
      const shared = new Y.Map();
      shared.set("type", block.type);
      shared.set("order", order);
      shared.set("text", new Y.Text(block.text));
      root.set(block.id, shared);
    });
    drafts.forEach((draft) => archive.set(draft.id, { id: draft.id, name: draft.name, blocks: draft.blocks.map((block) => ({ ...block })) }));
  }, origin);
}
