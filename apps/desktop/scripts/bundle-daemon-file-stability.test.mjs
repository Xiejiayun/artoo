// Real small-file IO with controlled metadata/timing; no bundling, child process or native helper.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, mock, test } from "node:test";
import { publishStagingDirectory } from "./bundle-daemon.mjs";

const actual = Object.fromEntries(["openSync", "closeSync", "readSync", "writeSync", "lstatSync", "fstatSync", "renameSync"]
  .map(name => [name, fs[name]]));
const sha = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const changed = (stat, values) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, values);

async function attempt(hooks = {}) {
  const parent = fs.realpathSync.native(process.env.ARTOO_BUNDLE_TEST_PARENT_DIRECTORY ?? tmpdir());
  const root = fs.realpathSync.native(fs.mkdtempSync(join(parent, "artoo-bundle-stability-")));
  const source = join(root, "stage"), output = join(root, "output"), file = join(source, "private-member.txt");
  fs.mkdirSync(source); const contents = Buffer.from("private-fixture-content\n"); fs.writeFileSync(file, contents);
  const before = actual.lstatSync(file), expected = { directories: [], files: [{ path: "private-member.txt", size: contents.length, sha256: sha(contents) }] };
  const first = Object.assign(new Error("controlled first rename EPERM"), { code: "EPERM" });
  const observed = { opens: 0, closes: 0, handleStats: 0, pathStats: 0, reads: [], renameAttempts: 0 };
  let descriptor;
  const replacements = [];
  const replace = (name, implementation) => replacements.push(mock.method(fs, name, implementation));
  const metadata = (stat, fact, index) => {
    // Isolate deliberate races from the host's own initial NTFS access-time update.
    const stable = changed(stat, { ctimeMs: before.ctimeMs });
    return hooks.stats ? hooks.stats(stable, { fact, index, observed, before }) : stable;
  };
  try {
    replace("renameSync", (from, to) => {
      assert.equal(String(from), source); assert.equal(String(to), output);
      if (++observed.renameAttempts === 1) throw first;
      return actual.renameSync(from, to);
    });
    replace("openSync", (...args) => {
      const fd = actual.openSync(...args);
      if (String(args[0]) === file) { descriptor = fd; observed.opens++; }
      return fd;
    });
    replace("closeSync", fd => {
      const result = actual.closeSync(fd);
      if (fd === descriptor) observed.closes++;
      return result;
    });
    replace("lstatSync", (...args) => {
      const stat = actual.lstatSync(...args);
      return String(args[0]) === file && descriptor !== undefined ? metadata(stat, "path", ++observed.pathStats) : stat;
    });
    replace("fstatSync", (...args) => {
      const stat = actual.fstatSync(...args);
      return args[0] === descriptor ? metadata(stat, "handle", ++observed.handleStats) : stat;
    });
    replace("readSync", (...args) => {
      const count = actual.readSync(...args);
      if (args[0] === descriptor) {
        observed.reads.push({ fd: descriptor, position: args[4], count });
        hooks.afterRead?.({ count, position: args[4], observed, file, before, contents });
      }
      return count;
    });
    syncBuiltinESMExports();
    let rejection;
    // The existing retry boundary reaches the private snapshot/fileFact path after one controlled EPERM.
    // It neither builds a package nor adds a production test hook/export.
    try { await publishStagingDirectory(source, output, expected); } catch (error) { rejection = error; }
    return { rejection, first, file, contents, observed, stageExists: fs.existsSync(source), outputExists: fs.existsSync(output) };
  } finally {
    for (const replacement of replacements.reverse()) replacement.mock.restore();
    syncBuiltinESMExports();
    assert.equal(observed.closes, observed.opens, `File closure unconfirmed; fixture retained: ${root}`);
    assert.equal(dirname(root), parent); assert.ok(basename(root).startsWith("artoo-bundle-stability-"));
    assert.equal(fs.realpathSync.native(root), root);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function rejectedRead(result) {
  assert.ok(result.rejection instanceof AggregateError);
  assert.equal(result.rejection.cause, result.first);
  assert.equal(result.rejection.errors[0], result.first); assert.equal(result.rejection.errors.length, 2);
  assert.equal(result.observed.renameAttempts, 1); assert.equal(result.stageExists, true); assert.equal(result.outputExists, false);
  assert.equal(result.observed.opens, 1); assert.equal(result.observed.closes, 1);
  return result.rejection.errors[1];
}
function diagnostic(result) {
  const error = rejectedRead(result), marker = " [file_read_diagnostic.v1 ", start = error.message.indexOf(marker);
  assert.equal(error.message.slice(0, start), `Daemon bundle: file changed while reading: ${result.file}`);
  assert.ok(start > 0 && error.message.endsWith("]"));
  return JSON.parse(error.message.slice(start + marker.length, -1));
}

describe("Windows bundle file stability through the existing publish boundary", { skip: process.platform !== "win32", concurrency: false }, () => {
  // Counts include the separate handle observation that pins ctime before the second pass.
  const stages = [
    { read_stage: "before_read", handle: 1, path: 1, passes: 0 },
    { read_stage: "after_first_hash", handle: 2, path: 2, passes: 1 },
    { read_stage: "before_second_hash", handle: 4, path: 3, passes: 1 },
    { read_stage: "after_second_hash", handle: 5, path: 4, passes: 2 },
  ];
  for (const stage of stages) for (const fact of ["handle", "path"]) {
    test(`retains the ${fact} mtime rejection at ${stage.read_stage} without extra observations`, async () => {
      const result = await attempt({ stats: (stat, observed) => observed.fact === fact && observed.index === stage[fact]
        ? changed(stat, { mtimeMs: stat.mtimeMs + 1 }) : stat });
      assert.deepEqual(diagnostic(result), { read_stage: stage.read_stage, fact, changed_fields: ["mtime"] });
      assert.equal(result.observed.handleStats, stage.handle); assert.equal(result.observed.pathStats, stage.path);
      assert.equal(result.observed.reads.length, stage.passes * 2);
      assert.equal(result.observed.reads.reduce((sum, read) => sum + read.count, 0), stage.passes * result.contents.length);
    });
  }

  const changes = {
    regular_file: stat => changed(stat, { isFile: () => false }), symlink: stat => changed(stat, { isSymbolicLink: () => true }),
    nlink: stat => changed(stat, { nlink: 2 }), dev: stat => changed(stat, { dev: stat.dev === 0 ? 1 : 0 }),
    ino: stat => changed(stat, { ino: stat.ino === 0 ? 1 : 0 }), size: stat => changed(stat, { size: stat.size + 1 }),
    ctime: stat => changed(stat, { ctimeMs: stat.ctimeMs + 1 }),
  };
  for (const [field, change] of Object.entries(changes)) {
    test(`keeps the second-read ${field} rejection and emits only fixed diagnostic fields`, async () => {
      const result = await attempt({ stats: (stat, observed) => observed.fact === "path" && observed.index === 4 ? change(stat) : stat });
      assert.deepEqual(diagnostic(result), { read_stage: "after_second_hash", fact: "path", changed_fields: [field] });
      assert.equal(result.observed.handleStats, 5); assert.equal(result.observed.pathStats, 4);
      assert.equal(result.observed.reads.length, 4);
    });
  }

  test("rejects second-read ctime instability observed only through the original handle", async () => {
    const result = await attempt({ stats: (stat, observed) => observed.fact === "handle" && observed.index === 5
      ? changed(stat, { ctimeMs: stat.ctimeMs + 1 }) : stat });
    assert.deepEqual(diagnostic(result), { read_stage: "after_second_hash", fact: "handle", changed_fields: ["ctime"] });
    assert.equal(result.observed.handleStats, 5); assert.equal(result.observed.pathStats, 4);
    assert.equal(result.observed.reads.length, 4);
  });

  test("accepts a first-read ctime-only update with two matching complete reads on the original handle", async () => {
    let read = false;
    const result = await attempt({ stats: stat => changed(stat, { ctimeMs: stat.ctimeMs + (read ? 1 : 0) }),
      afterRead: ({ count }) => { if (count) read = true; } });
    assert.equal(result.rejection, undefined); assert.equal(result.observed.renameAttempts, 2);
    assert.equal(result.stageExists, false); assert.equal(result.outputExists, true);
    assert.equal(result.observed.opens, 1); assert.equal(result.observed.closes, 1);
    assert.equal(new Set(result.observed.reads.map(item => item.fd)).size, 1);
    assert.deepEqual(result.observed.reads.map(item => [item.position, item.count]),
      [[0, result.contents.length], [result.contents.length, 0], [0, result.contents.length], [result.contents.length, 0]]);
    assert.equal(result.observed.handleStats, 5); assert.equal(result.observed.pathStats, 4);
  });

  test("still rejects unequal full hashes when a controlled same-length write preserves observed metadata", async () => {
    let wrote = false;
    const result = await attempt({ stats: (stat, { before }) => changed(stat, { mtimeMs: before.mtimeMs }),
      afterRead: ({ count, file, contents }) => {
        if (count !== 0 || wrote) return;
        wrote = true; const writer = actual.openSync(file, "r+");
        try { const bytes = Buffer.alloc(contents.length, "x"); assert.equal(actual.writeSync(writer, bytes, 0, bytes.length, 0), bytes.length); }
        finally { actual.closeSync(writer); }
      } });
    assert.equal(wrote, true);
    assert.equal(rejectedRead(result).message, `Daemon bundle: file content changed: ${result.file}`);
    assert.equal(result.observed.reads.length, 4);
    assert.equal(result.observed.handleStats, 5); assert.equal(result.observed.pathStats, 4);
  });
});
