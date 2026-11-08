import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatBrowserFailure, markBrowserFailure } from "./browser-failure-diagnostic.js";

const profile = "C:\\Users\\controlled-user\\.artoo\\native-development\\product-release-retry-native\\control\\temporary\\artoo-verification-context-123456\\artoo-owned-browser-ABCDEF";
const facts = { profile_path: profile, process_close_observed: true, close_checks_completed: true };
const summary = (output: string) => JSON.parse(output.trimEnd().split("\n").at(-1)!.slice("browser_failure_summary ".length));
const detail = (output: string) => JSON.parse(output.split("\n")[0]!);
// Test fixtures opt into an already materialized string. Assignment can retain
// Node 26's native stack accessor, which the formatter intentionally never calls.
function dataStack<T extends Error>(error: T, stack: string): T {
  return Object.defineProperty(error, "stack", { value: stack, configurable: true, writable: true });
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("bounded browser failure diagnostics (no browser process execution)", () => {
  it("keeps the original frozen OS error and its first operation phase", () => {
    const source = Object.assign(new Error("Permission denied"), { code: "EPERM", errno: -4048, syscall: "rmdir", path: profile });
    const error = Object.freeze(dataStack(source, source.stack!));
    expect(markBrowserFailure(error, "profile-remove", facts)).toBe(error);
    expect(markBrowserFailure(error, "browser-launch", { ...facts, close_checks_completed: false })).toBe(error);
    const output = formatBrowserFailure(error);
    expect(summary(output)).toMatchObject({ phase: "profile-remove", code: "EPERM", errno: -4048, syscall: "rmdir", ...facts });
    expect(detail(output).errors[0]).toMatchObject({ path: profile, message: error.message });
    expect(detail(output).errors[0].stack).toContain("Error: Permission denied");
    expect(detail(output).errors[0].stack_accessor_omitted).toBe(false);
    expect(Object.getOwnPropertyNames(error)).not.toContain("phase");
  });
  it("retains a real frozen filesystem error and explicitly reports a native lazy stack omission", () => {
    const missing = join(tmpdir(), `artoo-browser-diagnostic-${randomUUID()}`, "missing");
    let caught: unknown;
    try { readFileSync(missing); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    const error = Object.freeze(caught as NodeJS.ErrnoException);
    const stack = Object.getOwnPropertyDescriptor(error, "stack");
    expect(error.code).toBe("ENOENT"); expect(error.syscall).toBe("open"); expect(error.path).toBe(missing);
    const output = formatBrowserFailure(markBrowserFailure(error, "browser-launch", facts));
    expect(summary(output)).toMatchObject({ phase: "browser-launch", code: "ENOENT", errno: error.errno, syscall: "open", ...facts });
    const record = detail(output).errors[0];
    expect(record).toMatchObject({ code: "ENOENT", errno: error.errno, syscall: "open", path: missing, message: error.message });
    // Both native representations are supported without asking the formatter to
    // execute an accessor. The original Error and its descriptor remain unchanged.
    if (stack && "value" in stack) {
      expect(typeof stack.value).toBe("string");
      expect(record.stack).toContain(error.message); expect(record.stack_accessor_omitted).toBe(false);
    } else {
      expect(stack?.get).toBeTypeOf("function");
      expect(record.stack).toBeNull(); expect(record.stack_accessor_omitted).toBe(true);
    }
    expect(Object.getOwnPropertyDescriptor(error, "stack")).toEqual(stack);
    expect(Object.isFrozen(error)).toBe(true);
  });
  it("does not trust custom accessors just because the object is a native Error", () => {
    const getter = vi.fn(() => { throw new Error("untrusted native Error getter"); });
    const error = new Error("overridden");
    for (const key of ["stack", "name", "message", "code", "errno", "syscall", "path", "cause", "errors"])
      Object.defineProperty(error, key, { get: getter, configurable: true });
    Object.freeze(error);
    const output = formatBrowserFailure(error);
    expect(getter).not.toHaveBeenCalled();
    expect(detail(output).errors[0]).toMatchObject({ stack: null, stack_accessor_omitted: true,
      name: null, message: null, code: null, errno: null, syscall: null, path: null });
    expect(output).not.toContain("formatting unavailable");
  });
  it("does not materialize a native lazy stack through custom formatting hooks", () => {
    const error = new Error("native lazy stack");
    const stack = Object.getOwnPropertyDescriptor(error, "stack");
    const name = vi.fn(() => "untrusted name"), message = vi.fn(() => "untrusted message");
    Object.defineProperties(error, { name: { get: name }, message: { get: message } });
    Object.freeze(error);
    const prepare = vi.fn(() => "untrusted prepared stack");
    const previous = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    let output: string;
    try {
      Object.defineProperty(Error, "prepareStackTrace", { value: prepare, configurable: true, writable: true });
      output = formatBrowserFailure(error);
    } finally {
      if (previous) Object.defineProperty(Error, "prepareStackTrace", previous);
      else Reflect.deleteProperty(Error, "prepareStackTrace");
    }
    expect(name).not.toHaveBeenCalled(); expect(message).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect(detail(output).errors[0]).toMatchObject({ name: null, message: null,
      stack_accessor_omitted: stack !== undefined && !("value" in stack) });
    expect(output).not.toContain("untrusted"); expect(output).not.toContain("formatting unavailable");
  });
  it("preserves cause and aggregate OS operations while inheriting only diagnostic phase facts", () => {
    const cause = Object.assign(new Error("Permission denied"), { code: "EPERM", errno: -4048, syscall: "mkdir", path: "C:\\controlled-prefix" });
    const wrapped = markBrowserFailure(new Error("Private profile creation failed", { cause }), "profile-create", {
      profile_path: null, process_close_observed: false, close_checks_completed: false,
    });
    const aggregate = new AggregateError([wrapped, new Error("Second cleanup failure")], "Startup failed");
    const output = formatBrowserFailure(aggregate);
    expect(summary(output)).toMatchObject({ phase: "profile-create", code: "EPERM", errno: -4048, syscall: "mkdir", profile_path: null });
    expect(detail(output).errors.map((error: { message: string }) => error.message)).toEqual([
      "Startup failed", "Private profile creation failed", "Permission denied", "Second cleanup failure",
    ]);
    expect(wrapped.cause).toBe(cause); expect(aggregate.errors[0]).toBe(wrapped);
  });
  it("retains the compact syscall and phase in the verifier's last 700 stderr characters", () => {
    const error = markBrowserFailure(Object.assign(new Error("Failure " + "detail ".repeat(2000)), {
      code: "EPERM", errno: -4048, syscall: "rmdir", path: profile,
    }), "profile-remove", facts);
    const output = formatBrowserFailure(error);
    const tail = output.split("\n").at(-1)!;
    expect(tail.length).toBeLessThan(650);
    expect((output + "\n").slice(-700)).toContain(tail);
    expect(summary(output)).toMatchObject({ phase: "profile-remove", code: "EPERM", syscall: "rmdir", profile_path: profile });
  });
  it("redacts before bounding and never enumerates environment, argv or arbitrary error fields", () => {
    const secret = "controlled-secret-never-print";
    vi.stubEnv("ARTOO_TEST_API_TOKEN", secret);
    const error = dataStack(Object.assign(new Error(`${secret} token=inline-secret https://user:password@example.invalid`), {
      argv: ["do-not-print-argv"], environment: { innocent: "do-not-print-env" },
    }), `Error: ${secret}\n${"x".repeat(2000)}${secret}`);
    const output = formatBrowserFailure(error);
    expect(output).not.toContain(secret); expect(output).not.toContain("inline-secret"); expect(output).not.toContain("user:password");
    expect(output).not.toContain("do-not-print-argv"); expect(output).not.toContain("do-not-print-env");
    expect(output).toContain("[redacted]");
    expect(detail(output).errors[0].stack).toContain("Error: [redacted]");
  });
  it("redacts complete quoted credential values and sensitive command-line forms in messages, stacks and causes", () => {
    const error = new Error('Controlled --password "cred-alpha cred-beta" password="cred-gamma cred-delta" --api-key=\'cred-epsilon cred-zeta\'', {
      cause: new Error('Authorization: "Bearer cred-eta cred-theta" --access-token cred-iota-kappa'),
    });
    dataStack(error, 'Error: token="cred-lambda \\"cred-mu\\" cred-nu"\n at controlled --secret \'cred-xi cred-omicron\'');
    const output = formatBrowserFailure(error);
    expect(output).not.toContain("cred-");
    expect(output).toContain("[redacted]");
    expect(detail(output).errors[0].stack).toContain("at controlled --secret [redacted]");
  });
  it("keeps a later OS failure in the summary even after earlier errors consume the detail budget", () => {
    const earlier = markBrowserFailure(dataStack(Object.assign(new Error("earlier ".repeat(1000)), { path: "x".repeat(2000) }), "s".repeat(3000)),
      "browser-launch", { ...facts, profile_path: "p".repeat(2000) });
    const operation = markBrowserFailure(Object.assign(new Error("remove failed"), { code: "EPERM", syscall: "rmdir" }), "profile-remove", facts);
    const output = formatBrowserFailure(new AggregateError([earlier, operation], "wrapper ".repeat(1000)));
    expect(summary(output)).toMatchObject({ phase: "profile-remove", code: "EPERM", syscall: "rmdir", profile_path: profile });
  });
  it("bounds escaped multiline Unicode errors and cycles without invoking getters or toJSON", () => {
    const getters = vi.fn(() => { throw new Error("getter should not run"); });
    const root: { message: string; cause?: unknown; errors?: unknown[] } = { message: "\u0001\\\"多".repeat(30000) };
    root.cause = root; root.errors = [root, root, root, root];
    Object.defineProperty(root, "stack", { get: getters }); Object.defineProperty(root, "code", { get: getters });
    Object.defineProperty(root, "toJSON", { value: getters });
    const output = formatBrowserFailure(root);
    expect(output.length).toBeLessThan(9000); expect(Buffer.byteLength(output)).toBeLessThan(27000);
    expect(detail(output).omitted).toBe(true); expect(getters).not.toHaveBeenCalled();
    expect(summary(output).phase).toBe(null);
  });
  it("limits nested aggregate members without serializing an arbitrary object or hiding the failure", () => {
    let error = new AggregateError([new Error("first"), new Error("second"), new Error("third"), new Error("fourth")], "bounded");
    for (let depth = 0; depth < 8; depth++) error = new AggregateError([error, error], "wrapper");
    const output = formatBrowserFailure(error);
    expect(detail(output).errors.length).toBeLessThanOrEqual(6); expect(detail(output).omitted).toBe(true);
    expect(output).not.toContain("formatting unavailable");
  });
});
