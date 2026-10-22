// All scripts, names, room identifiers, and keys below are fictional test fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { applyReviewFixes, blocksToFountain, classifyLines, createReviewFixes, reclassifyBlocks } from "../src/screenplay.js";
import { buildScreenplayPdf, paginateScreenplayForPdf, screenplayPdfFilename } from "../src/pdf.js";

const pastedDraft = `MOON STATION

A fictional test scene

By Fictional Writer

CAST OF CHARACTERS

Robot, a fictional pilot

Guide, a fictional engineer

Crew, a fictional robot

PLACE

An imaginary testing stage

TIME

An invented morning

________________

INT. TEST LAB – DAY

A green light flashes.

GUIDE

Ready.

(ROBOT and GUIDE inspect a blinking console.)

INT. TEST BAY – CONTINUOUS

ROBOT POINTS TO A TEST PANEL

ROBOT

(quietly)

The next test begins–`;

test("recognizes title-page and screenplay structure from a pasted Google Docs draft", () => {
  const blocks = classifyLines(pastedDraft);
  assert.deepEqual(blocks.slice(0, 8).map((block) => block.type), ["title", "centered", "centered", "section", "centered", "centered", "centered", "section"]);
  assert.equal(blocks.find((block) => block.text.startsWith("INT. TEST LAB"))?.text, "INT. TEST LAB — DAY");
  assert.equal(blocks.find((block) => block.text === "(ROBOT and GUIDE inspect a blinking console.)")?.type, "action");
  assert.equal(blocks.find((block) => block.text === "ROBOT POINTS TO A TEST PANEL")?.type, "action");
  assert.equal(blocks.find((block) => block.text === "(quietly)")?.type, "parenthetical");
  assert.equal(blocks.find((block) => block.text.startsWith("The next test"))?.type, "dialogue");
});

test("repairs element types without changing existing block ids", () => {
  const broken = classifyLines(pastedDraft).map((block, index) => ({ ...block, id: `kept-${index}`, type: index === 0 ? "character" : block.type }));
  const repaired = reclassifyBlocks(broken);
  assert.equal(repaired[0].type, "title");
  assert.equal(repaired[0].id, "kept-0");
});

test("exports title and author metadata to Fountain", () => {
  const fountain = blocksToFountain(classifyLines(pastedDraft));
  assert.match(fountain, /^Title: MOON STATION/);
  assert.match(fountain, /Author: Fictional Writer/);
});

test("round-trips Fountain title metadata, page breaks, and forced transitions", () => {
  const blocks = classifyLines(`Title: MOON STATION

Author: Fictional Writer

===

INT. TEST LAB - DAY

A robot enters the test bay.

> SMASH CUT TO:`);
  assert.deepEqual(blocks.map((block) => block.type), ["title", "centered", "divider", "scene", "action", "transition"]);
  assert.equal(blocks[0].text, "MOON STATION");
  assert.equal(blocks[1].text, "By Fictional Writer");
  assert.equal(blocks.at(-1).text, "SMASH CUT TO:");
});

test("offers only concrete changes for an imported screenplay", () => {
  const fixes = createReviewFixes(classifyLines(pastedDraft));
  assert.ok(fixes.length > 0);
  assert.ok(fixes.every((fix) => fix.before !== fix.after));
  assert.equal(fixes[0].title, "Remove parentheses from stage direction");
});

test("applies a review fix to the targeted screenplay block", () => {
  const blocks = [
    { id: "scene-1", type: "scene", text: "int. test lab - day" },
    { id: "action-1", type: "action", text: "A robot enters the test bay." },
  ];
  const fixes = createReviewFixes(blocks);
  assert.equal(fixes.length, 1);
  assert.equal(fixes[0].before, "int. test lab - day");
  assert.equal(fixes[0].after, "INT. TEST LAB — DAY");
  assert.deepEqual(applyReviewFixes(blocks, [fixes[0]])[0], { id: "scene-1", type: "scene", text: "INT. TEST LAB — DAY" });
});

