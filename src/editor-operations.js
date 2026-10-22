// Document operations are independent of the DOM so a browser selection can span
// screenplay elements without giving up their individual formats.
export const MIME_TYPE = "application/x-beat-screenplay+json";

const TYPES = new Set(["scene", "action", "character", "dialogue", "parenthetical", "transition", "title", "centered", "section", "divider"]);
const SCENE = /^(?:INT\.?|EXT\.?|INT\/EXT\.?|EXT\/INT\.?|I\/E\.?|EST\.?)\s/i;
const TRANSITION = /^(?:FADE (?:IN|OUT)(?: TO BLACK)?|CUT TO|DISSOLVE TO|SMASH CUT TO|MATCH CUT TO|WIPE TO):?$/i;
let nextId = 0;

function freshId() {
  return `edit-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${++nextId}`}`;
}

function validType(type) {
  return TYPES.has(type) ? type : "action";
}

function point(block, offset) {
  return { id: block.id, offset: Math.max(0, Math.min(block.text.length, Number.isFinite(offset) ? Math.trunc(offset) : 0)) };
}

function collapsed(point) {
  return { anchor: { ...point }, focus: { ...point } };
}

export function normalizeSelection(blocks, selection) {
  if (!selection?.anchor || !selection?.focus) return null;
  const anchorIndex = blocks.findIndex((block) => block.id === selection.anchor.id);
  const focusIndex = blocks.findIndex((block) => block.id === selection.focus.id);
  if (anchorIndex < 0 || focusIndex < 0) return null;
  const anchor = point(blocks[anchorIndex], selection.anchor.offset);
  const focus = point(blocks[focusIndex], selection.focus.offset);
  const forward = anchorIndex < focusIndex || (anchorIndex === focusIndex && anchor.offset <= focus.offset);
  return forward
    ? { start: anchor, end: focus, startIndex: anchorIndex, endIndex: focusIndex }
    : { start: focus, end: anchor, startIndex: focusIndex, endIndex: anchorIndex };
}

function isCollapsed(range) {
  return range.startIndex === range.endIndex && range.start.offset === range.end.offset;
}

function clippedBlocks(blocks, range) {
  return blocks.slice(range.startIndex, range.endIndex + 1).map((block, index, selected) => ({
    ...block,
    text: block.text.slice(index === 0 ? range.start.offset : 0, index === selected.length - 1 ? range.end.offset : block.text.length),
  }));
}

// These are the elements whose text is selected, suitable for applying a format.
// In particular, ending at the beginning of an element does not format it.
export function selectionBlocks(blocks, selection) {
  const range = normalizeSelection(blocks, selection);
  if (!range || isCollapsed(range)) return [];
  return clippedBlocks(blocks, range).filter((block, index, selected) => {
    if (index === selected.length - 1 && range.end.offset === 0) return false;
    if (index === 0 && range.start.offset === blocks[range.startIndex].text.length && blocks[range.startIndex].text.length > 0) return false;
    return true;
  });
}

/**
 * Replace a range with typed elements. A surviving prefix keeps its format;
 * subsequent inserted elements keep theirs. The surviving suffix joins the last
 * inserted element, just as when pasting paragraphs into a text editor. IDs on
 * untouched elements and surviving edges remain stable. The caret lands before
 * the suffix, so the next keystroke follows the pasted text.
 */
export function replaceSelection(blocks, selection, insertedBlocks = []) {
  const range = normalizeSelection(blocks, selection);
  if (!range) {
    if (blocks.length) return { blocks, selection: null };
    const result = insertedBlocks.map((block) => ({ id: freshId(), type: validType(block.type), text: String(block.text ?? "") }));
    if (!result.length) result.push({ id: freshId(), type: "action", text: "" });
    return { blocks: result, selection: collapsed(point(result.at(-1), result.at(-1).text.length)) };
  }
  if (isCollapsed(range) && !insertedBlocks.length) return { blocks, selection: collapsed(range.start) };

  const first = blocks[range.startIndex];
  const last = blocks[range.endIndex];
  const prefix = first.text.slice(0, range.start.offset);
  const suffix = last.text.slice(range.end.offset);
  const before = blocks.slice(0, range.startIndex);
  const after = blocks.slice(range.endIndex + 1);
  let replacements;
  let caret;

  if (insertedBlocks.length) {
    replacements = insertedBlocks.map((block) => ({ id: freshId(), type: validType(block.type), text: String(block.text ?? "") }));
    if (prefix) {
      replacements[0] = { ...replacements[0], id: first.id, type: first.type, text: prefix + replacements[0].text };
    } else if (isCollapsed(range) && !first.text) {
      replacements[0].id = first.id;
    }
    const tail = replacements.at(-1);
    caret = { id: tail.id, offset: tail.text.length };
    if (suffix) {
      // Do not duplicate the retained start ID when both edges came from one element.
      if ((!prefix || replacements.length > 1) && !replacements.some((block) => block !== tail && block.id === last.id)) tail.id = last.id;
      tail.text += suffix;
      caret.id = tail.id;
    }
  } else {
    const survivor = prefix || !suffix ? first : last;
    replacements = [{ ...survivor, text: prefix + suffix }];
    caret = { id: survivor.id, offset: prefix.length };
  }

  return { blocks: [...before, ...replacements, ...after], selection: collapsed(caret) };
}

export function serializeClipboard(blocks, selection) {
  const range = normalizeSelection(blocks, selection);
  if (!range || isCollapsed(range)) return { text: "", custom: "" };
  // Keep empty edges here: selecting a paragraph boundary really copies a newline.
  const selected = clippedBlocks(blocks, range).map(({ type, text }) => ({ type: validType(type), text }));
  return {
    text: selected.map((block) => block.text).join("\n"),
    custom: JSON.stringify({ version: 1, blocks: selected }),
  };
}

export function decodeClipboard(custom) {
  if (typeof custom !== "string" || !custom) return null;
  try {
    const payload = JSON.parse(custom);
    if (payload?.version !== 1 || !Array.isArray(payload.blocks) || !payload.blocks.length) return null;
    if (!payload.blocks.every((block) => block && TYPES.has(block.type) && typeof block.text === "string")) return null;
    // IDs and any other supplied fields are deliberately discarded.
    return payload.blocks.map(({ type, text }) => ({ type, text }));
  } catch {
    return null;
  }
}

function isCharacter(text) {
  const cue = text.replace(/\s*\((?:V\.O\.|O\.S\.|O\.C\.|CONT['’]?D|FILTERED)\)\s*$/i, "");
  return cue.length > 0 && cue.length <= 36 && cue.split(/\s+/).length <= 3 && cue === cue.toUpperCase() && /^[A-ZÀ-ÖØ-Ý][A-ZÀ-ÖØ-Ý0-9 .''’\-]*$/.test(cue) && !/[.!?:]$/.test(cue);
}

// Unlike file import, paste never invents a title page, drops blank/numeric lines,
// or rewrites punctuation. A single line keeps the destination's current format.
export function parsePlainText(raw, { type = "action" } = {}) {
  const text = String(raw ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const initialType = validType(type);
  if (lines.length === 1) return [{ type: initialType, text }];
  const nextNonempty = new Array(lines.length);
  let following = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    nextNonempty[index] = following;
    if (lines[index].trim()) following = lines[index].trim();
  }
  let previous = initialType;
  return lines.map((line, index) => {
    const semantic = line.trim();
    const next = nextNonempty[index];
    let inferred = "action";
    if (!semantic) {
      if (!["character", "parenthetical"].includes(previous)) previous = "action";
      return { type: "action", text: line };
    }
    if (SCENE.test(semantic)) inferred = "scene";
    else if (TRANSITION.test(semantic)) inferred = "transition";
    else if (/^\(.+\)$/.test(semantic) && ["character", "parenthetical", "dialogue"].includes(previous)) inferred = "parenthetical";
    else if (isCharacter(semantic) && next && !SCENE.test(next) && !TRANSITION.test(next) && !isCharacter(next)) inferred = "character";
    else if (["character", "parenthetical", "dialogue"].includes(previous)) inferred = "dialogue";
    else if (index === 0) inferred = initialType;
    previous = inferred;
    return { type: inferred, text: line };
  });
}
