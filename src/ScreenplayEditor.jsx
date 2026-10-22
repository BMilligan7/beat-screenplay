import { useImperativeHandle, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { MIME_TYPE, decodeClipboard, normalizeSelection, parsePlainText, replaceSelection, selectionBlocks, serializeClipboard } from "./editor-operations.js";

const pointSelection = (point) => ({ anchor: point, focus: point });
const isCollapsed = (range) => range.startIndex === range.endIndex && range.start.offset === range.end.offset;

// Browser selections may end on a page/row boundary rather than a text node.
function readPoint(root, node, offset) {
  if (!node || !root.contains(node)) return null;
  const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  const block = element.closest("[data-block-id]");
  if (block) {
    const range = document.createRange();
    range.selectNodeContents(block);
    range.setEnd(node, offset);
    return { id: block.dataset.blockId, offset: range.toString().length };
  }
  const boundary = document.createRange();
  boundary.setStart(node, offset);
  boundary.collapse(true);
  let previous = null;
  for (const candidate of root.querySelectorAll("[data-block-id]")) {
    const start = document.createRange();
    start.selectNodeContents(candidate);
    start.collapse(true);
    if (boundary.compareBoundaryPoints(Range.START_TO_START, start) <= 0) {
      return { id: candidate.dataset.blockId, offset: 0 };
    }
    previous = candidate;
  }
  return previous ? { id: previous.dataset.blockId, offset: previous.textContent.length } : null;
}

function readSelection(root) {
  const selection = window.getSelection();
  if (!root || !selection?.rangeCount) return null;
  const anchor = readPoint(root, selection.anchorNode, selection.anchorOffset);
  const focus = readPoint(root, selection.focusNode, selection.focusOffset);
  return anchor && focus ? { anchor, focus } : null;
}

function domPoint(root, point) {
  const block = root.querySelector(`[data-block-id="${CSS.escape(point.id)}"]`);
  if (!block) return null;
  let remaining = Math.max(0, point.offset);
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let text;
  while ((text = walker.nextNode())) {
    if (remaining <= text.length) return [text, remaining];
    remaining -= text.length;
  }
  return [block, block.childNodes.length];
}

function ScriptBlock({ block, index, selected, composing }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    if (composing.current) return;
    if (ref.current.textContent !== block.text) ref.current.textContent = block.text;
    // A blank element must still have a native caret position.
    if (!block.text && !ref.current.firstChild) ref.current.appendChild(document.createElement("br"));
  }, [block.text]);
  return <div className={`script-row row-${block.type} ${selected ? "selected" : ""}`}>
    <span className="line-number" contentEditable={false} aria-hidden="true">{index + 1}</span>
    <div ref={ref} className={`script-block type-${block.type}`} data-block-id={block.id} data-selected={selected ? "true" : "false"} aria-label={`${block.type} line ${index + 1}`} />
  </div>;
}

