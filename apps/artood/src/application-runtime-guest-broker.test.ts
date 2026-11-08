import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApplicationBrokerControl, type ApplicationBrokerConfiguration, type ApplicationBrokerReply } from "./application-broker-control.js";
import { createApplicationRuntimeGuest, type ApplicationRuntimeGuestHandler } from "./application-runtime-guest.js";
import { ApplicationWireDecoder, ApplicationWireEncoder, type ApplicationWireResponse } from "./application-wire-v1.js";

const controls: ApplicationBrokerControl[] = [], directories: string[] = [];
afterEach(context => {
  const failures: unknown[] = [];
  for (const control of controls.splice(0)) { try { control.dispose(); } catch (error) { failures.push(error); } }
  const stores = directories.splice(0);
  if (failures.length) throw new AggregateError(failures, "Original broker closure failed; stores retained");
  if (context.task.result?.state !== "pass" || context.signal.aborted) return;
  for (const directory of stores) {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir())); expect(basename(directory)).toMatch(/^artoo-guest-broker-/u);
    rmSync(directory, { recursive: true, force: true });
  }
});

// Developer-authored handler + actual wire/control/SQLite in one Node test process.
// No generated source is evaluated in Node; this is not isolated product qualification.
const handler: ApplicationRuntimeGuestHandler = async (request, context): Promise<ApplicationWireResponse> => {
  try {
    const reply = await context.data.execute(request.body);
    return { status: 200, body: { kind: reply.result.kind, replayed: reply.replayed,
      rows: reply.result.kind === "read" ? reply.result.rows : [] } };
  } catch (error) { return { status: 409, body: { code: (error as { code: string }).code } }; }
};
function session(configuration: ApplicationBrokerConfiguration) {
  const broker = new ApplicationBrokerControl(configuration); controls.push(broker);
  const guest = createApplicationRuntimeGuest(handler), outbound = new ApplicationWireEncoder("application-to-host"),
    inbound = new ApplicationWireDecoder("host-to-application");
  let sequence = 0, invocation = 0;
  const command = (fields: object) => broker.accept({ version: 1, sequence: sequence++, ...fields });
  const feed = (reply: ApplicationBrokerReply) => {
    for (const frame of reply.frames) {
      const bytes = Buffer.from(frame, "base64");
      for (let offset = 0; offset < bytes.length; offset += 65_536) {
        for (const envelope of inbound.push(bytes.subarray(offset, offset + 65_536))) {
          const { version: _version, sequence: _sequence, ...message } = envelope;
          guest.receive(JSON.stringify(message));
        }
      }
    }
  };
  return {
    async invoke(body: unknown, purpose: "application" | "health" | "peer" = "application") {
      const original = "host-" + (++invocation);
      feed(command({ kind: "begin", invocation: original, purpose, access: configuration.maximumAccess,
        lifetimeMs: 30_000, requestJson: JSON.stringify({ request_id: original, method: "POST", path: "/items", query: {}, body }) }));
      for (let turn = 0; turn < 100; turn++) {
        await Promise.resolve();
        for (const text of guest.drain()) {
          const bytes = outbound.encode(text);
          for (let offset = 0; offset < bytes.length; offset += 65_536) {
            const reply = command({ kind: "receive", data: bytes.subarray(offset, offset + 65_536).toString("base64") });
            feed(reply);
            if (reply.responses.length) {
              expect(reply.responses).toHaveLength(1); expect(reply.responses[0]!.invocation).toBe(original);
              return reply.responses[0]!.response;
            }
          }
        }
      }
      throw Error("Controlled guest/broker exchange did not settle");
    },
    stop() { feed(command({ kind: "shutdown" })); expect(guest.status).toBe("shutdown"); inbound.finish(); },
  };
}
const read = { version: 1, kind: "read", query: { kind: "query", table: "items", columns: ["id", "revision", "title"], limit: 10 } };
const transaction = (key: string, operation: object) => ({ version: 1, kind: "transaction", idempotency_key: key, operations: [operation] });

describe("portable guest connected to the existing actual SQLite broker", () => {
  it("preserves CRUD, CAS conflict, durable replay and reopen, with a separate read-only health/peer session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "artoo-guest-broker-")); directories.push(directory);
    const config: ApplicationBrokerConfiguration = { version: 1, protocol: "artoo.application-broker.v1", mode: "create",
      databasePath: join(directory, "store.sqlite"), maximumAccess: "write",
      schemaJson: JSON.stringify({ version: 1, tables: [{ name: "items", columns: [{ name: "title", type: "text", nullable: false, max_bytes: 4096 }] }] }),
      scope: { product_id: "notes", data_generation: "first", service_generation: 1, artifact_digest: `sha256:${"a".repeat(64)}` } };
    const write = session(config);
    const insert = transaction("insert-1", { kind: "insert", table: "items", id: "one", values: { title: "笔记 📚" } });
    expect(await write.invoke(insert)).toMatchObject({ status: 200, body: { kind: "committed", replayed: false } });
    expect(await write.invoke({ sql: "unsupported generated text" })).toEqual({ status: 409, body: { code: "invalid-request" } });
    expect(await write.invoke(read)).toMatchObject({ body: { rows: [{ id: "one", revision: 1, title: "笔记 📚" }] } });
    expect(await write.invoke(transaction("wrong-revision", { kind: "compare-and-set", table: "items", id: "one", expected_revision: 2,
      values: { title: "wrong" } }))).toMatchObject({ body: { kind: "conflict" } });
    expect(await write.invoke(transaction("update-1", { kind: "compare-and-set", table: "items", id: "one", expected_revision: 1,
      values: { title: "updated" } }))).toMatchObject({ body: { kind: "committed" } });
    write.stop();

    const reopened = session({ ...config, mode: "open" });
    expect(await reopened.invoke(insert)).toMatchObject({ body: { kind: "committed", replayed: true } });
    expect(await reopened.invoke(read)).toMatchObject({ body: { rows: [{ id: "one", revision: 2, title: "updated" }] } });
    reopened.stop();

    const health = session({ ...config, mode: "open", maximumAccess: "read" });
    expect(await health.invoke(transaction("forbidden", { kind: "insert", table: "items", id: "forbidden", values: { title: "forbidden" } }), "health"))
      .toEqual({ status: 409, body: { code: "unauthorized" } });
    expect(await health.invoke(read, "peer")).toMatchObject({ body: { rows: [{ id: "one", revision: 2, title: "updated" }] } });
    health.stop();

    const final = session({ ...config, mode: "open" });
    expect(await final.invoke(transaction("delete-1", { kind: "delete", table: "items", id: "one", expected_revision: 2 })))
      .toMatchObject({ body: { kind: "committed" } });
    expect(await final.invoke(read)).toMatchObject({ body: { rows: [] } }); final.stop();
  });
});
