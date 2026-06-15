import { describe, expect, it } from "vitest";

import {
  type LeaseScope,
  leasesConflict,
  normalizeLeasePath,
  pathsOverlap,
} from "./lease.js";

const ROOT = "/work/ws";

function norm(raw: string): string {
  const r = normalizeLeasePath(ROOT, raw);
  if (!r.ok) {
    throw new Error(`expected ok, got rejection: ${r.reason}`);
  }
  return r.path;
}

const scope = (path: string, mode: LeaseScope["mode"]): LeaseScope => ({ path, mode });

describe("normalizeLeasePath", () => {
  it("normalizes relative and contained-absolute paths to workspace-relative POSIX", () => {
    expect(norm("src/app.ts")).toBe("src/app.ts");
    expect(norm("src\\app.ts")).toBe("src/app.ts"); // windows separators
    expect(norm("Src\\Foo.ts")).toBe("src/foo.ts"); // canonical case-fold
    expect(norm("./src/./app.ts")).toBe("src/app.ts");
    expect(norm("src/sub/../app.ts")).toBe("src/app.ts"); // contained ..
    expect(norm("/WORK/WS/src/app.ts")).toBe("src/app.ts"); // absolute within root
    expect(norm("/work/ws")).toBe(""); // the root itself
  });

  it("rejects null bytes and empty paths before storage", () => {
    expect(normalizeLeasePath(ROOT, "src/\0app.ts").ok).toBe(false);
    expect(normalizeLeasePath(ROOT, "").ok).toBe(false);
    expect(normalizeLeasePath(ROOT, "   ").ok).toBe(false);
  });

  it("rejects drive / root / UNC absolute escapes", () => {
    expect(normalizeLeasePath(ROOT, "C:\\Windows\\system32").ok).toBe(false);
    expect(normalizeLeasePath(ROOT, "/etc/passwd").ok).toBe(false);
    expect(normalizeLeasePath(ROOT, "//server/share").ok).toBe(false);
    expect(normalizeLeasePath(ROOT, "/work/wsother/x").ok).toBe(false); // prefix-but-not-contained
  });

  it("rejects `..` traversal that climbs above the workspace root", () => {
    expect(normalizeLeasePath(ROOT, "../outside").ok).toBe(false);
    expect(normalizeLeasePath(ROOT, "src/../../escape").ok).toBe(false);
  });
});

describe("pathsOverlap (segment-aware containment)", () => {
  it("treats equal and ancestor/descendant paths as overlapping", () => {
    expect(pathsOverlap("src/foo", "src/foo")).toBe(true);
    expect(pathsOverlap("src/foo", "src/foo/bar.ts")).toBe(true);
    expect(pathsOverlap("src/foo/bar.ts", "src/foo")).toBe(true);
  });

  it("does not treat sibling-prefix names as overlapping", () => {
    expect(pathsOverlap("src/foo", "src/foobar")).toBe(false);
    expect(pathsOverlap("src/foo", "src/bar")).toBe(false);
  });

  it("the workspace root (empty path) overlaps everything", () => {
    expect(pathsOverlap("", "src/foo")).toBe(true);
    expect(pathsOverlap("anything/here", "")).toBe(true);
  });
});

describe("leasesConflict", () => {
  it("read/read coexists on overlapping paths", () => {
    expect(leasesConflict(scope("src/foo", "read"), scope("src/foo/bar.ts", "read"))).toBe(false);
  });

  it("write/write and write/read conflict on overlapping paths", () => {
    expect(leasesConflict(scope("src/foo", "write"), scope("src/foo/bar.ts", "write"))).toBe(true);
    expect(leasesConflict(scope("src/foo", "write"), scope("src/foo/bar.ts", "read"))).toBe(true);
    expect(leasesConflict(scope("src/foo", "read"), scope("src/foo/bar.ts", "write"))).toBe(true);
  });

  it("non-overlapping paths never conflict, regardless of mode", () => {
    expect(leasesConflict(scope("src/foo", "write"), scope("src/bar", "write"))).toBe(false);
    expect(leasesConflict(scope("src/foo", "write"), scope("src/foobar", "write"))).toBe(false);
  });
});