export function ScreenplayEditor({ ref, blocks, pages, hasTitlePage, selectedId, onSelect, onChange, onLayout, onUndo, onRedo, elementTypes, zoom, waiting, readOnly = false }) {
  const rootRef = useRef(null);
  const savedSelection = useRef(null);
  const pendingSelection = useRef(null);
  const composing = useRef(false);
  const compositionKey = useRef("");

  useLayoutEffect(() => {
    const root = rootRef.current;
    const measure = () => {
      if (composing.current) return;
      const page = root.querySelector(".screenplay-page");
      if (!page) return;
      const style = getComputedStyle(page);
      const pageHeight = parseFloat(style.minHeight);
      const bodyTop = parseFloat(style.getPropertyValue("--body-page-top"));
      const titleTop = parseFloat(style.getPropertyValue("--title-page-top"));
      const bottom = parseFloat(style.paddingBottom);
      const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const next = {
        bodyCapacity: Math.floor(pageHeight - bodyTop - bottom - border),
        titleCapacity: Math.floor(pageHeight - titleTop - bottom - border),
        heights: Object.fromEntries([...root.querySelectorAll(".script-row")].map((row) => [row.querySelector("[data-block-id]").dataset.blockId, Math.ceil(row.getBoundingClientRect().height / (zoom / 100))])),
      };
      onLayout((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const content of root.querySelectorAll(".screenplay-content")) observer.observe(content);
    document.fonts.addEventListener("loadingdone", measure);
    return () => { observer.disconnect(); document.fonts.removeEventListener("loadingdone", measure); };
  }, [blocks, pages, zoom, onLayout]);

  function currentSelection() {
    const live = readSelection(rootRef.current);
    if (live) savedSelection.current = live;
    const selection = live || savedSelection.current;
    if (normalizeSelection(blocks, selection)) return selection;
    const block = blocks.find((item) => item.id === selectedId) || blocks[0];
    return block ? pointSelection({ id: block.id, offset: 0 }) : null;
  }

  function restore(selection, focus = true) {
    const root = rootRef.current;
    if (!root || !selection) return;
    const anchor = domPoint(root, selection.anchor);
    const end = domPoint(root, selection.focus);
    if (!anchor || !end) return;
    if (focus) root.focus({ preventScroll: true });
    window.getSelection().setBaseAndExtent(...anchor, ...end);
    savedSelection.current = selection;
  }

  function commit(next, selection, options = {}) {
    pendingSelection.current = selection;
    onChange(next, options);
    onSelect(selection.focus.id);
    // No-op edits (e.g. typing the same selected text) still collapse the range.
    if (next === blocks || JSON.stringify(next) === JSON.stringify(blocks)) {
      pendingSelection.current = null;
      restore(selection);
    }
  }

  function replace(inserted, selection = currentSelection(), options) {
    const result = replaceSelection(blocks, selection, inserted);
    if (result.selection) commit(result.blocks, result.selection, options);
  }

  function format(type) {
    const selection = currentSelection();
    const range = normalizeSelection(blocks, selection);
    if (!range) return;
    const targets = new Set((isCollapsed(range) ? [blocks[range.startIndex]] : selectionBlocks(blocks, selection)).filter((block) => block.type !== "divider").map((block) => block.id));
    const uppercase = ["scene", "character", "transition", "title", "section"].includes(type);
    const next = blocks.map((block) => targets.has(block.id)
      ? { ...block, type, text: uppercase ? block.text.toUpperCase() : block.text } : block);
    commit(next, selection);
  }

  useImperativeHandle(ref, () => ({
    getSelection: currentSelection,
    restoreSelection: (selection) => { pendingSelection.current = selection; },
    focusBlock: (id) => { const selection = pointSelection({ id, offset: 0 }); savedSelection.current = selection; restore(selection); },
    format,
  }));

  useLayoutEffect(() => {
    if (composing.current) return;
    const pending = pendingSelection.current;
    pendingSelection.current = null;
    if (pending) restore(pending);
    else if (document.activeElement === rootRef.current && savedSelection.current) {
      // Pagination can move an element into a different page and remount it.
      const selection = normalizeSelection(blocks, savedSelection.current) ? savedSelection.current : currentSelection();
      restore(selection, false);
    }
  }, [blocks, pages]);

  useLayoutEffect(() => {
    const capture = () => {
      const selection = readSelection(rootRef.current);
      if (!selection) return;
      savedSelection.current = selection;
      onSelect(selection.focus.id);
    };
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, [onSelect]);

  function insertParagraph(lineBreak = false) {
    const selection = currentSelection();
    const range = normalizeSelection(blocks, selection);
    if (!range) return;
    if (lineBreak) { replace([{ type: blocks[range.startIndex].type, text: "\n" }], selection); return; }
    const removed = replaceSelection(blocks, selection, []);
    const point = removed.selection.focus;
    const index = removed.blocks.findIndex((block) => block.id === point.id);
    const block = removed.blocks[index];
    const nextType = ["character", "parenthetical"].includes(block.type) ? "dialogue"
      : ["scene", "transition", "divider"].includes(block.type) ? "action"
        : ["title", "section"].includes(block.type) ? "centered" : block.type;
    const next = { id: `block-${crypto.randomUUID()}`, type: nextType, text: block.text.slice(point.offset) };
    const updated = [...removed.blocks];
    updated.splice(index, 1, { ...block, text: block.text.slice(0, point.offset) }, next);
    commit(updated, pointSelection({ id: next.id, offset: 0 }));
  }

  function deleteText(event, selection) {
    let range = normalizeSelection(blocks, selection);
    if (!range) return;
    if (!isCollapsed(range)) { replace([], selection); return; }
    const backwards = event.inputType.endsWith("Backward");
    const block = blocks[range.startIndex];
    const offset = range.start.offset;
    if ((backwards && offset === 0) || (!backwards && offset === block.text.length)) {
      const adjacent = blocks[range.startIndex + (backwards ? -1 : 1)];
      if (adjacent?.type === "divider") commit(blocks.filter((item) => item.id !== adjacent.id), pointSelection(range.start));
      else if (adjacent) replace([], { anchor: range.start, focus: { id: adjacent.id, offset: backwards ? adjacent.text.length : 0 } });
      return;
    }
    const target = event.getTargetRanges?.()[0];
    if (target) {
      const anchor = readPoint(rootRef.current, target.startContainer, target.startOffset);
      const focus = readPoint(rootRef.current, target.endContainer, target.endOffset);
      const targetSelection = { anchor, focus };
      const targetRange = normalizeSelection(blocks, targetSelection);
      if (targetRange && !isCollapsed(targetRange)) { replace([], targetSelection, { historyKey: `typing:${block.id}` }); return; }
    }
    const segments = [...new Intl.Segmenter(undefined, { granularity: event.inputType.includes("Word") ? "word" : "grapheme" }).segment(block.text)];
    const boundary = backwards ? segments.filter((part) => part.index < offset).at(-1)?.index ?? 0
      : segments.find((part) => part.index + part.segment.length > offset)?.index + segments.find((part) => part.index + part.segment.length > offset)?.segment.length;
    replace([], { anchor: range.start, focus: { id: block.id, offset: boundary ?? block.text.length } }, { historyKey: `typing:${block.id}` });
  }

  // Use native beforeinput: React's synthetic event omits inputType/target ranges.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const beforeInput = (event) => {
      if (readOnly) { event.preventDefault(); return; }
      if (event.isComposing || composing.current) return;
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        if (event.inputType === "historyUndo") onUndo(); else onRedo();
        return;
      }
      const selection = currentSelection();
      const range = normalizeSelection(blocks, selection);
      if (!range) { event.preventDefault(); return; }
      if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
        event.preventDefault(); insertParagraph(event.inputType === "insertLineBreak");
      } else if (event.inputType.startsWith("delete")) {
        event.preventDefault(); deleteText(event, selection);
      } else if (event.inputType.startsWith("insert")) {
        event.preventDefault();
        if (event.data !== null) {
          const target = event.getTargetRanges?.()[0];
          const replacement = event.inputType === "insertReplacementText" && target
            ? { anchor: readPoint(root, target.startContainer, target.startOffset), focus: readPoint(root, target.endContainer, target.endOffset) } : selection;
          replace([{ type: blocks[range.startIndex].type, text: event.data }], replacement, { historyKey: isCollapsed(range) ? `typing:${range.start.id}` : "" });
        }
      } else event.preventDefault();
    };
    root.addEventListener("beforeinput", beforeInput);
    return () => root.removeEventListener("beforeinput", beforeInput);
  });

  function copy(event, cut = false) {
    const selection = currentSelection();
    const range = normalizeSelection(blocks, selection);
    if (!range || isCollapsed(range)) return;
    const data = serializeClipboard(blocks, selection);
    event.preventDefault();
    event.clipboardData.setData("text/plain", data.text);
    event.clipboardData.setData(MIME_TYPE, data.custom);
    if (cut && !readOnly) replace([], selection);
  }

  function paste(event) {
    event.preventDefault();
    if (readOnly) return;
    const selection = currentSelection();
    const range = normalizeSelection(blocks, selection);
    if (!range) return;
    const custom = decodeClipboard(event.clipboardData.getData(MIME_TYPE));
    const text = event.clipboardData.getData("text/plain");
    if (custom || text) replace(custom || parsePlainText(text, { type: blocks[range.startIndex].type }), selection);
  }

  function keyDown(event) {
    if (event.nativeEvent.isComposing || composing.current) return;
    const command = event.metaKey || event.ctrlKey;
    if (readOnly && !(command && event.key.toLowerCase() === "a")) return;
    if (command && ["z", "y"].includes(event.key.toLowerCase())) {
      event.preventDefault();
      if (event.key.toLowerCase() === "y" || event.shiftKey) onRedo(); else onUndo();
    } else if (command && event.key.toLowerCase() === "a") {
      event.preventDefault();
      const visible = blocks.filter((block) => block.type !== "divider");
      if (visible.length) restore({ anchor: { id: visible[0].id, offset: 0 }, focus: { id: visible.at(-1).id, offset: visible.at(-1).text.length } });
    } else if (event.key === "Tab") {
      event.preventDefault();
      const range = normalizeSelection(blocks, currentSelection());
      if (!range) return;
      const index = elementTypes.indexOf(blocks[range.startIndex].type);
      format(elementTypes[(index + (event.shiftKey ? -1 : 1) + elementTypes.length) % elementTypes.length]);
    } else if (event.key === "Enter") {
      event.preventDefault(); insertParagraph(event.shiftKey);
    }
  }

  function finishComposition() {
    composing.current = false;
    const selection = readSelection(rootRef.current);
    const next = blocks.map((block) => {
      const element = rootRef.current.querySelector(`[data-block-id="${CSS.escape(block.id)}"]`);
      return element ? { ...block, text: element.innerText.replace(/\n$/, element.textContent ? "\n" : "") } : block;
    });
    if (selection) commit(next, selection, { historyKey: compositionKey.current || `typing:${selection.focus.id}` });
    compositionKey.current = "";
  }

  return <div ref={rootRef} className="page-stage" style={{ "--page-zoom": zoom / 100 }} contentEditable={!readOnly} tabIndex={0} aria-readonly={readOnly} suppressContentEditableWarning spellCheck role="textbox" aria-label="Screenplay editor" aria-multiline="true"
    onCopy={copy} onCut={(event) => copy(event, true)} onPaste={paste} onKeyDown={keyDown}
    onDragStart={(event) => event.preventDefault()} onDrop={(event) => event.preventDefault()}
    onCompositionStart={() => {
      const selection = currentSelection();
      const range = normalizeSelection(blocks, selection);
      compositionKey.current = `composition:${crypto.randomUUID()}`;
      if (range && !isCollapsed(range)) flushSync(() => replace([], selection, { historyKey: compositionKey.current }));
      composing.current = true;
    }} onCompositionEnd={finishComposition}
    onInput={() => { if (!composing.current) finishComposition(); }}>
    {pages.map((page, pageIndex) => <article className={`screenplay-page ${hasTitlePage && pageIndex === 0 ? "title-page" : ""}`} aria-label={`Screenplay editor page ${pageIndex + 1}`} key={`page-${pageIndex}`}>
      {!(hasTitlePage && pageIndex === 0) && <span className="page-number" contentEditable={false} aria-hidden="true">{hasTitlePage ? pageIndex : pageIndex + 1}.</span>}
      <div className="screenplay-content">
        {page.map(({ block, index }) => <ScriptBlock block={block} index={index} selected={selectedId === block.id} composing={composing} key={block.id} />)}
        {!blocks.length && waiting && <div className="room-waiting" contentEditable={false}><strong>Loading your saved script…</strong><span>Your shared script loads from its saved copy. The room owner does not need to be online.</span></div>}
      </div>
    </article>)}
  </div>;
}
