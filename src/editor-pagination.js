// Layout uses the heights of the rendered rows, including their actual wrapping.
// It never inserts, removes, or splits screenplay elements in the saved document.
export function paginateEditorBlocks(blocks, layout = {}) {
  const heights = layout?.heights || {};
  const bodyCapacity = layout?.bodyCapacity || 888;
  const titleCapacity = layout?.titleCapacity || 853;
  const hasTitle = blocks[0]?.type === "title";
  const firstScene = hasTitle ? blocks.findIndex((block) => block.type === "scene") : -1;
  const pages = [[]];
  let used = 0;
  let lineIndex = 0;
  const capacity = () => hasTitle && pages.length === 1 ? titleCapacity : bodyCapacity;
  const height = (block) => heights[block.id] || Math.max(28, Math.ceil(block.text.length / 40) * 26 + 18);
  const groupHeights = [];
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    const next = blocks[index + 1];
    const keepNext = next && next.type !== "divider" && (block.type === "scene" ||
      ((block.type === "character" || block.type === "parenthetical") && ["parenthetical", "dialogue"].includes(next.type)));
    groupHeights[index] = height(block) + (keepNext ? groupHeights[index + 1] : 0);
  }
  const nextPage = () => {
    if (pages.at(-1).length) pages.push([]);
    used = 0;
  };

  blocks.forEach((block, index) => {
    if (block.type === "divider") { nextPage(); return; }
    if (index === firstScene) nextPage();
    const keepHeight = groupHeights[index];
    // A very tall individual element may grow its page, but never overlaps it.
    const required = keepHeight <= capacity() ? keepHeight : height(block);
    if (used && used + required > capacity()) nextPage();
    pages.at(-1).push({ block, index: lineIndex++ });
    used += height(block);
  });
  const populated = pages.filter((page) => page.length);
  return populated.length ? populated : [[]];
}
