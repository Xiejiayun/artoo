// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";

const browserWindow = (globalThis as unknown as { jsdom: { window: Window } }).jsdom.window;

afterEach(() => {
  browserWindow.localStorage.clear();
  browserWindow.sessionStorage.clear();
});

it.each(["localStorage", "sessionStorage"] as const)("uses the browser's %s for drafts", (name) => {
  const storage = globalThis[name];
  const other = name === "localStorage" ? browserWindow.sessionStorage : browserWindow.localStorage;
  expect(storage).toBe(browserWindow[name]);

  storage.setItem("artoo:storage-test", "draft");
  expect(storage.getItem("artoo:storage-test")).toBe("draft");
  expect(storage.key(0)).toBe("artoo:storage-test");
  expect(Object.keys(storage)).toEqual(["artoo:storage-test"]);
  expect(other.getItem("artoo:storage-test")).toBeNull();

  storage.removeItem("artoo:storage-test");
  expect(storage.getItem("artoo:storage-test")).toBeNull();
  storage.setItem("artoo:storage-test", "another draft");
  storage.clear();
  expect(storage.length).toBe(0);
});
