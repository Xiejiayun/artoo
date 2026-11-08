import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSourceCommandDiagnostics, observeSourceCommandPhase, recordSourceCommandFailure, recordSourceCommandPhase, recordSourceObserverTiming,
  SourceCommandDiagnosticSchema, SOURCE_COMMAND_DIAGNOSTIC_LIMITS, type SourceCommandDiagnostic, type SourceCommandPhase } from "./source-command-diagnostics.js";
import { markWindowsNativeFailure, windowsNativeFailureDetail } from "./owned/windows-process-diagnostic.js";
import { markWindowsStorageFailure } from "./windows-storage-diagnostic.js";

const command = (id = "private-delivery-id", type = "product.source.review.v1") => ({ id, type });
const hash = (id: string) => `sha256:${createHash("sha256").update(id).digest("hex")}`;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const timing = () => ({ epochId: "00000000-0000-4000-8000-000000000001", slotId: "00000000-0000-4000-8000-000000000002",
  elapsedMs: 12.75, cleanupConfirmed: true });

describe("bounded source command diagnostics", () => {
  it("correlates an inclusive observer receipt without completing its parent phase or copying private fields", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    const privateInput = { ...timing(), cleanupConfirmed: false, ticket: "private-ticket", argv: ["private-command"], stdout: "private-output" };
    await expect(diagnostics.run(command(), () => {
      recordSourceCommandPhase("runtime"); recordSourceObserverTiming(privateInput);
      expect(rows.at(-1)).toMatchObject({ phase: "runtime", status: "observed", observer_timing: {
        version: 1, scope: "startWindowsGuardianObserverSync.inclusive.v1", epoch_id: privateInput.epochId,
        slot_id: privateInput.slotId, elapsed_ms: 12, cleanup_confirmed: false } });
      recordSourceCommandPhase("request"); return 17;
    })).resolves.toBe(17);
    expect(rows.filter(row => row.phase === "runtime").map(row => row.status)).toEqual(["entered", "observed", "completed"]);
    expect(rows.at(-1)).toMatchObject({ phase: "request", status: "completed" });
    expect(rows.every(row => SourceCommandDiagnosticSchema.safeParse(row).success)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("private-");
    expect(Object.isFrozen(rows.find(row => row.observer_timing)?.observer_timing)).toBe(true);
  });

  it("drops absent-scope, repeated-command and malformed timings without skipping actual work", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    recordSourceObserverTiming(timing());
    let calls = 0;
    const work = () => { calls++; recordSourceObserverTiming(timing()); return 23; };
    await diagnostics.run(command("manual", "run.start"), work);
    await diagnostics.run(command("observed"), work); await diagnostics.run(command("observed"), work);
    await diagnostics.run(command("invalid"), () => {
      for (const elapsedMs of [NaN, Infinity, -0.1, 86_400_001]) recordSourceObserverTiming({ ...timing(), elapsedMs });
      recordSourceObserverTiming({ ...timing(), slotId: "private-path" });
      recordSourceObserverTiming({ ...timing(), epochId: "private-epoch" });
    });
    expect(calls).toBe(3); expect(rows.filter(row => row.status === "observed")).toHaveLength(1);
  });

  it("caps observer samples inside existing normal budgets while preserving subsequent phases and first failure", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    const limits = SOURCE_COMMAND_DIAGNOSTIC_LIMITS, original = Error("private-original");
    for (let index = 0; index < limits.observerTimings / limits.observerTimingsPerCommand + 2; index++) {
      await diagnostics.run(command(`observers-${index}`), () => {
        for (let sample = 0; sample < limits.observerTimingsPerCommand + 3; sample++) recordSourceObserverTiming(timing());
        recordSourceCommandPhase("result_binding");
      });
    }
    expect(rows.filter(row => row.status === "observed")).toHaveLength(limits.observerTimings);
    expect(rows.filter(row => row.command_id_digest === hash("observers-0") && row.status === "observed")).toHaveLength(limits.observerTimingsPerCommand);
    expect(rows.filter(row => row.status !== "failed").length).toBeLessThanOrEqual(limits.normalEvents);
    await expect(diagnostics.run(command("after-observer-cap"), () => {
      recordSourceObserverTiming(timing()); recordSourceCommandPhase("runtime"); throw original;
    })).rejects.toBe(original);
    expect(rows.at(-1)).toMatchObject({ phase: "runtime", status: "failed" });
  });

  it("does not await timing sinks or replace the original result or error when their observation fails", async () => {
    const original = Error("private-original"), pending = deferred();
    for (const sink of [() => { throw Error("private-sink"); }, () => Promise.reject(Error("private-rejection")), () => pending.promise]) {
      const diagnostics = createSourceCommandDiagnostics(row => row.status === "observed" ? sink() : undefined);
      await expect(diagnostics.run(command("success"), () => { recordSourceObserverTiming(timing()); return 29; })).resolves.toBe(29);
      await expect(diagnostics.run(command("failure"), () => { recordSourceObserverTiming({ ...timing(), cleanupConfirmed: false }); throw original; })).rejects.toBe(original);
    }
    pending.resolve(); await Promise.resolve();
  });

  it("accepts timing only on an explicit observation and rejects unbounded or free-text timing metadata", () => {
    const input = timing(), valid = { version: 1, command_type: command().type, command_id_digest: hash(command().id),
      phase: "runtime", status: "observed", elapsed_ms: 20, phase_elapsed_ms: 10, observer_timing: {
        version: 1, scope: "startWindowsGuardianObserverSync.inclusive.v1", epoch_id: input.epochId,
        slot_id: input.slotId, elapsed_ms: 12, cleanup_confirmed: true } };
    expect(SourceCommandDiagnosticSchema.safeParse(valid).success).toBe(true);
    for (const change of [{ status: "completed" }, { observer_timing: undefined }, { error_code: "source_command_stage_failed" }])
      expect(SourceCommandDiagnosticSchema.safeParse({ ...valid, ...change }).success).toBe(false);
    for (const change of [{ scope: "powershell_duration" }, { elapsed_ms: NaN }, { elapsed_ms: -1 }, { elapsed_ms: 86_400_001 },
      { slot_id: "private-path" }, { epoch_id: "private-epoch" }, { ticket: "private-ticket" }, { cleanup_confirmed: "true" }])
      expect(SourceCommandDiagnosticSchema.safeParse({ ...valid, observer_timing: { ...valid.observer_timing, ...change } }).success).toBe(false);
  });

  it("retains the original rejection and reports its phase without inspecting or exposing command content", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    let payloadReads = 0;
    const input = Object.defineProperty(command(), "payload", { get() { payloadReads++; throw Error("private-payload"); } });
    const original = Object.freeze(new Error("private-key-path-argv-and-provider-output"));
    await expect(diagnostics.run(input, () => {
      recordSourceCommandPhase("dispatch_admission"); recordSourceCommandPhase("result_binding"); throw original;
    })).rejects.toBe(original);
    expect(rows.at(-1)).toMatchObject({ version: 1, command_type: input.type, command_id_digest: hash(input.id),
      phase: "result_binding", status: "failed", error_code: "source_command_stage_failed" });
    expect(rows.every(row => SourceCommandDiagnosticSchema.safeParse(row).success)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("private-"); expect(payloadReads).toBe(0);
  });

  it("preserves synchronous nested returns and throws and attributes an async failure to the innermost phase", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    const returned = {}, syncFailure = new Error("private-sync"); let calls = 0;
    await diagnostics.run(command("sync"), () => {
      const observed = observeSourceCommandPhase("adapter", () => { calls++; return returned; });
      expect(observed).toBe(returned); expect(calls).toBe(1);
      try { observeSourceCommandPhase("reservation", () => { throw syncFailure; }); }
      catch (error) { expect(error).toBe(syncFailure); }
    });
    expect(rows.filter(row => row.status === "failed")).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({ phase: "reservation", status: "failed" });
    const failure = new Error("private-async");
    await expect(diagnostics.run(command("async"), () => observeSourceCommandPhase("handler", async () => {
      await Promise.resolve();
      return observeSourceCommandPhase("acknowledgement", async () => { await Promise.resolve(); throw failure; });
    }))).rejects.toBe(failure);
    expect(rows.filter(row => row.command_id_digest === hash("async") && row.status === "failed")).toHaveLength(1);
    expect(rows.at(-1)).toMatchObject({ phase: "acknowledgement", status: "failed" });
  });

  it("keeps concurrent async command phases separate and ends their diagnostic lifetime when work settles", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    const gate = deferred(), late = deferred(); let lateWork!: Promise<void>;
    const first = diagnostics.run(command("first"), async () => {
      recordSourceCommandPhase("before_verification"); await gate.promise;
      lateWork = late.promise.then(() => recordSourceCommandPhase("after_verification"));
      return "first result";
    });
    const second = diagnostics.run(command("second"), async () => {
      recordSourceCommandPhase("reviewer"); await Promise.resolve(); return "second result";
    });
    await expect(second).resolves.toBe("second result"); gate.resolve(); await expect(first).resolves.toBe("first result");
    const count = rows.length; late.resolve(); await lateWork;
    recordSourceCommandPhase("dispatch_scope"); recordSourceCommandFailure(Error("private-outside"));
    expect(rows).toHaveLength(count);
    expect(rows.filter(row => row.command_id_digest === hash("first")).map(row => row.phase)).not.toContain("reviewer");
    expect(rows.filter(row => row.command_id_digest === hash("second")).map(row => row.phase)).not.toContain("before_verification");
  });

  it("does not inspect arbitrary synchronous return objects or add an await to a synchronous observed phase", async () => {
    const diagnostics = createSourceCommandDiagnostics(() => {}); let thenReads = 0;
    const value = Object.defineProperty({}, "then", { get() { thenReads++; throw Error("private-then"); } });
    await diagnostics.run(command(), () => {
      expect(observeSourceCommandPhase("request", () => value)).toBe(value); expect(thenReads).toBe(0);
    });
    expect(observeSourceCommandPhase("request", () => 42)).toBe(42);
  });

  it("logs regular states only on the first attempt for a type and ID without skipping actual work", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    const work = vi.fn(() => { recordSourceCommandPhase("handler"); return 7; });
    await expect(diagnostics.run(command(), work)).resolves.toBe(7);
    const count = rows.length;
    for (let index = 0; index < 100; index++) await expect(diagnostics.run(command(), work)).resolves.toBe(7);
    expect(rows).toHaveLength(count); expect(work).toHaveBeenCalledTimes(101);
    const failure = Error("private-late-rejection");
    for (let index = 0; index < 3; index++) await expect(diagnostics.run(command(), () => { throw failure; })).rejects.toBe(failure);
    expect(rows.filter(row => row.status === "failed")).toHaveLength(1);
  });

  it("retains separate first-attempt and failure observations for a receipt that shares its start ID", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    const failure = Error("private-original"), id = "shared-delivery";
    for (const type of ["product.source.operation.v1", "product.source.operation.receipt.v1"]) {
      for (let attempt = 0; attempt < 2; attempt++) await expect(diagnostics.run(command(id, type), () => {
        recordSourceCommandPhase(type.endsWith("receipt.v1") ? "result_binding" : "reservation"); throw failure;
      })).rejects.toBe(failure);
    }
    expect(rows.filter(row => row.status === "failed").map(row => [row.command_type, row.phase])).toEqual([
      ["product.source.operation.v1", "reservation"], ["product.source.operation.receipt.v1", "result_binding"],
    ]);
    expect(rows.filter(row => row.status === "entered" && row.phase === "result_binding")).toHaveLength(1);
    expect(rows.every(row => row.command_id_digest === hash(id))).toBe(true);
  });

  it("reserves first-failure capacity after regular output is exhausted and bounds the complete instance", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    for (let index = 0; index < SOURCE_COMMAND_DIAGNOSTIC_LIMITS.normalEvents; index++) await diagnostics.run(command(`complete-${index}`), () => {});
    expect(rows).toHaveLength(SOURCE_COMMAND_DIAGNOSTIC_LIMITS.normalEvents);
    const failure = Error("private-original");
    for (let index = 0; index < SOURCE_COMMAND_DIAGNOSTIC_LIMITS.failureEvents + 10; index++) {
      await expect(diagnostics.run(command(`failed-${index}`), () => { recordSourceCommandPhase("runtime"); throw failure; })).rejects.toBe(failure);
    }
    expect(rows.filter(row => row.status === "failed")).toHaveLength(SOURCE_COMMAND_DIAGNOSTIC_LIMITS.failureEvents);
    expect(rows).toHaveLength(SOURCE_COMMAND_DIAGNOSTIC_LIMITS.normalEvents + SOURCE_COMMAND_DIAGNOSTIC_LIMITS.failureEvents);
    expect(rows.at(-1)).toMatchObject({ phase: "runtime", status: "failed" });
    const other: SourceCommandDiagnostic[] = [];
    await createSourceCommandDiagnostics(row => other.push(row)).run(command("complete-0"), () => {});
    expect(other).toHaveLength(2);
  });

  it("bounds one command while recording its first failure immediately before blocked cleanup", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    const cleanup = deferred(), original = Error("private-original");
    const pending = diagnostics.run(command(), async () => {
      for (let index = 0; index < 100; index++) recordSourceCommandPhase(index % 2 ? "session" : "handler");
      recordSourceCommandPhase("persist_result"); recordSourceCommandFailure(original);
      recordSourceCommandPhase("emit_result"); await cleanup.promise; throw original;
    });
    expect(rows.filter(row => row.status !== "failed")).toHaveLength(SOURCE_COMMAND_DIAGNOSTIC_LIMITS.normalEventsPerCommand);
    expect(rows.at(-1)).toMatchObject({ phase: "persist_result", status: "failed" });
    cleanup.resolve(); await expect(pending).rejects.toBe(original);
    expect(rows.filter(row => row.status === "failed")).toHaveLength(1);
  });

  it("ignores throwing, rejected and pending sinks without replacing results or the original failure", async () => {
    const original = Error("private-work-failure"), pending = deferred();
    const sinks = [() => { throw Error("private-sink-failure"); }, () => Promise.reject(Error("private-sink-rejection")), () => pending.promise];
    for (const sink of sinks) {
      const diagnostics = createSourceCommandDiagnostics(sink), work = vi.fn(() => 19);
      await expect(diagnostics.run(command("success"), work)).resolves.toBe(19); expect(work).toHaveBeenCalledTimes(1);
      await expect(diagnostics.run(command("failure"), () => observeSourceCommandPhase("request", () => { throw original; }))).rejects.toBe(original);
    }
    pending.resolve(); await Promise.resolve();
  });

  it("projects only existing local native/storage classifications and never trusts copied fields or error accessors", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    const detail = windowsNativeFailureDetail("guardian_client_sync", 2, Buffer.alloc(0))!;
    const original = markWindowsStorageFailure(markWindowsNativeFailure(new Error("private-native-path"), "native_timeout", detail),
      "storage_inventory_changed", ["ctime", "size"]);
    await expect(diagnostics.run(command("tagged"), () => { throw original; })).rejects.toBe(original);
    expect(rows.at(-1)).toMatchObject({ native_failure_code: "native_timeout", native_failure_detail: detail,
      storage_failure: { code: "storage_inventory_changed", first_change_fields: ["ctime", "size"] } });
    let getters = 0;
    const copied = Object.assign(new Error("private-copied"), { native_failure_code: "native_timeout", storage_failure: { code: "storage_acl_rejected" } });
    Object.defineProperty(copied, "cause", { get() { getters++; throw Error("private-cause"); } });
    await expect(diagnostics.run(command("copied"), () => { throw copied; })).rejects.toBe(copied);
    expect(rows.at(-1)).not.toHaveProperty("native_failure_code"); expect(rows.at(-1)).not.toHaveProperty("storage_failure");
    expect(getters).toBe(0); expect(JSON.stringify(rows)).not.toContain("private-");
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    let caught: unknown;
    try { await diagnostics.run(command("proxy"), () => { throw revoked.proxy; }); } catch (error) { caught = error; }
    expect(caught).toBe(revoked.proxy); expect(rows.at(-1)).toMatchObject({ status: "failed" });
  });

  it("cannot let unsupported metadata or arbitrary phase labels stop or authorize the real work", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    let reads = 0;
    const accessor = Object.defineProperty(command(), "id", { get() { reads++; throw Error("private-id-getter"); } });
    for (const input of [command("private", "private-unsupported-type"), command("x".repeat(129)), accessor]) {
      const work = vi.fn(() => 23); await expect(diagnostics.run(input, work)).resolves.toBe(23); expect(work).toHaveBeenCalledTimes(1);
    }
    expect(rows).toHaveLength(0); expect(reads).toBe(0);
    await diagnostics.run(command(), () => {
      recordSourceCommandPhase("private-phase" as SourceCommandPhase);
      expect(observeSourceCommandPhase("private-phase" as SourceCommandPhase, () => 24)).toBe(24);
    });
    expect(rows.map(row => row.phase)).toEqual(["dispatch", "dispatch"]);
  });

  it("isolates reentrant non-source work from an outer source command's phase and failure state", async () => {
    const rows: SourceCommandDiagnostic[] = [], diagnostics = createSourceCommandDiagnostics(row => rows.push(row));
    await diagnostics.run(command("source"), async () => {
      recordSourceCommandPhase("handler");
      await expect(diagnostics.run(command("manual", "run.start"), async () => {
        recordSourceCommandPhase("runtime");
        await Promise.resolve();
        recordSourceCommandPhase("reviewer"); recordSourceCommandFailure(Error("private-manual-failure"));
        return 37;
      })).resolves.toBe(37);
      recordSourceCommandPhase("reservation");
    });
    expect(rows.filter(row => row.status === "entered").map(row => row.phase)).toEqual(["dispatch", "handler", "reservation"]);
    expect(rows.every(row => row.command_id_digest === hash("source") && row.status !== "failed")).toBe(true);
    expect(rows.at(-1)).toMatchObject({ phase: "reservation", status: "completed" });
  });

  it("rejects free text and inconsistent diagnostic classifications at the serialization boundary", () => {
    const valid = { version: 1, command_type: "product.source.review.v1", command_id_digest: hash("private"),
      phase: "request", status: "failed", elapsed_ms: 10, phase_elapsed_ms: 5, error_code: "source_command_stage_failed" };
    expect(SourceCommandDiagnosticSchema.safeParse(valid).success).toBe(true);
    for (const change of [{ message: "private-error" }, { argv: ["private-command"] }, { command_id: "private-id" },
      { command_type: "private-type" }, { command_id_digest: "private-id" }, { phase: "private-phase" }, { elapsed_ms: -1 },
      { phase_elapsed_ms: 86_400_001 }, { error_code: "private-code" }, { status: "completed" }, { native_failure_code: "private-code" },
      { storage_failure: { code: "storage_acl_rejected", path: "private-path" } },
      { native_failure_detail: windowsNativeFailureDetail("guardian_client_sync", 2, Buffer.alloc(0)) }])
      expect(SourceCommandDiagnosticSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});
