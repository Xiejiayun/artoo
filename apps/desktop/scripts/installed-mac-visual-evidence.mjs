import assert from "node:assert/strict";

/** Read actual painted text geometry; neither enlarge nor restyle the app. */
export async function assertCompleteTextVisible(locator, description) {
  const proof = await locator.evaluate((element) => {
    let rectangles = 0;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode, parent = node.parentElement;
      if (!node.textContent.trim() || !parent) continue;
      // Chromium can return text ranges inside a closed disclosure even though
      // its body is not painted. Only its first summary remains visible.
      let closedDisclosure = false;
      for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.tagName !== "DETAILS" || ancestor.open) continue;
        const summary = [...ancestor.children].find((child) => child.tagName === "SUMMARY");
        if (!summary?.contains(parent)) { closedDisclosure = true; break; }
      }
      if (closedDisclosure) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      // Closed disclosures and accessibility-only text are not painted content.
      if (!rects.length || getComputedStyle(parent).visibility !== "visible") continue;
      const bounds = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), box = ancestor.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
          bounds.left = Math.max(bounds.left, box.left + ancestor.clientLeft);
          bounds.right = Math.min(bounds.right, box.left + ancestor.clientLeft + ancestor.clientWidth);
        }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
          bounds.top = Math.max(bounds.top, box.top + ancestor.clientTop);
          bounds.bottom = Math.min(bounds.bottom, box.top + ancestor.clientTop + ancestor.clientHeight);
        }
        if (style.position === "fixed") {
          // Viewport-fixed dialogs escape the thread's scrolling/clipping box.
          // A transformed/contained ancestor changes that containing block;
          // retain conservative ancestor checks in that less common case.
          let fixedContainer = false;
          for (let outer = ancestor.parentElement; outer; outer = outer.parentElement) {
            const outerStyle = getComputedStyle(outer);
            if (outerStyle.transform !== "none" || outerStyle.perspective !== "none" || outerStyle.filter !== "none"
              || /layout|paint|strict|content/.test(outerStyle.contain)
              || outerStyle.containerType !== "normal" || outerStyle.contentVisibility !== "visible"
              || /transform|perspective|filter/.test(outerStyle.willChange)) { fixedContainer = true; break; }
          }
          if (!fixedContainer) break;
        }
      }
      for (const rect of rects) {
        rectangles++;
        if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1
          || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) {
          return { passed: false, reason: "Text is clipped by its content viewport", rectangles,
            element: parent.tagName, bounds, rectangle: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } };
        }
        const inset = Math.min(2, rect.width / 4), y = (rect.top + rect.bottom) / 2;
        for (const x of [rect.left + inset, (rect.left + rect.right) / 2, rect.right - inset]) {
          const top = document.elementFromPoint(x, y);
          if (!top || !(parent.contains(top) || top.contains(parent))) {
            return { passed: false, reason: "Another visible control covers the text", rectangles,
              element: parent.tagName, covering_element: top?.tagName ?? null, point: { x, y } };
          }
        }
      }
    }
    return { passed: rectangles > 0, rectangles, reason: rectangles ? null : "No painted text found" };
  });
  assert.equal(proof.passed, true, `${description}: ${JSON.stringify(proof)}`);
  return proof;
}

export async function centerCompleteEvidence(locator, description) {
  const { expect } = await import("@playwright/test");
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }));
  await expect(locator).toBeVisible();
  await expect(locator).toBeInViewport({ ratio: 1 });
  return assertCompleteTextVisible(locator, description);
}
