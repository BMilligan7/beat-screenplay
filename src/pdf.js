const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const BODY_TOP = 720;
const TITLE_TOP = 610;
const PAGE_BOTTOM = 72;
const LINE_HEIGHT_MULTIPLIER = 1.16;

const WIN_1252 = new Map([
  ["\u20ac", 128], ["\u201a", 130], ["\u0192", 131], ["\u201e", 132], ["\u2026", 133],
  ["\u2020", 134], ["\u2021", 135], ["\u02c6", 136], ["\u2030", 137], ["\u0160", 138],
  ["\u2039", 139], ["\u0152", 140], ["\u017d", 142], ["\u2018", 145], ["\u2019", 146],
  ["\u201c", 147], ["\u201d", 148], ["\u2022", 149], ["\u2013", 150], ["\u2014", 151],
  ["\u02dc", 152], ["\u2122", 153], ["\u0161", 154], ["\u203a", 155], ["\u0153", 156],
  ["\u017e", 158], ["\u0178", 159],
]);

function pdfByte(character) {
  const code = character.codePointAt(0);
  if (code === 160) return 32;
  if (WIN_1252.has(character)) return WIN_1252.get(character);
  return code <= 255 ? code : 63;
}

function pdfString(value) {
  let escaped = "";
  for (const character of String(value)) {
    const byte = pdfByte(character);
    if (byte === 40 || byte === 41 || byte === 92) escaped += `\\${String.fromCharCode(byte)}`;
    else if (byte < 32 || byte > 126) escaped += `\\${byte.toString(8).padStart(3, "0")}`;
    else escaped += String.fromCharCode(byte);
  }
  return escaped;
}

function wrapText(text, limit) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (!normalized) return [""];
  const words = normalized.split(" ");
  const lines = [];
  let line = "";
  words.forEach((word) => {
    if (word.length > limit) {
      if (line) { lines.push(line); line = ""; }
      for (let offset = 0; offset < word.length; offset += limit) lines.push(word.slice(offset, offset + limit));
      return;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= limit) line = candidate;
    else { lines.push(line); line = word; }
  });
  if (line) lines.push(line);
  return lines;
}

function centeredX(text, size) {
  return Math.max(54, (PAGE_WIDTH - text.length * size * 0.6) / 2);
}

function textCommand(text, x, y, { font = "F1", size = 12 } = {}) {
  return `BT /${font} ${size} Tf 1 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)} Tm (${pdfString(text)}) Tj ET`;
}

function blockStyle(type, titlePage) {
  if (titlePage) {
    if (type === "title") return { font: "F2", size: 24, limit: 34, centered: true, after: 28 };
    if (type === "section") return { font: "F2", size: 12, limit: 52, centered: true, before: 14, after: 9 };
    return { font: "F1", size: 11, limit: 66, centered: true, after: 10 };
  }
  const styles = {
    scene: { x: 72, font: "F2", size: 12, limit: 62, before: 12, after: 9 },
    action: { x: 72, font: "F1", size: 12, limit: 62, after: 9 },
    character: { x: 252, font: "F2", size: 12, limit: 28, before: 5, after: 0 },
    dialogue: { x: 180, font: "F1", size: 12, limit: 38, after: 9 },
    parenthetical: { x: 216, font: "F1", size: 12, limit: 32, after: 0 },
    transition: { x: 414, font: "F2", size: 12, limit: 24, before: 6, after: 9 },
    title: { font: "F2", size: 18, limit: 42, centered: true, after: 12 },
    centered: { font: "F1", size: 12, limit: 58, centered: true, after: 9 },
    section: { x: 72, font: "F2", size: 12, limit: 62, before: 6, after: 9 },
  };
  return styles[type] || styles.action;
}

function entryHeight(entry, titlePage) {
  const block = entry.block || entry;
  const style = blockStyle(block.type, titlePage);
  const lines = entry.lines || wrapText(block.text, style.limit);
  const before = entry.before ?? style.before ?? 0;
  const after = entry.after ?? style.after ?? 0;
  return before + lines.length * style.size * LINE_HEIGHT_MULTIPLIER + after;
}

function blockRecord(entry, index) {
  const block = entry?.block || entry;
  if (!block) return null;
  return { block, sourceIndex: entry?.sourceIndex ?? entry?.index ?? index };
}

function blockLayout(record, titlePage = false) {
  const style = blockStyle(record.block.type, titlePage);
  return {
    style,
    lines: wrapText(record.block.text, style.limit),
    lineHeight: style.size * LINE_HEIGHT_MULTIPLIER,
  };
}