test("splits inline delivery notes into real parenthetical and dialogue blocks", () => {
  const blocks = [
    { id: "speaker", type: "character", text: "ROBOT" },
    { id: "speech", type: "dialogue", text: "(Over the radio) Test complete." },
  ];
  const fixes = createReviewFixes(blocks);
  const result = applyReviewFixes(blocks, [fixes[0]]);
  assert.deepEqual(result.map((block) => block.type), ["character", "parenthetical", "dialogue"]);
  assert.deepEqual(result.map((block) => block.text), ["ROBOT", "(Over the radio)", "Test complete."]);
});

test("splits a combined cue, parenthetical, and spoken line", () => {
  const blocks = [
    { id: "cue", type: "action", text: "GUIDE (O.S.) (Muffled)" },
    { id: "line", type: "action", text: "Robot!" },
  ];
  const result = applyReviewFixes(blocks, createReviewFixes(blocks));
  assert.deepEqual(result.map((block) => block.type), ["character", "parenthetical", "dialogue"]);
  assert.deepEqual(result.map((block) => block.text), ["GUIDE (O.S.)", "(Muffled)", "Robot!"]);
});

test("finds new issues every time the screenplay changes", () => {
  const clean = classifyLines("INT. TEST LAB - DAY\n\nA robot enters the test bay.");
  assert.equal(createReviewFixes(clean).length, 0);
  const edited = clean.map((block, index) => index === 0 ? { ...block, text: "INT. TEST LAB" } : block);
  const fixes = createReviewFixes(edited);
  assert.equal(fixes[0].title, "Add time to the scene heading");
  assert.equal(createReviewFixes(applyReviewFixes(edited, fixes)).length, 0);
});

test("does not treat punctuated uppercase action as a character cue", () => {
  const broken = [
    { id: "knock", type: "character", text: "KNOCK." },
    { id: "reaction", type: "dialogue", text: "Two robots check a flashing light." },
  ];
  const result = applyReviewFixes(broken, createReviewFixes(broken));
  assert.deepEqual(result.map((block) => block.type), ["action", "action"]);
});

test("builds a directly downloadable multi-page PDF", () => {
  const pages = [
    [{ block: { type: "title", text: "MOON STATION" } }, { block: { type: "centered", text: "By Fictional Writer" } }],
    [{ block: { type: "scene", text: "INT. TEST LAB — DAY" } }, { block: { type: "action", text: "A robot checks the test panel." } }],
  ];
  const bytes = buildScreenplayPdf(pages, { hasTitlePage: true });
  const pdf = Buffer.from(bytes).toString("latin1");
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.match(pdf, /\/Type \/Pages \/Count 2/);
  assert.equal((pdf.match(/\/Type \/Page\b/g) || []).length, 2);
  assert.match(pdf, /MOON STATION/);
  assert.ok(pdf.endsWith("%%EOF\n"));
});

test("creates a dedicated title page and removes divider blocks from the PDF", () => {
  const blocks = [
    { id: "title", type: "title", text: "MOON STATION" },
    { id: "credit", type: "centered", text: "By Fictional Writer" },
    { id: "divider", type: "divider", text: "====" },
    { id: "scene", type: "scene", text: "INT. TEST LAB — DAY" },
    { id: "action", type: "action", text: "A robot enters the test bay." },
  ];
  const layout = paginateScreenplayForPdf(blocks);
  assert.equal(layout.hasTitlePage, true);
  assert.equal(layout.pages.length, 2);
  assert.deepEqual(layout.pages[0].map((entry) => entry.block.type), ["title", "centered"]);
  assert.deepEqual(layout.pages[1].map((entry) => entry.block.type), ["scene", "action"]);
});

test("fills PDF pages using rendered line heights instead of editor page units", () => {
  const blocks = Array.from({ length: 30 }, (_, index) => ({ id: `a${index}`, type: "action", text: `Short action beat ${index + 1}.` }));
  const layout = paginateScreenplayForPdf(blocks);
  assert.equal(layout.pages.length, 2);
  assert.ok(layout.pages[0].length >= 27);
  assert.equal(layout.pages.flat().length, blocks.length);
});

