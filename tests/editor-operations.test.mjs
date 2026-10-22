// All scripts, names, room identifiers, and keys below are fictional test fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { MIME_TYPE, normalizeSelection, selectionBlocks, replaceSelection, serializeClipboard, decodeClipboard, parsePlainText } from "../src/editor-operations.js";

const block = (id, type, text) => ({ id, type, text });
const select = (first, start, last = first, end = start) => ({ anchor: { id: first, offset: start }, focus: { id: last, offset: end } });
const draft = () => [block("scene", "scene", "INT. ROOM — DAY"), block("name", "character", "TEST"), block("speech", "dialogue", "Hello there."), block("action", "action", "She leaves.")];

test("normalizes backward selection and clamps stale text offsets", () => {
  assert.deepEqual(normalizeSelection(draft(), select("speech", 999, "name", -2)), {
    start: { id: "name", offset: 0 }, end: { id: "speech", offset: 12 }, startIndex: 1, endIndex: 2,
  });
  assert.equal(normalizeSelection(draft(), select("missing", 0)), null);
});

test("format selection clips partial edges and leaves an end-at-zero element alone", () => {
  assert.deepEqual(selectionBlocks(draft(), select("name", 2, "action", 0)), [block("name", "character", "ST"), block("speech", "dialogue", "Hello there.")]);
  assert.deepEqual(selectionBlocks(draft(), select("name", 4, "speech", 5)), [block("speech", "dialogue", "Hello")]);
  assert.deepEqual(selectionBlocks(draft(), select("name", 2)), []);
});

test("replaces partial selection across formats, preserving surrounding text and caret", () => {
  const source = draft();
  const original = structuredClone(source);
  const result = replaceSelection(source, select("speech", 6, "action", 3), [block("copied", "dialogue", "again"), block("copied2", "action", "He")]);
  assert.deepEqual(result.blocks.slice(0, 2), source.slice(0, 2));
  assert.deepEqual(result.blocks.slice(2), [block("speech", "dialogue", "Hello again"), block("action", "action", "He leaves.")]);
  assert.deepEqual(result.selection, select("action", 2));
  assert.deepEqual(source, original, "operation must not mutate source blocks");
});

test("single-line replacement merges both surviving edges and positions caret before tail", () => {
  const result = replaceSelection(draft(), select("speech", 6, "action", 3), [{ type: "action", text: "friend" }]);
  assert.equal(result.blocks.at(-1).text, "Hello friend leaves.");
  assert.equal(result.blocks.at(-1).id, "speech");
  assert.equal(result.blocks.at(-1).type, "dialogue");
  assert.equal(result.selection.focus.offset, 12);
  assert.equal(result.selection.focus.id, result.blocks.at(-1).id);
});

test("full passage paste preserves all source formats and assigns fresh IDs", () => {
  const inserted = [block("name", "character", "ROBOT"), block("speech", "dialogue", "Wait."), block("action", "action", "He follows.")];
  const result = replaceSelection(draft(), select("name", 0, "action", 11), inserted);
  assert.deepEqual(result.blocks.slice(1).map(({ type, text }) => ({ type, text })), inserted.map(({ type, text }) => ({ type, text })));
  assert.ok(result.blocks.slice(1).every(({ id }) => !inserted.some((item) => item.id === id)));
  assert.equal(new Set(result.blocks.map(({ id }) => id)).size, result.blocks.length);
  assert.deepEqual(result.selection, select(result.blocks.at(-1).id, 11));
});

test("deleting a multi-element range joins surviving text and preserves external IDs", () => {
  const source = draft();
  const result = replaceSelection(source, select("name", 2, "speech", 6), []);
  assert.deepEqual(result.blocks, [source[0], block("name", "character", "TEthere."), source[3]]);
  assert.deepEqual(result.selection, select("name", 2));
});

test("select-all deletion leaves one editable empty element", () => {
  const result = replaceSelection(draft(), select("scene", 0, "action", 11), []);
  assert.equal(result.blocks.length, 1);
  assert.equal(result.blocks[0].text, "");
  assert.deepEqual(result.selection, select(result.blocks[0].id, 0));
  const empty = replaceSelection([], null, []);
  assert.equal(empty.blocks.length, 1);
  assert.equal(empty.blocks[0].type, "action");
});

