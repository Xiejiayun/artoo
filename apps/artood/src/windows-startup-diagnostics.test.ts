// Controlled startup observation only; diagnostics cannot authorize a process or readiness.
import { describe, expect, it } from "vitest";
import { withWindowsStartupDiagnostics, recordWindowsStartupPhase, recordWindowsStartupFailure, completeWindowsStartupDiagnostics,
  WindowsStartupDiagnosticSchema, type WindowsStartupDiagnostic } from "./windows-startup-diagnostics.js";
import { markWindowsNativeFailure, readWindowsNativeFailureCode, windowsNativeFailureDetail } from "./owned/windows-process-diagnostic.js";
import { markWindowsStorageFailure, readWindowsStorageFailure } from "./windows-storage-diagnostic.js";
describe("bounded safe startup diagnostics", () => {
  it("reports the failing phase and elapsed time without copying any exception or environment data", async () => {
    const events: WindowsStartupDiagnostic[] = [], secret = "provider-key-and-sensitive-path";
    await expect(withWindowsStartupDiagnostics(value => events.push(value), async () => {
      recordWindowsStartupPhase("git_installation"); throw Error(secret);
    })).rejects.toThrow(secret);
    expect(events.at(-1)).toMatchObject({ phase: "git_installation", status: "failed", error_code: "startup_stage_failed" });
    expect(events.every(value => WindowsStartupDiagnosticSchema.safeParse(value).success)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
  it("records failure before blocked cleanup and emits only one failure", async () => {
    const events: WindowsStartupDiagnostic[] = []; let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const work = withWindowsStartupDiagnostics(value => events.push(value), async () => {
      recordWindowsStartupPhase("source_activation"); recordWindowsStartupFailure(); await cleanup; throw Error("original failure");
    });
    expect(events.at(-1)).toMatchObject({ phase: "source_activation", status: "failed" });
    release(); await expect(work).rejects.toThrow("original failure"); expect(events.filter(value => value.status === "failed")).toHaveLength(1);
  });
  it("retains the specific native cause at the first failure before cleanup without projecting exception text", async () => {
    const events: WindowsStartupDiagnostic[] = [], secret = "provider-key-sensitive-path-and-argv";
    const native = markWindowsNativeFailure(new Error(secret), "native_timeout");
    const qualified = markWindowsNativeFailure(new Error("qualification wrapper", { cause: native }), "native_qualification_failed");
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const work = withWindowsStartupDiagnostics(value => events.push(value), async () => {
      recordWindowsStartupPhase("git_installation"); recordWindowsStartupFailure(qualified); await cleanup; throw qualified;
    });
    expect(events.at(-1)).toMatchObject({ phase: "git_installation", status: "failed", native_failure_code: "native_timeout" });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain("qualification wrapper");
    release(); await expect(work).rejects.toBe(qualified);
    expect(events.filter(value => value.status === "failed")).toHaveLength(1);
  });
  it("ignores copied failure fields and terminates cyclic cause inspection", async () => {
    const copied = Object.assign(new Error("native_timeout secret"), { native_failure_code: "native_timeout", failureCode: "native_timeout" });
    const events: WindowsStartupDiagnostic[] = [];
    await expect(withWindowsStartupDiagnostics(value => events.push(value), async () => { throw copied; })).rejects.toBe(copied);
    expect(events.at(-1)).not.toHaveProperty("native_failure_code");
    const cyclic = markWindowsNativeFailure(new Error("private message"), "native_protocol_failed");
    Object.defineProperty(cyclic, "cause", { value: cyclic });
    expect(readWindowsNativeFailureCode(cyclic)).toBe("native_protocol_failed");
    const deep = markWindowsNativeFailure(new Error("private leaf"), "native_timeout");
    let outer: Error = deep;
    for (let i = 0; i < 8; i++) outer = new Error("private wrapper", { cause: outer });
    expect(readWindowsNativeFailureCode(outer)).toBeUndefined();
  });
  it("projects optional native helper details from the same local failure without exposing exception content", async () => {
    const native = { version: 1, phase: "guardian_response_read", code: "operation_cancelled", nativeError: null };
    const detail = windowsNativeFailureDetail("guardian_client_sync", 2,
      Buffer.from(JSON.stringify({ version: 1, kind: "native_failure_diagnostic", payload: native }) + "\n"))!;
    const leaf = markWindowsNativeFailure(new Error("private-key-path-argv-and-environment"), "native_nonzero_exit", detail);
    const wrapper = markWindowsNativeFailure(new Error("private-wrapper", { cause: leaf }), "native_qualification_failed");
    const events: WindowsStartupDiagnostic[] = [];
    await expect(withWindowsStartupDiagnostics(value => events.push(value), async () => {
      recordWindowsStartupPhase("source_activation"); throw wrapper;
    })).rejects.toBe(wrapper);
    expect(events.at(-1)).toMatchObject({ status: "failed", native_failure_code: "native_nonzero_exit", native_failure_detail: detail });
    expect(events.slice(0, -1).every(value => value.native_failure_detail === undefined)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private-");
    const copied = Object.assign(new Error("private-copied"), { native_failure_code: "native_nonzero_exit", native_failure_detail: detail });
    const copiedEvents: WindowsStartupDiagnostic[] = [];
    await expect(withWindowsStartupDiagnostics(value => copiedEvents.push(value), async () => { throw copied; })).rejects.toBe(copied);
    expect(copiedEvents.at(-1)).not.toHaveProperty("native_failure_code");
    expect(copiedEvents.at(-1)).not.toHaveProperty("native_failure_detail");
  });
  it("keeps old startup payloads valid and rejects detail outside a failed native stage", () => {
    const failed = { version: 1, phase: "source_activation", status: "failed", elapsed_ms: 10, phase_elapsed_ms: 5,
      error_code: "startup_stage_failed", native_failure_code: "native_nonzero_exit" };
    const detail = windowsNativeFailureDetail("guardian_client_sync", 2, Buffer.alloc(0))!;
    expect(WindowsStartupDiagnosticSchema.safeParse(failed).success).toBe(true);
    expect(WindowsStartupDiagnosticSchema.safeParse({ ...failed, native_failure_detail: detail }).success).toBe(true);
    for (const change of [{ native_failure_code: undefined }, { status: "entered", error_code: undefined },
      { native_failure_detail: { ...detail, argv: "private-secret" } },
      { native_failure_detail: { ...detail, helper_mode: "private-secret" } },
      { native_failure_detail: { ...detail, stderr_status: "accepted", native_diagnostics: [{ version: 1,
        phase: "guardian_response_read", code: "private-secret", nativeError: null }] } }])
      expect(WindowsStartupDiagnosticSchema.safeParse({ ...failed, native_failure_detail: detail, ...change }).success).toBe(false);
  });
  it("does not evaluate cause accessors or let hostile unknown failures replace the original rejection", async () => {
    const project = async (failure: unknown) => {
      const events: WindowsStartupDiagnostic[] = []; let original = false;
      try { await withWindowsStartupDiagnostics(value => events.push(value), async () => { throw failure; }); }
      catch (caught) { original = Object.is(caught, failure); }
      expect(original).toBe(true); expect(events.at(-1)?.status).toBe("failed");
      return events.at(-1)!;
    };
    let causeReads = 0, prototypeReads = 0;
    const accessor = markWindowsNativeFailure(new Error("private-accessor-error"), "native_qualification_failed");
    Object.defineProperty(accessor, "cause", { get() { causeReads++; throw new Error("private-getter-error"); } });
    expect(await project(accessor)).toHaveProperty("native_failure_code", "native_qualification_failed");
    const inherited = Object.create({ get cause() { causeReads++; throw new Error("private-inherited-error"); } });
    expect(await project(inherited)).not.toHaveProperty("native_failure_code");
    const hostilePrototype = new Proxy({}, { getPrototypeOf() { prototypeReads++; throw new Error("private-prototype-error"); } });
    expect(await project(hostilePrototype)).not.toHaveProperty("native_failure_code");
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    expect(await project(revoked.proxy)).not.toHaveProperty("native_failure_code");
    const descriptorTrap = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("private-descriptor-error"); } });
    const wrapper = markWindowsNativeFailure(new Error("private-wrapper", { cause: descriptorTrap }), "native_qualification_failed");
    expect(await project(wrapper)).toHaveProperty("native_failure_code", "native_qualification_failed");
    expect(causeReads).toBe(0); expect(prototypeReads).toBe(0);
  });
  it("keeps independent async startup scopes separate and disables later runtime messages", async () => {
    const first: WindowsStartupDiagnostic[] = [], second: WindowsStartupDiagnostic[] = [];
    await Promise.all([
      withWindowsStartupDiagnostics(value => first.push(value), async () => { await Promise.resolve(); recordWindowsStartupPhase("git_installation"); completeWindowsStartupDiagnostics(); recordWindowsStartupPhase("source_activation"); }),
      withWindowsStartupDiagnostics(value => second.push(value), async () => { recordWindowsStartupPhase("source_storage"); await Promise.resolve(); completeWindowsStartupDiagnostics(); }),
    ]);
    recordWindowsStartupPhase("load_configuration"); recordWindowsStartupFailure();
    expect(first.map(value => value.phase)).not.toContain("source_storage");
    expect(second.map(value => value.phase)).not.toContain("git_installation");
    expect(first.at(-1)).toMatchObject({ phase: "git_installation", status: "completed" });
  });
  it("retains the first local storage failure on the same frozen error without modifying it", async () => {
    const events: WindowsStartupDiagnostic[] = [], original = Object.freeze(new Error("private-storage-path"));
    expect(markWindowsStorageFailure(original, "storage_inventory_changed", ["ctime", "size"])).toBe(original);
    expect(markWindowsStorageFailure(original, "filesystem_observation_failed")).toBe(original);
    const pending = withWindowsStartupDiagnostics(value => events.push(value), async () => {
      recordWindowsStartupPhase("source_store_audit"); recordWindowsStartupFailure(original);
      recordWindowsStartupPhase("source_retained_destinations");
      recordWindowsStartupFailure(markWindowsStorageFailure(new Error("private-later-error"), "acl_collector_failed"));
      throw original;
    });
    await expect(pending).rejects.toBe(original);
    expect(events.filter(value => value.status === "failed")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ phase: "source_store_audit",
      storage_failure: { code: "storage_inventory_changed", first_change_fields: ["ctime", "size"] } });
    expect(JSON.stringify(events)).not.toContain("private-");
    expect(Object.isFrozen(readWindowsStorageFailure(original))).toBe(true);
    expect(Object.isFrozen(readWindowsStorageFailure(original)?.first_change_fields)).toBe(true);
  });
  it("never obtains storage labels from copied fields, prototypes or a branded cause and preserves unknown throws", async () => {
    const tagged = markWindowsStorageFailure(new Error("private-leaf"), "storage_acl_rejected");
    const copied = Object.assign(new Error("private-copied"), { storage_failure: { code: "storage_acl_rejected" }, code: "storage_acl_rejected" });
    let propertyReads = 0;
    const accessor = Object.defineProperty(new Error("private-accessor"), "storage_failure", { get() { propertyReads++; throw Error("private-getter"); } });
    const inherited = Object.create({ get storage_failure() { propertyReads++; throw Error("private-prototype"); } });
    const cyclic = Object.assign(new Error("private-cycle"), { cause: tagged }); Object.defineProperty(cyclic, "cause", { value: cyclic });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    let deep: Error = tagged;
    for (let i = 0; i < 10; i++) deep = new Error("private-wrapper", { cause: deep });
    for (const failure of [copied, accessor, inherited, new Error("private-wrapper", { cause: tagged }), cyclic, deep, revoked.proxy, null, undefined, "private-primitive", 17]) {
      const events: WindowsStartupDiagnostic[] = []; let same = false;
      try { await withWindowsStartupDiagnostics(value => events.push(value), async () => { throw failure; }); }
      catch (caught) { same = Object.is(caught, failure); }
      expect(same).toBe(true); expect(events.at(-1)?.status).toBe("failed");
      expect(events.at(-1)).not.toHaveProperty("storage_failure"); expect(readWindowsStorageFailure(failure)).toBeUndefined();
    }
    expect(propertyReads).toBe(0);
  });
  it("accepts old events and rejects non-failure storage labels and arbitrary or inconsistent detail", () => {
    const failed = { version: 1, phase: "source_store_audit", status: "failed", elapsed_ms: 10, phase_elapsed_ms: 5,
      error_code: "startup_stage_failed" };
    expect(WindowsStartupDiagnosticSchema.safeParse(failed).success).toBe(true);
    expect(WindowsStartupDiagnosticSchema.safeParse({ ...failed, storage_failure: { code: "storage_inventory_changed", first_change_fields: ["ctime"] } }).success).toBe(true);
    for (const storage_failure of [{ code: "private-code" }, { code: "storage_acl_rejected", path: "private-path" },
      { code: "storage_acl_rejected", first_change_fields: ["ctime"] }, { code: "storage_inventory_changed", first_change_fields: [] },
      { code: "storage_inventory_changed", first_change_fields: ["ctime", "ctime"] }, { code: "storage_inventory_changed", first_change_fields: ["private-field"] }])
      expect(WindowsStartupDiagnosticSchema.safeParse({ ...failed, storage_failure }).success).toBe(false);
    for (const status of ["entered", "completed"])
      expect(WindowsStartupDiagnosticSchema.safeParse({ ...failed, status, error_code: undefined, storage_failure: { code: "storage_acl_rejected" } }).success).toBe(false);
  });
  it("distinguishes retained-destination failures from the completed store audit without inventing a storage label", async () => {
    const events: WindowsStartupDiagnostic[] = [], original = new Error("private-journal-error");
    await expect(withWindowsStartupDiagnostics(value => events.push(value), async () => {
      recordWindowsStartupPhase("source_store_audit"); recordWindowsStartupPhase("source_retained_destinations"); throw original;
    })).rejects.toBe(original);
    expect(events).toContainEqual(expect.objectContaining({ phase: "source_store_audit", status: "completed" }));
    expect(events.at(-1)).toMatchObject({ phase: "source_retained_destinations", status: "failed" });
    expect(events.at(-1)).not.toHaveProperty("storage_failure");
  });
  it("bounds event volume and rejects arbitrary phase, code and metadata fields", async () => {
    const events: WindowsStartupDiagnostic[] = [];
    await withWindowsStartupDiagnostics(value => events.push(value), async () => { for (let i = 0; i < 100; i++) recordWindowsStartupPhase("source_storage"); });
    expect(events).toHaveLength(64);
    const valid = { version: 1, phase: "git_installation", status: "failed", elapsed_ms: 12, phase_elapsed_ms: 7, error_code: "startup_stage_failed" };
    for (const changed of [{ ...valid, phase: "secret" }, { ...valid, error_code: "secret" }, { ...valid, stderr: "secret" },
      { ...valid, elapsed_ms: -1 }, { ...valid, phase_elapsed_ms: 86_400_001 }, { ...valid, status: "entered" },
      { ...valid, native_failure_code: "secret" },
      { ...valid, status: "entered", error_code: undefined, native_failure_code: "native_timeout" }])
      expect(WindowsStartupDiagnosticSchema.safeParse(changed).success).toBe(false);
    expect(WindowsStartupDiagnosticSchema.safeParse({ ...valid, native_failure_code: "native_timeout" }).success).toBe(true);
  });
});
