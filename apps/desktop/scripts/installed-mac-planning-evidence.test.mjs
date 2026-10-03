import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { capturePlanningEvidence } from "./installed-mac-planning-evidence.mjs";
import { centerCompleteEvidence } from "./installed-mac-visual-evidence.mjs";

const enabled = process.env.ARTOO_PLANNING_EVIDENCE_BROWSER === "1";
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const longText = Array.from({ length: 28 }, (_, i) => `Instruction ${i + 1}: preserve the complete original α 中文 and inspect every visible character.`).join("\n");
function fixture(text, overflow = "auto") {
  return `<style>
    * { box-sizing: border-box } body { margin: 0; font: 16px/1.4 sans-serif }
    .outer { width: 560px; height: 380px; overflow: auto; border: 2px solid black }
    .spacer { height: 170px }
    .history { height: 58vh; overflow-y: ${overflow}; overflow-x: hidden; border: 2px solid #333 }
    .card { width: 100%; padding: 12px; border: 1px solid #888 }
    h3 { margin: 0 0 8px } pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.4 monospace }
    </style><div class="outer"><div class="spacer"></div><div class="history"><div class="spacer"></div>
    <section class="card" aria-label="Planning instruction"><h3>Planning instruction · Step 1</h3><pre>${escape(text)}</pre></section>
    <div class="spacer"></div></div><div class="spacer"></div></div>`;
}

test("planning evidence uses actual fixture viewport coverage", { skip: !enabled, timeout: 120_000 }, async (t) => {
  const output = process.env.ARTOO_PLANNING_EVIDENCE_OUTPUT ?? mkdtempSync(join(tmpdir(), "artoo-planning-evidence-"));
  mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.env.ARTOO_CHROMIUM_CHANNEL ? { channel: process.env.ARTOO_CHROMIUM_CHANNEL } : {}) });
  const results = [];
  async function exercise(name, { text = longText, overflow = "auto", standardsMode = false, before, mutateCapture, expectedError, oldRejects = false, maxFrames } = {}) {
    const context = await browser.newContext({ viewport: { width: 720, height: 480 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const evidence = { name }, images = [];
    let caught, verified = false;
    try {
      await page.setContent((standardsMode ? "<!doctype html>" : "") + fixture(text, overflow));
      const target = page.getByRole("region", { name: "Planning instruction", exact: true });
      assert.equal(await target.locator("pre").textContent(), text);
      if (oldRejects) await assert.rejects(centerCompleteEvidence(target, "whole-card baseline"), /toBeInViewport/);
      if (before) await before(page);
      try {
        await capturePlanningEvidence({ locator: target, description: name, evidence,
          ...(maxFrames ? { maxFrames } : {}),
          captureFrame: async (part, sequential) => {
            const path = join(output, `${name}-${String(part).padStart(2, "0")}.png`);
            const png = await page.screenshot({ path, fullPage: false, animations: "disabled" });
            const image = { path, part, sequential, bytes: png.length, sha256: createHash("sha256").update(png).digest("hex") };
            images.push(image);
            if (mutateCapture) await mutateCapture(page, part);
            return image;
          } });
      } catch (error) { caught = error; }
      if (expectedError) {
        assert.ok(caught, `${name} must fail instead of accepting incomplete evidence`);
        assert.match(caught.message, expectedError);
        assert.equal(evidence.complete, false);
      } else {
        if (caught) throw caught;
        assert.equal(evidence.complete, true);
        const keys = new Set(evidence.frames.flatMap((frame) => frame.newly_visible_ranges));
        assert.equal(keys.size, evidence.painted_ranges);
        assert.equal(evidence.frames.at(-1).covered_ranges_after, evidence.painted_ranges);
        assert.equal(await target.locator("pre").textContent(), text);
        assert.deepEqual(page.viewportSize(), { width: 720, height: 480 });
        assert.ok(images.every((image) => image.bytes > 0));
      }
      verified = true;
      return evidence;
    } finally {
      results.push({ name, passed: verified, expected_failure: !!expectedError, observed_error: caught?.message, evidence, images });
      await context.close();
      writeFileSync(join(output, "fixture-results.json"), JSON.stringify({ scope: "Headless fixture pages only; no installed client/provider acceptance", browser: browser.version(), results }, null, 2) + "\n");
    }
  }
  try {
    await t.test("fitting target preserves single complete viewport", async () => {
      const proof = await exercise("fitting", { text: "Short exact original instruction." });
      assert.equal(proof.method, "complete-viewport"); assert.equal(proof.frames.length, 1);
    });
    await t.test("oversized text is fully covered through both real scrolling ancestors", async () => {
      const proof = await exercise("nested-long", { oldRejects: true });
      assert.equal(proof.method, "sequential-viewport"); assert.ok(proof.frames.length > 1);
      const scrolled = new Set(proof.frames.flatMap((frame) => frame.scrolls.map((entry) => entry.className)));
      assert.ok(scrolled.has("history") && scrolled.has("outer"));
    });
    for (const rootOverflow of ["auto", "visible"]) {
      await t.test(`nonzero document scrolling with ${rootOverflow} root overflow preserves complete nested text coverage`, async () => {
        const proof = await exercise(`document-${rootOverflow}-and-nested`, { standardsMode: true, before: async (page) => {
          await page.evaluate((overflow) => {
            document.documentElement.style.overflowY = overflow;
            document.body.style.paddingTop = "700px";
            document.body.style.paddingBottom = "700px";
            window.scrollTo(0, 350);
          }, rootOverflow);
          assert.ok(await page.evaluate(() => document.scrollingElement === document.documentElement
            && document.scrollingElement.scrollTop > 0));
        }, mutateCapture: async (page) => {
          assert.deepEqual(await page.evaluate(() => ({
            overflow: document.documentElement.style.overflowY,
            top: document.body.style.paddingTop,
            bottom: document.body.style.paddingBottom,
          })), { overflow: rootOverflow, top: "700px", bottom: "700px" });
        } });
        assert.equal(proof.method, "sequential-viewport"); assert.ok(proof.frames.length > 1);
        const scrolls = proof.frames.flatMap((frame) => frame.scrolls);
        assert.ok(scrolls.some((entry) => entry.element === "HTML" && entry.before > 0));
        assert.ok(scrolls.some((entry) => entry.className === "history"));
        assert.ok(scrolls.some((entry) => entry.className === "outer"));
      });
    }
    await t.test("non-scrollable clipping is a failure", async () => {
      await exercise("hidden-clip", { overflow: "hidden", expectedError: /no new complete, unobscured text|no real scroll progress/ });
    });
    await t.test("an occluding control cannot be counted as visible text", async () => {
      await exercise("occluded", { before: (page) => page.evaluate(() => {
        const cover = document.createElement("div"); cover.style.cssText = "position:fixed;inset:0;z-index:999;background:white"; document.body.append(cover);
      }), expectedError: /no new complete, unobscured text/ });
    });
    await t.test("text changes after a captured frame fail the proof", async () => {
      await exercise("changed-text", { mutateCapture: (page, part) => part === 1 && page.locator("pre").evaluate((node) => { node.textContent += " Changed."; }), expectedError: /text changed/ });
    });
    await t.test("viewport changes cannot make long content pass", async () => {
      await exercise("changed-viewport", { mutateCapture: (page, part) => part === 1 && page.setViewportSize({ width: 900, height: 800 }), expectedError: /actual viewport changed/ });
    });
    await t.test("capture count is bounded and preserves incomplete proof", async () => {
      await exercise("bounded", { maxFrames: 1, expectedError: /exceeded 1 actual viewport captures/ });
    });
  } finally { await browser.close(); }
});