test("keeps scene headings with their opening action", () => {
  const filler = Array.from({ length: 26 }, (_, index) => ({ id: `f${index}`, type: "action", text: `Filler beat ${index + 1}.` }));
  const blocks = [
    ...filler,
    { id: "scene", type: "scene", text: "INT. TEST BAY — CONTINUOUS" },
    { id: "opening", type: "action", text: "A robot enters the test bay and checks a control switch." },
  ];
  const layout = paginateScreenplayForPdf(blocks);
  assert.equal(layout.pages.length, 2);
  assert.equal(layout.pages[1][0].block.id, "scene");
  assert.equal(layout.pages[1][1].block.id, "opening");
});

test("never leaves a scene heading at the bottom of a page", () => {
  for (let fillerCount = 1; fillerCount <= 35; fillerCount += 1) {
    const filler = Array.from({ length: fillerCount }, (_, index) => ({ id: `f${index}`, type: "action", text: `Filler beat ${index + 1}.` }));
    const layout = paginateScreenplayForPdf([
      ...filler,
      { id: "scene", type: "scene", text: "INT. TEST BAY — CONTINUOUS" },
      { id: "opening", type: "action", text: "A robot tests a blinking console while a guide checks the simulator on the far side of the room and a second robot moves a model vehicle toward its launch pad." },
    ]);
    layout.pages.slice(0, -1).forEach((page) => assert.notEqual(page.at(-1)?.block.type, "scene", `filler count ${fillerCount}`));
  }
});

test("keeps a character cue with its parenthetical and opening dialogue", () => {
  const filler = Array.from({ length: 27 }, (_, index) => ({ id: `f${index}`, type: "action", text: `Filler beat ${index + 1}.` }));
  const blocks = [
    ...filler,
    { id: "cue", type: "character", text: "ROBOT" },
    { id: "note", type: "parenthetical", text: "(quietly)" },
    { id: "speech", type: "dialogue", text: "The simulator needs another moment to finish its calibration." },
  ];
  const layout = paginateScreenplayForPdf(blocks);
  assert.equal(layout.pages.length, 2);
  assert.deepEqual(layout.pages[1].slice(0, 3).map((entry) => entry.block.id), ["cue", "note", "speech"]);
});

test("splits long blocks without losing text or crossing the bottom margin", () => {
  const text = Array.from({ length: 360 }, (_, index) => `word${index}`).join(" ");
  const layout = paginateScreenplayForPdf([{ id: "long", type: "action", text }]);
  const fragments = layout.pages.flat();
  assert.ok(layout.pages.length > 1);
  assert.equal(fragments.map((entry) => entry.lines.join(" ")).join(" "), text);

  const bytes = buildScreenplayPdf(layout.pages, { hasTitlePage: false });
  const pdf = Buffer.from(bytes).toString("latin1");
  const baselines = Array.from(pdf.matchAll(/1 0 0 1 [\d.]+ ([\d.]+) Tm/g), (match) => Number(match[1]));
  assert.ok(baselines.length > 0);
  assert.ok(Math.min(...baselines) >= 72);
});

test("does not create blank pages for repeated divider blocks", () => {
  const layout = paginateScreenplayForPdf([
    { id: "d1", type: "divider", text: "====" },
    { id: "d2", type: "divider", text: "====" },
    { id: "scene", type: "scene", text: "INT. TEST LAB — DAY" },
    { id: "d3", type: "divider", text: "====" },
    { id: "d4", type: "divider", text: "====" },
  ]);
  assert.equal(layout.pages.length, 1);
  assert.deepEqual(layout.pages[0].map((entry) => entry.block.id), ["scene"]);
});

test("creates a clean PDF filename", () => {
  assert.equal(screenplayPdfFilename("Moon Station", "Draft 8"), "Moon-Station-Draft-8.pdf");
});
