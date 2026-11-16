import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { gitOperation } from "./git-operations.js";
import { withRepositoryOperation } from "./repository-operation-lane.js";

vi.mock("./git-operations.js", () => ({ gitOperation: vi.fn() }));
const roots: string[] = [];
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "artoo-repository-lane-")));
  roots.push(root);
  vi.mocked(gitOperation).mockImplementation(
    async () =>
      ({ status: 0, stdout: Buffer.from(`${root}\n`), stderr: Buffer.alloc(0) }) as Awaited<
        ReturnType<typeof gitOperation>
      >,
  );
  return { root, input: { sourceRepo: root, options: {} } };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it("serializes shared repository mutations while unrelated execution can continue", async () => {
  const f = fixture(),
    release = deferred(),
    order: string[] = [];
  const first = withRepositoryOperation(f.input, async () => {
    order.push("first entered");
    await release.promise;
    order.push("first closed");
  });
  await turn();
  const second = withRepositoryOperation(f.input, async () => {
    order.push("second entered");
  });
  await turn();
  expect(order).toEqual(["first entered"]);
  release.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(["first entered", "first closed", "second entered"]);
});
it("a cancelled waiter cannot release the predecessor or let a newcomer overtake it", async () => {
  const f = fixture(),
    release = deferred(),
    controller = new AbortController(),
    order: string[] = [];
  const first = withRepositoryOperation(f.input, async () => {
    order.push("first");
    await release.promise;
  });
  await turn();
  const waiting = withRepositoryOperation({ ...f.input, options: { signal: controller.signal } }, async () => {
    order.push("cancelled");
  });
  await turn();
  const cancelled = expect(waiting).rejects.toThrow("cancelled waiter");
  controller.abort(new Error("cancelled waiter"));
  await cancelled;
  const third = withRepositoryOperation(f.input, async () => {
    order.push("third");
  });
  await turn();
  expect(order).toEqual(["first"]);
  release.resolve();
  await Promise.all([first, third]);
  expect(order).toEqual(["first", "third"]);
});
it("rechecks the original startup window when queued work reaches the mutation boundary", async () => {
  const f = fixture(),
    release = deferred(),
    mutate = vi.fn(async () => {});
  const first = withRepositoryOperation(f.input, async () => release.promise);
  await turn();
  let expired = false;
  const queued = withRepositoryOperation(
    {
      ...f.input,
      assertStartCurrent: () => {
        if (expired) throw new Error("original start window expired");
      },
    },
    mutate,
  );
  await turn();
  expired = true;
  const rejected = expect(queued).rejects.toThrow("original start window expired");
  release.resolve();
  await first;
  await rejected;
  expect(mutate).not.toHaveBeenCalled();
});
