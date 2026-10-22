// All scripts, names, room identifiers, and keys below are fictional test fixtures.
import assert from "node:assert/strict";
import test from "node:test";
import { paginateEditorBlocks } from "../src/editor-pagination.js";

const block = (id, type = "action") => ({ id, type, text: `${id} text` });
const layout = (blocks, heights, capacity = 100) => ({ heights: Object.fromEntries(blocks.map((item, i) => [item.id, heights[i]])), bodyCapacity: capacity, titleCapacity: capacity });

test("fills pages using measured row heights instead of estimated text length", () => {
  const blocks = Array.from({ length: 11 }, (_, i) => block(`b${i}`));
  const pages = paginateEditorBlocks(blocks, layout(blocks, blocks.map(() => 20)));
  assert.deepEqual(pages.map((page) => page.length), [5, 5, 1]);
  assert.deepEqual(pages.flat().map((row) => row.block), blocks);
});

test("keeps a character, parenthetical, and dialogue together across page boundaries", () => {
  const blocks = [block("a"), block("c", "character"), block("p", "parenthetical"), block("d", "dialogue"), block("end")];
  const pages = paginateEditorBlocks(blocks, layout(blocks, [65, 10, 10, 20, 30]));
  assert.deepEqual(pages.map((page) => page.map(({ block }) => block.id)), [["a"], ["c", "p", "d", "end"]]);
});

test("keeps a scene heading with its opening paragraph", () => {
  const blocks = [block("a"), block("scene", "scene"), block("next")];
  const pages = paginateEditorBlocks(blocks, layout(blocks, [70, 20, 20]));
  assert.deepEqual(pages.map((page) => page.length), [1, 2]);
});

test("keeps a scene heading with an opening character and dialogue", () => {
  const blocks = [block("a"), block("scene", "scene"), block("c", "character"), block("d", "dialogue")];
  const pages = paginateEditorBlocks(blocks, layout(blocks, [70, 15, 10, 20]));
  assert.deepEqual(pages.map((page) => page.map(({ block }) => block.id)), [["a"], ["scene", "c", "d"]]);
});

test("respects title pages and dividers without skipping or inventing line numbers", () => {
  const blocks = [block("title", "title"), block("credit", "centered"), block("break1", "divider"), block("break2", "divider"), block("scene", "scene"), block("a"), block("trailing", "divider")];
  const pages = paginateEditorBlocks(blocks, layout(blocks, blocks.map(() => 20)));
  assert.deepEqual(pages.map((page) => page.map(({ block }) => block.id)), [["title", "credit"], ["scene", "a"]]);
  assert.deepEqual(pages.flat().map(({ index }) => index + 1), [1, 2, 3, 4]);
});

test("reflows after text wrapping changes without losing text or creating empty pages", () => {
  const blocks = [block("a"), block("b"), block("c")];
  assert.equal(paginateEditorBlocks(blocks, layout(blocks, [30, 30, 30])).length, 1);
  const pages = paginateEditorBlocks(blocks, layout(blocks, [30, 150, 30]));
  assert.deepEqual(pages.map((page) => page.length), [1, 1, 1]);
  assert.deepEqual(pages.flat().map((row) => row.block), blocks);
  assert.deepEqual(paginateEditorBlocks([]), [[]]);
});
