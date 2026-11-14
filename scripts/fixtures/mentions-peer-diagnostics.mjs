import { performance } from "node:perf_hooks";

/** Local fixture evidence only: never read cookies, headers or network bodies. */
export function observeMentionPeer(page, secrets = []) {
  const started = performance.now(),
    events = [],
    listeners = [];
  let dropped = 0,
    crashed = false;
  const redact = (value) => {
    let result = String(value);
    for (const secret of secrets) if (secret) result = result.replaceAll(secret, "[redacted]");
    return result;
  };
  const safeURL = (value) => {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? redact(url.origin + url.pathname) : "non-http-url";
    } catch {
      return "invalid-url";
    }
  };
  const text = (value, limit) => {
    return redact(value)
      .replace(/https?:\/\/[^\s"'<>]+/g, safeURL)
      .slice(0, limit);
  };
  const record = (event, detail = {}) => {
    if (events.length < 500) events.push({ elapsed_ms: performance.now() - started, event, ...detail });
    else dropped += 1;
  };
  const on = (event, listener) => {
    page.on(event, listener);
    listeners.push([event, listener]);
  };
  const request = (value) => ({ method: value.method(), url: safeURL(value.url()) });
  on("request", (value) => record("request", request(value)));
  on("response", (value) => record("response", { ...request(value.request()), status: value.status() }));
  on("requestfinished", (value) => record("requestfinished", request(value)));
  on("requestfailed", (value) =>
    record("requestfailed", { ...request(value), error: text(value.failure()?.errorText, 2000) }),
  );
  on("pageerror", (error) => record("pageerror", { name: text(error.name, 100), message: text(error.message, 2000) }));
  on("crash", () => {
    crashed = true;
    record("crash");
  });
  on("close", () => record("close"));
  on("domcontentloaded", () => record("domcontentloaded", { url: safeURL(page.url()) }));
  on("load", () => record("load", { url: safeURL(page.url()) }));
  return {
    async snapshot() {
      const result = { url: safeURL(page.url()), closed: page.isClosed(), crashed };
      if (result.closed || crashed) result.body_error = "Page is closed or crashed";
      else {
        try {
          result.body_text = text(await page.locator("body").innerText({ timeout: 1000 }), 16_000);
        } catch (error) {
          result.body_error = text(error.message, 2000);
        }
      }
      return { ...result, events: structuredClone(events), dropped_events: dropped };
    },
    dispose() {
      for (const [event, listener] of listeners) page.off(event, listener);
    },
  };
}
