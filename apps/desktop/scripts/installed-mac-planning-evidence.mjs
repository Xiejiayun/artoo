import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { centerCompleteEvidence } from "./installed-mac-visual-evidence.mjs";

// Runs in the actual renderer. It reads layout and changes only real scroll
// positions; it never resizes, restyles, wraps text, or inserts capture markers.
function inspectPlanningTarget(element, { scrollKey } = {}) {
  const clip = (parent) => {
    const bounds = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let node = parent; node; node = node.parentElement) {
      // The document scrollport is the viewport already represented above.
      // Its element box moves with scrollY and is not a clipping rectangle.
      if (node === document.scrollingElement) continue;
      const style = getComputedStyle(node), box = node.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        bounds.left = Math.max(bounds.left, box.left + node.clientLeft);
        bounds.right = Math.min(bounds.right, box.left + node.clientLeft + node.clientWidth);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        bounds.top = Math.max(bounds.top, box.top + node.clientTop);
        bounds.bottom = Math.min(bounds.bottom, box.top + node.clientTop + node.clientHeight);
      }
    }
    return bounds;
  };
  const units = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let nodeIndex = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode, parent = node.parentElement, index = nodeIndex++;
    if (!parent || !node.textContent.trim()) continue;
    let closed = false;
    for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === "DETAILS" && !ancestor.open) {
        const summary = [...ancestor.children].find((child) => child.tagName === "SUMMARY");
        if (!summary?.contains(parent)) closed = true;
      }
    }
    if (closed || getComputedStyle(parent).visibility !== "visible") continue;
    let offset = 0;
    for (const character of node.textContent) {
      const start = offset; offset += character.length;
      if (!character.trim()) continue;
      const range = document.createRange(); range.setStart(node, start); range.setEnd(node, offset);
      if (![...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)) continue;
      units.push({ key: `${index}:${start}:${offset}`, range, parent });
    }
  }
  const scrolls = [];
  if (scrollKey !== undefined) {
    const unit = units.find((item) => item.key === scrollKey);
    if (!unit) throw new Error("Planning text range disappeared before scrolling");
    for (let ancestor = unit.parent; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (ancestor.scrollHeight <= ancestor.clientHeight
        || !(ancestor === document.scrollingElement || /auto|scroll/.test(style.overflowY))) continue;
      const rect = unit.range.getBoundingClientRect(), box = ancestor.getBoundingClientRect();
      const before = ancestor.scrollTop;
      const scrollportTop = ancestor === document.scrollingElement ? 0 : box.top + ancestor.clientTop;
      ancestor.scrollTop += rect.top - (scrollportTop + 8);
      if (Math.abs(ancestor.scrollTop - before) > 0.5) scrolls.push({
        element: ancestor.tagName, className: ancestor.className, before, after: ancestor.scrollTop,
        clientHeight: ancestor.clientHeight, scrollHeight: ancestor.scrollHeight,
      });
    }
  }
  const visible = [];
  for (const unit of units) {
    const bounds = clip(unit.parent);
    const rects = [...unit.range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    let opaque = true;
    for (let node = unit.parent; node; node = node.parentElement) {
      if (Number(getComputedStyle(node).opacity) === 0) opaque = false;
    }
    const complete = opaque && rects.length > 0 && rects.every((rect) => {
      if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1
        || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) return false;
      const inset = Math.min(2, rect.width / 4), y = (rect.top + rect.bottom) / 2;
      return [rect.left + inset, (rect.left + rect.right) / 2, rect.right - inset].every((x) => {
        const top = document.elementFromPoint(x, y);
        return top && (unit.parent.contains(top) || top.contains(unit.parent));
      });
    });
    if (complete) visible.push({ key: unit.key, rects: rects.map(({ left, top, right, bottom }) => ({ left, top, right, bottom })) });
  }
  const box = element.getBoundingClientRect();
  return { text: element.textContent, keys: units.map((unit) => unit.key), visible,
    viewport: { width: innerWidth, height: innerHeight }, clip: clip(element.parentElement),
    target: { left: box.left, top: box.top, width: box.width, height: box.height }, scrolls };
}

