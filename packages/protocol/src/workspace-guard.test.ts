import nodePath from "node:path";
import { describe, expect, it } from "vitest";

import {
  WorkspaceScopeError,
  assertWorkspaceScope,
  isPathWithinScope
} from "./workspace-guard.js";

const win32 = nodePath.win32;
const posix = nodePath.posix;

describe("isPathWithinScope (posix)", () => {
  const roots = ["/ws/project"];

  it("allows a path inside the root", () => {
    expect(isPathWithinScope("/ws/project/src/index.ts", roots, posix)).toBe(true);
  });

  it("allows the root itself", () => {
    expect(isPathWithinScope("/ws/project", roots, posix)).toBe(true);
  });

  it("rejects a sibling that shares a prefix string but not a path boundary", () => {
    expect(isPathWithinScope("/ws/project-evil/secret", roots, posix)).toBe(false);
  });

  it("rejects traversal that escapes the root", () => {
    expect(isPathWithinScope("/ws/project/../etc/passwd", roots, posix)).toBe(false);
  });

  it("rejects an unrelated path", () => {
    expect(isPathWithinScope("/other/place", roots, posix)).toBe(false);
  });
});

describe("isPathWithinScope (win32)", () => {
  const roots = ["C:\\workspace\\artoo"];

  it("allows a nested path", () => {
    expect(isPathWithinScope("C:\\workspace\\artoo\\packages\\protocol", roots, win32)).toBe(true);
  });

  it("is case-insensitive on Windows", () => {
    expect(isPathWithinScope("c:\\WORKSPACE\\Artoo\\src", roots, win32)).toBe(true);
  });

  it("rejects traversal escaping the root", () => {
    expect(isPathWithinScope("C:\\workspace\\artoo\\..\\evil", roots, win32)).toBe(false);
  });

  it("rejects a different drive", () => {
    expect(isPathWithinScope("D:\\workspace\\artoo\\src", roots, win32)).toBe(false);
  });
});

describe("assertWorkspaceScope", () => {
  it("returns silently when in scope", () => {
    expect(() => assertWorkspaceScope("/ws/project/a.ts", ["/ws/project"], posix)).not.toThrow();
  });

  it("throws a permission_denied WorkspaceScopeError when out of scope", () => {
    try {
      assertWorkspaceScope("/ws/project/../escape", ["/ws/project"], posix);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkspaceScopeError);
      expect((err as WorkspaceScopeError).code).toBe("permission_denied");
    }
  });
});
