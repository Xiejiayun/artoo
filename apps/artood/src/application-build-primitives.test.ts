import { createHash } from "node:crypto";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { applicationSha256, applicationUtf8ByteLength, applicationVirtualDirname, isWellFormedApplicationUtf8,
  resolveApplicationVirtualPath } from "./application-build-primitives.js";

const nodeSha = (text: string) => "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
describe("guest-local compiler primitives (Node parity, no QuickJS/native qualification)", () => {
  it.each(["", "abc", "\u0000", "\u007f\u0080\u07ff\u0800\uffff", "中文", "😀", "👩‍💻", "\ufefftext",
    "\udbff\udfff", "\ud800", "\udfff", "\ud800x", "x\udfff", "\ud800\ud800", "\udfff\ud800", "a\ud800😀\udfffz"])
    ("matches Node UTF-8 bytes, validity and SHA for vector %#", text => {
      expect(applicationUtf8ByteLength(text)).toBe(Buffer.byteLength(text, "utf8"));
      expect(isWellFormedApplicationUtf8(text)).toBe(Buffer.from(text, "utf8").toString("utf8") === text);
      expect(applicationSha256(text)).toBe(nodeSha(text));
    });
  it("covers both SHA padding branches and multi-block transitions independently", () => {
    for (const length of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 255, 256, 257, 1024]) {
      for (const text of ["a".repeat(length), "中".repeat(length), "😀".repeat(length)]) expect(applicationSha256(text)).toBe(nodeSha(text));
    }
  });
  it("matches the NIST million-a vector without a retained full UTF-8 array", () => {
    const text = "a".repeat(1_000_000);
    expect(applicationSha256(text)).toBe("sha256:cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    expect(applicationSha256(text)).toBe(nodeSha(text));
  });
  it("matches POSIX dirname at virtual root, repeated/trailing separators and nested files", () => {
    for (const path of ["", "/", "//", "///", "/x", "//x", "/x/", "/x///", "/x/y", "/x/y/", "a", "a/b",
      "/__source/product/client/main.ts", "/__source/product/server/nested/module.ts", "/__toolchain/lib/lib.es2023.d.ts"])
      expect(applicationVirtualDirname(path)).toBe(posix.dirname(path));
  });
  it("matches absolute virtual resolution and clamps traversal at root without ambient cwd", () => {
    for (const base of ["/", "//", "/__source/product/server", "/__source/product/server/nested/", "/__source//product/client"])
      for (const target of ["", ".", "..", "./a.js", "../b.js", "../../client/main.js", "../../../../escape.js", "./nested/../a.js", "./a//b.js", "/absolute.js"])
        expect(resolveApplicationVirtualPath(base, target)).toBe(posix.resolve(base, target));
    expect(() => resolveApplicationVirtualPath("relative", "./a.js")).toThrow("requires_absolute_base");
  });
});
