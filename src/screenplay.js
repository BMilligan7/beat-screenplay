const SCENE_HEADING = /^(?:INT\.?|EXT\.?|INT\/EXT\.?|EXT\/INT\.?|I\/E\.?|EST\.?)\s/i;
const TRANSITION = /^(?:FADE (?:IN|OUT)|CUT TO|DISSOLVE TO|SMASH CUT TO|MATCH CUT TO|WIPE TO)\:?$/i;
const FRONT_SECTIONS = /^(?:CAST(?: OF CHARACTERS)?|CHARACTERS|PLACE|SETTING|TIME|LOCATIONS?)$/i;
const CHARACTER_EXTENSION = /\s*\((?:V\.O\.|O\.S\.|O\.C\.|CONT['’]?D|FILTERED)\)\s*$/i;

function isUppercaseCue(line) {
  const cue = line.replace(CHARACTER_EXTENSION, "").trim();
  return cue.length > 0 && cue.length <= 36 && !/[.!?:]$/.test(cue) && cue === cue.toUpperCase() && /^[A-ZÀ-ÖØ-Ý0-9 .''’\-]+$/.test(cue);
}

function normalizeSceneHeading(line) {
  return line.toUpperCase().replace(/\s+[–—-]\s+/g, " — ").replace(/\s{2,}/g, " ");
}

function normalizeTextPunctuation(text) {
  return text
    .replace(/-[–—]/g, " — ")
    .replace(/–/g, "—")
    .replace(/(?<!\.)\.\.(?!\.)/g, ".")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function classifyLines(raw) {
  const lines = raw.replace(/\r/g, "").split(/\n+/).map((line) => line.trim()).filter((line) => line && !/^\d+\.?$/.test(line));
  const semanticLine = (line) => line.replace(/^>\s*/, "").replace(/\s*<$/, "").trim();
  const firstScene = lines.findIndex((line) => SCENE_HEADING.test(semanticLine(line)));
  const knownCharacters = new Set();
  let frontSection = "";

  if (firstScene > 0) {
    lines.slice(0, firstScene).forEach((line) => {
      if (FRONT_SECTIONS.test(line)) { frontSection = line.toUpperCase(); return; }
      if (/^CAST/.test(frontSection)) {
        const name = line.split(",")[0].trim();
        if (/^[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+){0,2}$/.test(name)) knownCharacters.add(name.toUpperCase());
      }
    });
  }

  const cueCounts = new Map();
  lines.slice(Math.max(firstScene, 0)).forEach((line) => {
    const semantic = semanticLine(line);
    if (!isUppercaseCue(semantic) || SCENE_HEADING.test(semantic) || TRANSITION.test(semantic)) return;
    const cue = semantic.replace(CHARACTER_EXTENSION, "").trim();
    cueCounts.set(cue, (cueCounts.get(cue) || 0) + 1);
  });
  cueCounts.forEach((count, cue) => { if (count > 1) knownCharacters.add(cue); });

  let previous = "action";
  frontSection = "";
  const timestamp = Date.now();
  return lines.map((line, index) => {
    const nextLine = semanticLine(lines[index + 1] || "");
    const semantic = semanticLine(line);
    let type = "action";
    let text = line.replace(/\s{2,}/g, " ");

    if (firstScene > 0 && index < firstScene) {
      if (index === 0) {
        type = "title";
        text = text.replace(/^title:\s*/i, "");
      }
      else if (/^(?:_{4,}|={3,})$/.test(line)) type = "divider";
      else if (/^author:\s*/i.test(line)) { type = "centered"; text = `By ${text.replace(/^author:\s*/i, "")}`; }
      else if (FRONT_SECTIONS.test(line)) { type = "section"; frontSection = line.toUpperCase(); }
      else type = "centered";
      if (/^CAST/.test(frontSection) && type === "centered") {
        const name = line.split(",")[0].trim();
        if (name) knownCharacters.add(name.toUpperCase());
      }
    } else if (SCENE_HEADING.test(semantic)) {
      type = "scene";
      text = normalizeSceneHeading(semantic);
    } else if (TRANSITION.test(semantic)) {
      type = "transition";
      text = semantic.toUpperCase();
      if (!text.endsWith(":")) text += ":";
    } else if (/^\(.+\)$/.test(line)) {
      const continuesDialogue = previous === "dialogue" && nextLine && !SCENE_HEADING.test(nextLine) && !TRANSITION.test(nextLine) && !isUppercaseCue(nextLine);
      type = previous === "character" || previous === "parenthetical" || continuesDialogue ? "parenthetical" : "action";
    } else if (isUppercaseCue(line)) {
      const cue = line.replace(CHARACTER_EXTENSION, "").trim();
      const wordCount = cue.split(/\s+/).length;
      const followedBySpeech = nextLine && !SCENE_HEADING.test(nextLine) && !TRANSITION.test(nextLine) && (!isUppercaseCue(nextLine) || /^\(.+\)$/.test(nextLine));
      type = knownCharacters.has(cue) || (wordCount <= 3 && followedBySpeech && !cue.endsWith(":")) ? "character" : "action";
      if (type === "character") text = text.toUpperCase();
    } else if (previous === "character" || previous === "parenthetical") {
      type = "dialogue";
    }

    previous = type;
    return { id: `import-${timestamp}-${index}`, type, text };
  });
}

export function reclassifyBlocks(blocks) {
  const parsed = classifyLines(blocks.map((block) => block.text).join("\n\n"));
  return parsed.map((block, index) => ({ ...block, id: blocks[index]?.id || block.id }));
}

export function createReviewFixes(blocks) {
  const repaired = reclassifyBlocks(blocks);
  const labels = {
    action: "Action",
    centered: "Centered title-page text",
    character: "Character cue",
    dialogue: "Dialogue",
    divider: "Title-page divider",
    parenthetical: "Dialogue parenthetical",
    scene: "Scene heading",
    section: "Section heading",
    title: "Title-page heading",
    transition: "Transition",
  };
  const titles = {
    action: "Format as action",
    centered: "Center title-page text",
    character: "Format as a character cue",
    dialogue: "Format as dialogue",
    divider: "Add a title-page divider",
    parenthetical: "Place the dialogue parenthetical",
    scene: "Standardize the scene heading",
    section: "Format the section heading",
    title: "Format the title page",
    transition: "Standardize the transition",
  };

  const fixes = [];
  const claimed = new Set();
  const add = ({ sourceIds, title, detail, before, after, replacements }) => {
    if (sourceIds.some((id) => claimed.has(id))) return false;
    const id = `fix-${sourceIds.join("-")}-${fixes.length + 1}`;
    fixes.push({ id, fingerprint: `${sourceIds.join("|")}::${before}::${after}`, sourceIds, blockId: sourceIds[0], title, detail, before, after, replacements });
    sourceIds.forEach((id) => claimed.add(id));
    return true;
  };

  blocks.forEach((block, index) => {
    const next = blocks[index + 1];
    if (block.type !== "action" || next?.type !== "action") return;
    const cueMatch = block.text.match(/^([A-Z][A-Z0-9 .''’\-]{0,35}?)(\s*(?:\([^)]*\)\s*)+)$/u);
    if (!cueMatch) return;
    const name = cueMatch[1].trim();
    const notes = Array.from(cueMatch[2].matchAll(/\([^)]*\)/g), (match) => match[0]);
    const extension = notes.find((note) => /^\((?:V\.O\.|O\.S\.|O\.C\.|CONT['’]?D|FILTERED)\)$/i.test(note));
    const delivery = notes.filter((note) => note !== extension);
    if (!delivery.length || name.split(/\s+/).length > 3 || next.text.length > 240) return;
    const characterText = `${name}${extension ? ` ${extension.toUpperCase()}` : ""}`;
    const parentheticalText = delivery.join(" ");
    add({
      sourceIds: [block.id, next.id],
      title: "Split the character cue and dialogue",
      detail: "Character names, delivery notes, and spoken words each need their own screenplay element.",
      before: `${block.text}\n${next.text}`,
      after: `${characterText}\n${parentheticalText}\n${next.text}`,
      replacements: [
        { ...block, type: "character", text: characterText },
        { id: `${block.id}-parenthetical`, type: "parenthetical", text: parentheticalText },
        { ...next, type: "dialogue" },
      ],
    });
  });

  blocks.forEach((block) => {
    if (block.type !== "dialogue") return;
    const match = block.text.match(/^(\([^)]*\))\s*(\S[\s\S]*)$/);
    if (!match) return;
    const dialogueText = normalizeTextPunctuation(match[2]);
    add({
      sourceIds: [block.id],
      title: "Separate the dialogue parenthetical",
      detail: "A delivery note belongs on its own indented line above the spoken dialogue.",
      before: block.text,
      after: `${match[1]}\n${dialogueText}`,
      replacements: [
        { ...block, type: "parenthetical", text: match[1] },
        { id: `${block.id}-dialogue`, type: "dialogue", text: dialogueText },
      ],
    });
  });

  blocks.forEach((block, index) => {
    const next = blocks[index + 1];
    if (block.type !== "dialogue" || next?.type !== "action") return;
    const match = block.text.match(/^([\s\S]*?\S)\s*(\((?:beat|pause|moment)\.?\))$/i);
    if (!match || next.text.length > 240) return;
    add({
      sourceIds: [block.id, next.id],
      title: "Keep the beat inside the dialogue passage",
      detail: "Place the beat on its own parenthetical line and keep the speaker’s next sentence in dialogue format.",
      before: `${block.text}\n${next.text}`,
      after: `${match[1]}\n${match[2]}\n${next.text}`,
      replacements: [
        { ...block, text: match[1] },
        { id: `${block.id}-parenthetical`, type: "parenthetical", text: match[2] },
        { ...next, type: "dialogue" },
      ],
    });
  });

  blocks.forEach((block, index) => {
    const previous = blocks[index - 1];
    const previousDialogue = blocks[index - 2];
    const previousCharacter = blocks[index - 3];
    if (block.type !== "action" || block.text.length > 90 || !/[?!]$/.test(block.text)) return;
    if (previous?.type !== "action" || previousDialogue?.type !== "dialogue" || previousCharacter?.type !== "character") return;
    add({
      sourceIds: [block.id],
      title: "Restore the missing character cue",
      detail: `This spoken line follows ${previousCharacter.text}'s dialogue but was left in action formatting.`,
      before: `${block.text}  ·  Action`,
      after: `${previousCharacter.text}\n${block.text}  ·  Dialogue`,
      replacements: [
        { id: `${block.id}-character`, type: "character", text: previousCharacter.text },
        { ...block, type: "dialogue" },
      ],
    });
  });

  blocks.forEach((block) => {
    if (block.type !== "action") return;
    const match = block.text.match(/^\(([^\n]+)\)$/);
    if (!match) return;
    let text = match[1].trim();
    if (!/[.!?…]$/.test(text)) text += ".";
    add({
      sourceIds: [block.id],
      title: "Remove parentheses from stage direction",
      detail: "Full action and stage direction lines use the standard action margin without surrounding parentheses.",
      before: block.text,
      after: text,
      replacements: [{ ...block, text }],
    });
  });

  const sceneTime = /(?:\s[-–—]\s*|\s)(?:DAY|NIGHT|MORNING|AFTERNOON|EVENING|DAWN|DUSK|LATER|CONTINUOUS|MOMENTS LATER|SAME|SAME TIME|SUNSET|SUNRISE)$/i;
  blocks.forEach((block) => {
    if (block.type !== "scene" || sceneTime.test(block.text)) return;
    const text = `${block.text.replace(/\s+$/, "")} — CONTINUOUS`;
    add({
      sourceIds: [block.id],
      title: "Add time to the scene heading",
      detail: "Professional scene headings include an interior/exterior, location, and time indicator.",
      before: block.text,
      after: text,
      replacements: [{ ...block, text }],
    });
  });

  blocks.forEach((block, index) => {
    if (claimed.has(block.id)) return;
    const target = repaired[index];
    if (!target || (block.type === target.type && block.text === target.text)) return;
    const typeChanged = block.type !== target.type;
    add({
      sourceIds: [block.id],
      title: titles[target.type] || "Correct screenplay formatting",
      detail: typeChanged
        ? `Change this element from ${labels[block.type] || block.type} to ${labels[target.type] || target.type}.`
        : `Apply standard ${labels[target.type] || target.type} capitalization, spacing, and punctuation.`,
      before: typeChanged ? `${block.text}  ·  ${labels[block.type] || block.type}` : block.text,
      after: typeChanged ? `${target.text}  ·  ${labels[target.type] || target.type}` : target.text,
      replacements: [{ ...block, type: target.type, text: target.text }],
    });
  });

  blocks.forEach((block) => {
    if (claimed.has(block.id)) return;
    const text = normalizeTextPunctuation(block.text);
    if (text === block.text) return;
    add({
      sourceIds: [block.id],
      title: "Clean up punctuation and spacing",
      detail: "Remove malformed dashes, repeated periods, and extra spaces without changing the wording.",
      before: block.text,
      after: text,
      replacements: [{ ...block, text }],
    });
  });

  return fixes;
}

export function applyReviewFixes(blocks, fixes) {
  return fixes.reduce((current, fix) => {
    const sourceIds = new Set(fix.sourceIds);
    const firstIndex = current.findIndex((block) => block.id === fix.sourceIds[0]);
    if (firstIndex < 0) return current;
    const next = [];
    current.forEach((block, index) => {
      if (index === firstIndex) next.push(...fix.replacements);
      if (!sourceIds.has(block.id)) next.push(block);
    });
    return next;
  }, blocks);
}

export function blocksToFountain(blocks) {
  let sceneStarted = false;
  return blocks.map((block) => {
    if (block.type === "scene") { sceneStarted = true; return block.text.toUpperCase(); }
    if (block.type === "title") return `Title: ${block.text}`;
    if (block.type === "section") return sceneStarted ? `# ${block.text}` : block.text.toUpperCase();
    if (block.type === "divider") return "===";
    if (block.type === "centered") {
      if (!sceneStarted && /^by\s+/i.test(block.text)) return `Author: ${block.text.replace(/^by\s+/i, "")}`;
      return sceneStarted ? `> ${block.text} <` : block.text;
    }
    if (block.type === "character") return `\n${block.text.toUpperCase()}`;
    if (block.type === "transition") return `\n> ${block.text.toUpperCase()}`;
    return block.text;
  }).join("\n\n");
}
