import assert from "node:assert/strict";
import test from "node:test";
import { withWorkflowCleanup } from "./workflow-cleanup.mjs";

test("success waits for owned cleanup before returning the workflow value", async () => {
  const events = [];
  let finishCleanup;
  const closing = new Promise((resolve) => {
    finishCleanup = resolve;
  });
  let startedCleanup;
  const cleanupStarted = new Promise((resolve) => {
    startedCleanup = resolve;
  });
  const result = withWorkflowCleanup(
    async () => {
      events.push("workflow");
      return 42;
    },
    async () => {
      events.push("cleanup");
      startedCleanup();
      await closing;
    },
  ).then((value) => {
    events.push("settled");
    return value;
  });
  await cleanupStarted;
  assert.deepEqual(events, ["workflow", "cleanup"]);
  finishCleanup();
  assert.equal(await result, 42);
  assert.deepEqual(events, ["workflow", "cleanup", "settled"]);
});

test("a failed workflow still cleans up and retains its exact error", async () => {
  const original = new Error("Controlled workflow failure");
  let closed = false;
  await assert.rejects(
    withWorkflowCleanup(
      () => {
        throw original;
      },
      () => {
        closed = true;
      },
    ),
    (error) => {
      assert.equal(error, original);
      assert.equal(closed, true);
      return true;
    },
  );
});

test("cleanup alone can fail a successful workflow", async () => {
  const closure = new Error("Controlled closure failure");
  await assert.rejects(
    withWorkflowCleanup(
      () => 42,
      async () => {
        throw closure;
      },
    ),
    (error) => error === closure,
  );
});

test("combined failure preserves both causes without matching a negative case's error text", async () => {
  const original = new Error("Expected product refusal");
  const closure = new Error("Owned browser did not close");
  await assert.rejects(
    withWorkflowCleanup(
      async () => {
        throw original;
      },
      () => {
        throw closure;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [original, closure]);
      assert.equal(error.cause, original);
      assert.equal(error.message, "UI workflow cleanup failed");
      assert.doesNotMatch(error.message, /Expected product refusal/);
      return true;
    },
  );
});

test("throwing undefined is still failure and cannot suppress a cleanup failure", async () => {
  let cleaned = 0;
  const result = await withWorkflowCleanup(
    () => {
      throw undefined;
    },
    () => {
      cleaned++;
    },
  ).then(
    () => ({ passed: true }),
    (error) => ({ passed: false, error }),
  );
  assert.deepEqual(result, { passed: false, error: undefined });
  assert.equal(cleaned, 1);
  const closure = new Error("Controlled closure failure");
  await assert.rejects(
    withWorkflowCleanup(
      () => {
        throw undefined;
      },
      () => {
        throw closure;
      },
    ),
    (error) => {
      assert.deepEqual(error.errors, [undefined, closure]);
      return true;
    },
  );
});