test("collapsed deletion is a no-op and invalid stale selection cannot edit a document", () => {
  const source = draft();
  const result = replaceSelection(source, select("speech", 6), []);
  assert.equal(result.blocks, source);
  assert.deepEqual(result.selection, select("speech", 6));
  assert.deepEqual(replaceSelection(source, select("missing", 0), [{ type: "action", text: "oops" }]), { blocks: source, selection: null });
});

test("paragraph split keeps distinct IDs and puts suffix after caret in new format", () => {
  const result = replaceSelection(draft(), select("speech", 6), [{ type: "dialogue", text: "" }, { type: "action", text: "" }]);
  assert.equal(result.blocks[2].id, "speech");
  assert.equal(result.blocks[2].text, "Hello ");
  assert.equal(result.blocks[3].type, "action");
  assert.equal(result.blocks[3].text, "there.");
  assert.notEqual(result.blocks[3].id, "speech");
  assert.deepEqual(result.selection, select(result.blocks[3].id, 0));
});

test("clipboard round-trips every format, blank line, divider, and exact punctuation", () => {
  const types = ["title", "centered", "section", "divider", "scene", "action", "character", "parenthetical", "dialogue", "transition"];
  const source = types.map((type, i) => block(`b${i}`, type, type === "divider" ? "" : `  ${type}  — ..`));
  const copied = serializeClipboard(source, select(source[0].id, 0, source.at(-1).id, source.at(-1).text.length));
  assert.equal(MIME_TYPE, "application/x-beat-screenplay+json");
  assert.equal(copied.text, source.map(({ text }) => text).join("\n"));
  assert.deepEqual(decodeClipboard(copied.custom), source.map(({ type, text }) => ({ type, text })));
});

test("copy preserves a selected paragraph boundary even when format excludes the endpoint", () => {
  const source = draft();
  const copied = serializeClipboard(source, select("name", 4, "speech", 0));
  assert.equal(copied.text, "\n");
  assert.deepEqual(decodeClipboard(copied.custom), [{ type: "character", text: "" }, { type: "dialogue", text: "" }]);
});

test("clipboard decoder rejects malformed envelopes and unsafe values", () => {
  for (const input of ["", "{", "null", "[]", '{"version":2,"blocks":[]}', '{"version":1,"blocks":[]}', '{"version":1,"blocks":[{"type":"script","text":"hi"}]}', '{"version":1,"blocks":[{"type":"action","text":17}]}']) {
    assert.equal(decodeClipboard(input), null);
  }
  assert.deepEqual(decodeClipboard('{"version":1,"blocks":[{"id":"duplicate","type":"action","text":"safe","onclick":"bad"}]}'), [{ type: "action", text: "safe" }]);
});

test("plain multiline paste preserves exact content, blanks, numbers, and trailing newline", () => {
  const text = "Some action  ..\r\n\r\n123\r\nINT. ROOM - DAY\r\n";
  const parsed = parsePlainText(text);
  assert.deepEqual(parsed.map(({ text }) => text), ["Some action  ..", "", "123", "INT. ROOM - DAY", ""]);
  assert.deepEqual(parsed.map(({ type }) => type), ["action", "action", "action", "scene", "action"]);
});

test("plain screenplay passage recognizes speech and resets after a blank line", () => {
  const parsed = parsePlainText("TEST\n(softly)\nHello.\nStill here.\n\nShe leaves.\nCUT TO:\nINT. HALL - NIGHT");
  assert.deepEqual(parsed.map(({ type }) => type), ["character", "parenthetical", "dialogue", "dialogue", "action", "action", "transition", "scene"]);
});

test("blank-separated speaker and delivery notes still precede dialogue", () => {
  const parsed = parsePlainText("TEST\n\n(softly)\n\nHello.\n\nShe leaves.");
  assert.deepEqual(parsed.map(({ type }) => type), ["character", "action", "parenthetical", "action", "dialogue", "action", "action"]);
  assert.equal(parsed.map(({ text }) => text).join("\n"), "TEST\n\n(softly)\n\nHello.\n\nShe leaves.");
});

test("single-line paste uses active format and supports inserting before trailing text", () => {
  const parsed = parsePlainText("New words", { type: "dialogue" });
  assert.deepEqual(parsed, [{ type: "dialogue", text: "New words" }]);
  const result = replaceSelection(draft(), select("speech", 0), parsed);
  assert.equal(result.blocks[2].text, "New wordsHello there.");
  assert.deepEqual(result.selection, select("speech", 9));
});