/** Planning-only opt-in. Every painted text range must occur fully unobscured
 * in a captured actual viewport; fitting targets keep the strict old helper. */
export async function capturePlanningEvidence({ locator, description, captureFrame, evidence, maxFrames = 16 }) {
  const deadline = Date.now() + 60_000;
  const settle = () => locator.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const inspect = (options = {}) => locator.evaluate(inspectPlanningTarget, options);
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await settle();
  const initial = await inspect();
  assert.ok(initial.keys.length > 0, `${description}: no painted text ranges`);
  const width = initial.clip.right - initial.clip.left, height = initial.clip.bottom - initial.clip.top;
  assert.ok(width > 0 && height > 0, `${description}: no usable content viewport`);
  assert.ok(initial.target.width <= width + 1, `${description}: horizontal clipping cannot be covered by vertical capture`);
  const sequential = initial.target.height > height + 1;
  Object.assign(evidence, { method: sequential ? "sequential-viewport" : "complete-viewport",
    text_sha256: createHash("sha256").update(initial.text).digest("hex"), painted_ranges: initial.keys.length,
    viewport: initial.viewport, initial_target: initial.target, initial_clip: initial.clip, frames: [], complete: false });
  const stable = (sample) => {
    assert.equal(sample.text, initial.text, `${description}: text changed during capture`);
    assert.deepEqual(sample.keys, initial.keys, `${description}: painted text inventory changed`);
    assert.deepEqual(sample.viewport, initial.viewport, `${description}: actual viewport changed`);
    assert.ok(Math.abs(sample.target.width - initial.target.width) <= 1
      && Math.abs(sample.target.height - initial.target.height) <= 1, `${description}: target layout changed`);
  };
  const covered = new Set();
  for (let part = 1; part <= maxFrames; part++) {
    assert.ok(Date.now() < deadline, `${description}: capture deadline exceeded`);
    let scrolls = [];
    if (sequential) {
      const next = initial.keys.find((key) => !covered.has(key));
      const moved = await inspect({ scrollKey: next }); stable(moved); scrolls = moved.scrolls;
      await settle();
    } else await centerCompleteEvidence(locator, description);
    const before = await inspect(); stable(before);
    const fresh = before.visible.filter(({ key }) => !covered.has(key));
    assert.ok(fresh.length > 0, `${description}: scrolling exposed no new complete, unobscured text`);
    if (!sequential) assert.equal(before.visible.length, initial.keys.length, `${description}: incomplete fitting target`);
    const frame = { part, scrolls, target: before.target, clip: before.clip,
      newly_visible_ranges: fresh.map(({ key }) => key), visible_range_count: before.visible.length };
    evidence.frames.push(frame); // Failed captures retain their actual partial evidence.
    frame.image = await captureFrame(part, sequential);
    const after = await inspect(); stable(after);
    const afterRects = new Map(after.visible.map((item) => [item.key, item.rects]));
    for (const item of before.visible) {
      const actual = afterRects.get(item.key);
      assert.ok(actual && actual.length === item.rects.length, `${description}: text became obscured while capturing`);
      assert.ok(actual.every((rect, index) => ["left", "top", "right", "bottom"].every((axis) =>
        Math.abs(rect[axis] - item.rects[index][axis]) <= 1)), `${description}: text moved while capturing`);
      covered.add(item.key);
    }
    frame.covered_ranges_after = covered.size;
    if (covered.size === initial.keys.length) { evidence.complete = true; return evidence; }
    assert.ok(sequential, `${description}: a single complete viewport omitted text`);
    assert.ok(scrolls.length > 0 || part === 1, `${description}: no real scroll progress`);
  }
  throw new Error(`${description}: complete text coverage exceeded ${maxFrames} actual viewport captures`);
}