function nextContentIndex(records, index) {
  for (let next = index + 1; next < records.length; next += 1) {
    if (records[next].block.type !== "divider") return next;
    break;
  }
  return -1;
}

function keptLineCount(lines) {
  return lines.length <= 4 ? lines.length : Math.min(2, lines.length);
}

function minimumSpeechHeight(records, characterIndex) {
  let height = 0;
  let index = characterIndex + 1;
  while (records[index]?.block.type === "parenthetical") {
    const layout = blockLayout(records[index]);
    height += (layout.style.before || 0) + layout.lines.length * layout.lineHeight + (layout.style.after || 0);
    index += 1;
  }
  if (records[index]?.block.type === "dialogue") {
    const layout = blockLayout(records[index]);
    const lines = keptLineCount(layout.lines);
    height += (layout.style.before || 0) + lines * layout.lineHeight;
    if (lines === layout.lines.length) height += layout.style.after || 0;
  }
  return height;
}

function minimumKeepHeight(records, index, pageIsEmpty) {
  const record = records[index];
  const layout = blockLayout(record);
  let height = (pageIsEmpty ? 0 : layout.style.before || 0)
    + layout.lines.length * layout.lineHeight
    + (layout.style.after || 0);

  if (record.block.type === "character") return height + minimumSpeechHeight(records, index);
  if (record.block.type !== "scene") return height;

  const nextIndex = nextContentIndex(records, index);
  if (nextIndex < 0) return height;
  const next = records[nextIndex];
  const nextLayout = blockLayout(next);
  if (next.block.type === "action") {
    const lines = keptLineCount(nextLayout.lines);
    height += (nextLayout.style.before || 0) + lines * nextLayout.lineHeight;
    if (lines === nextLayout.lines.length) height += nextLayout.style.after || 0;
  } else if (next.block.type === "character") {
    height += (nextLayout.style.before || 0)
      + nextLayout.lines.length * nextLayout.lineHeight
      + (nextLayout.style.after || 0)
      + minimumSpeechHeight(records, nextIndex);
  }
  return height;
}

function followsKeptBlock(records, index) {
  const current = records[index]?.block.type;
  const previous = records[index - 1]?.block.type;
  return (current === "action" && previous === "scene")
    || (current === "parenthetical" && (previous === "character" || previous === "parenthetical"))
    || (current === "dialogue" && (previous === "character" || previous === "parenthetical"));
}

function paginateBody(records) {
  const capacity = BODY_TOP - PAGE_BOTTOM;
  const pages = [[]];
  let used = 0;

  const currentPage = () => pages[pages.length - 1];
  const startPage = () => {
    if (!currentPage().length) return;
    pages.push([]);
    used = 0;
  };
  const addEntry = (entry) => {
    currentPage().push(entry);
    used += entryHeight(entry, false);
  };

  records.forEach((record, index) => {
    if (record.block.type === "divider") {
      startPage();
      return;
    }

    const pageIsEmpty = currentPage().length === 0;
    const beginsKeptSequence = record.block.type === "scene" || record.block.type === "character";
    if (beginsKeptSequence) {
      const keepHeight = minimumKeepHeight(records, index, pageIsEmpty);
      if (!pageIsEmpty && keepHeight <= capacity && used + keepHeight > capacity) startPage();
    }

    const layout = blockLayout(record);
    let remainingLines = [...layout.lines];
    let firstFragment = true;

    while (remainingLines.length) {
      const empty = currentPage().length === 0;
      const before = empty || !firstFragment ? 0 : layout.style.before || 0;
      const after = layout.style.after || 0;
      const available = capacity - used;
      const fullHeight = before + remainingLines.length * layout.lineHeight + after;

      if (fullHeight <= available) {
        addEntry({ block: record.block, index: record.sourceIndex, sourceIndex: record.sourceIndex, lines: remainingLines, before, after });
        remainingLines = [];
        continue;
      }

      const textHeight = before + remainingLines.length * layout.lineHeight;
      if (textHeight <= available) {
        addEntry({ block: record.block, index: record.sourceIndex, sourceIndex: record.sourceIndex, lines: remainingLines, before, after: 0 });
        remainingLines = [];
        continue;
      }

      const linkedToPrevious = firstFragment && followsKeptBlock(records, index);
      const maxLines = Math.floor((available - before + 0.001) / layout.lineHeight);
      const fullBlockFitsFresh = remainingLines.length * layout.lineHeight + after <= capacity;
      if (!empty && (!linkedToPrevious || maxLines < Math.min(2, remainingLines.length)) && fullBlockFitsFresh) {
        startPage();
        continue;
      }
      if (maxLines < 1) {
        startPage();
        continue;
      }

      let take = Math.min(maxLines, remainingLines.length);
      if (remainingLines.length - take === 1 && take > 2) take -= 1;
      const fragment = remainingLines.slice(0, take);
      remainingLines = remainingLines.slice(take);
      addEntry({ block: record.block, index: record.sourceIndex, sourceIndex: record.sourceIndex, lines: fragment, before, after: remainingLines.length ? 0 : after });
      firstFragment = false;
      if (remainingLines.length) startPage();
    }
  });

  return pages.filter((page) => page.length);
}

