import { chromium, type FullConfig } from "@playwright/test";

export default async function browserMetadata(config: FullConfig) {
  // Measure the same channel the tests will launch; never label system Chrome
  // as Playwright's bundled browser. No sessions or test credentials are used.
  const channel = config.projects[0]?.use.channel;
  const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
  try { config.metadata.browser_version = browser.version(); }
  finally { await browser.close(); }
}