export function paginateScreenplayForPdf(blocks) {
  const records = blocks.map(blockRecord).filter(Boolean);
  const firstContent = records.findIndex((record) => record.block.type !== "divider");
  if (firstContent < 0) return { pages: [[]], hasTitlePage: false };

  const hasTitlePage = records[firstContent].block.type === "title";
  const pages = [];
  let bodyStart = firstContent;

  if (hasTitlePage) {
    const divider = records.findIndex((record, index) => index > firstContent && record.block.type === "divider");
    const firstScene = records.findIndex((record, index) => index > firstContent && record.block.type === "scene");
    const boundaries = [divider, firstScene].filter((index) => index >= 0);
    const boundary = boundaries.length ? Math.min(...boundaries) : records.length;
    const titleEntries = records.slice(firstContent, boundary)
      .filter((record) => record.block.type !== "divider")
      .map((record, index) => {
        const layout = blockLayout(record, true);
        return {
          block: record.block,
          index: record.sourceIndex,
          sourceIndex: record.sourceIndex,
          lines: layout.lines,
          before: index === 0 ? 0 : layout.style.before || 0,
          after: layout.style.after || 0,
        };
      });
    if (titleEntries.length) pages.push(titleEntries);
    bodyStart = boundary;
    while (records[bodyStart]?.block.type === "divider") bodyStart += 1;
  }

  const bodyPages = paginateBody(records.slice(bodyStart));
  pages.push(...bodyPages);
  return { pages: pages.length ? pages : [[]], hasTitlePage };
}

function renderPage(page, pageIndex, hasTitlePage) {
  const titlePage = hasTitlePage && pageIndex === 0;
  const commands = ["0 g"];
  let y = titlePage ? TITLE_TOP : BODY_TOP;

  if (!titlePage) {
    const screenplayPage = pageIndex + (hasTitlePage ? 0 : 1);
    commands.push(textCommand(String(screenplayPage), 540, 756, { size: 10 }));
  }

  page.forEach((entry) => {
    const block = entry.block || entry;
    if (!block || block.type === "divider") return;
    const style = blockStyle(block.type, titlePage);
    y -= entry.before ?? style.before ?? 0;
    const lines = entry.lines || wrapText(block.text, style.limit);
    lines.forEach((line) => {
      const x = style.centered ? centeredX(line, style.size) : style.x;
      commands.push(textCommand(line, x, y, style));
      y -= style.size * LINE_HEIGHT_MULTIPLIER;
    });
    y -= entry.after ?? style.after ?? 0;
  });

  return `${commands.join("\n")}\n`;
}

function asciiBytes(value) {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  parts.forEach((part) => { result.set(part, offset); offset += part.length; });
  return result;
}

export function buildScreenplayPdf(pages, { hasTitlePage = false } = {}) {
  const safePages = pages.length ? pages : [[]];
  const objects = [];
  const pageIds = safePages.map((_, index) => 6 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Count ${safePages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>";

  safePages.forEach((page, index) => {
    const stream = renderPage(page, index, hasTitlePage);
    const contentId = 5 + index * 2;
    const pageId = contentId + 1;
    objects[contentId] = `<< /Length ${asciiBytes(stream).length} >>\nstream\n${stream}endstream`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`;
  });

  const chunks = [Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 52, 10, 37, 226, 227, 207, 211, 10])];
  const offsets = [0];
  let offset = chunks[0].length;
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = offset;
    const chunk = asciiBytes(`${id} 0 obj\n${objects[id]}\nendobj\n`);
    chunks.push(chunk);
    offset += chunk.length;
  }
  const xrefOffset = offset;
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  chunks.push(asciiBytes(xref));
  return concatBytes(chunks);
}

export function screenplayPdfFilename(projectName, draftName) {
  const stem = [projectName, draftName].filter(Boolean).join("-").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return `${stem || "Screenplay"}.pdf`;
}
