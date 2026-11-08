// Fixed local protocol checks only. These streams/signals own no OS processes.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installApplicationBootstrapControl, type ApplicationBootstrapControl } from "./application-bootstrap-control.js";

class Input extends EventEmitter {
  readableObjectMode = false;
  readableEncoding: string | null = null;
  readableEnded = false;
  destroyed = false;
  pause = vi.fn();
}
const command = Buffer.from('{"version":1,"kind":"shutdown"}\n');
const controls: ApplicationBootstrapControl[] = [];
function fixture(enabled = true) {
  const input = new Input(), host = new EventEmitter(), control = installApplicationBootstrapControl(input, host);
  controls.push(control); if (enabled) control.enableStdin();
  return { input, host, control };
}
afterEach(() => { for (const control of controls.splice(0)) control.dispose(); });

describe("fixed application bootstrap shutdown control", () => {
  it.each(["SIGINT", "SIGTERM"])("latches %s before stdin admission without touching the input stream", signal => {
    const f = fixture(false); expect(f.input.eventNames()).toEqual([]);
    f.host.emit(signal); expect(f.control.signal.aborted).toBe(true); expect(f.control.reason).toBe(signal); expect(f.control.failure).toBeUndefined();
    f.control.enableStdin(); expect(f.input.eventNames()).toEqual([]);
    f.control.dispose(); expect(f.input.pause).not.toHaveBeenCalled();
  });
  it("retains the first normal stop reason when a later signal arrives", () => {
    const f = fixture(); f.input.emit("data", command); f.host.emit("SIGINT"); f.host.emit("SIGTERM");
    expect(f.control.reason).toBe("stdin"); expect(f.control.signal.aborted).toBe(true); expect(f.control.failure).toBeUndefined();
  });
  it("installs input control once and accepts exactly one complete command followed by EOF", () => {
    const f = fixture(false); f.control.enableStdin(); f.control.enableStdin();
    expect(f.input.listenerCount("data")).toBe(1); expect(f.input.listenerCount("end")).toBe(1); expect(f.input.listenerCount("error")).toBe(1);
    f.input.emit("data", command); f.input.emit("end");
    expect(f.control.signal.aborted).toBe(true); expect(f.control.reason).toBe("stdin"); expect(f.control.failure).toBeUndefined();
  });
  it("keeps partial command bytes pending across every possible boundary", () => {
    for (let split = 1; split < command.length; split++) {
      const f = fixture(); f.input.emit("data", command.subarray(0, split)); expect(f.control.signal.aborted).toBe(false);
      f.input.emit("data", command.subarray(split)); f.input.emit("end");
      expect(f.control.reason).toBe("stdin"); expect(f.control.failure).toBeUndefined(); f.control.dispose();
    }
  });
  it("accepts JSON field order, JSON whitespace and a CRLF terminator", () => {
    const f = fixture(); f.input.emit("data", Buffer.from(' { "kind" : "shutdown", "version" : 1 }\r\n'));
    f.input.emit("end"); expect(f.control.reason).toBe("stdin"); expect(f.control.failure).toBeUndefined();
  });
  it.each([
    Buffer.concat([command, command]),
    Buffer.concat([command, Buffer.from(" ")]),
    Buffer.concat([command, Buffer.from([0xe2])]),
    Buffer.from('{"version":1,"kind":"shutdown","command":"run"}\n'),
    Buffer.from('{"version":1,"kind":"shutdown","version":1}\n'),
    Buffer.from('{"version":2,"kind":"shutdown"}\n'),
    Buffer.from('{"version":1,"kind":"restart"}\n'),
    Buffer.from('[{"version":1,"kind":"shutdown"}]\n'),
    Buffer.from('null\n'),
    Buffer.from('\n'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), command]),
    Buffer.from('{"\\u0076ersion":1,"kind":"shutdown"}\n'),
  ])("rejects extra, changed or nonliteral command framing before granting a normal stop reason (%#)", bytes => {
    const f = fixture(); f.input.emit("data", bytes);
    expect(f.control.signal.aborted).toBe(true); expect(f.control.failure).toBeInstanceOf(Error); expect(f.control.reason).toBeUndefined();
  });
  it("records trailing data delivered in a later chunk even after valid shutdown", () => {
    const f = fixture(); f.input.emit("data", command); expect(f.control.failure).toBeUndefined();
    f.input.emit("data", Buffer.from(" ")); expect(f.control.failure).toBeInstanceOf(Error); expect(f.control.reason).toBe("stdin");
  });
  it.each(["empty", "partial-json", "missing-lf", "incomplete-utf8"])("rejects %s at the actual stream EOF", value => {
    const f = fixture();
    if (value === "partial-json") f.input.emit("data", Buffer.from('{"version":'));
    if (value === "missing-lf") f.input.emit("data", command.subarray(0, command.length - 1));
    if (value === "incomplete-utf8") f.input.emit("data", Buffer.from([0xe2, 0x82]));
    expect(f.control.signal.aborted).toBe(false); f.input.emit("end");
    expect(f.control.signal.aborted).toBe(true); expect(f.control.failure).toBeInstanceOf(Error); expect(f.control.reason).toBeUndefined();
  });
  it("rejects malformed UTF-8 split over data chunks", () => {
    const f = fixture(); f.input.emit("data", Buffer.from([0xe2])); expect(f.control.failure).toBeUndefined();
    f.input.emit("data", Buffer.from([0x28])); expect(f.control.failure).toBeInstanceOf(Error); expect(f.control.reason).toBeUndefined();
  });
  it("counts raw bytes across chunks and accepts at most the 4096-byte command budget", () => {
    const accepted = fixture(), padding = Buffer.alloc(4096 - command.length, 32);
    accepted.input.emit("data", padding); accepted.input.emit("data", command); accepted.input.emit("end"); expect(accepted.control.failure).toBeUndefined();
    const rejected = fixture(); rejected.input.emit("data", padding); rejected.input.emit("data", Buffer.concat([Buffer.from(" "), command]));
    expect(rejected.control.failure).toBeInstanceOf(Error); expect(rejected.control.reason).toBeUndefined();
  });
  it.each(["string", "object"])("rejects a %s data event instead of accepting another stream mode", value => {
    const f = fixture(); f.input.emit("data", value === "string" ? command.toString("utf8") : { command: "shutdown" });
    expect(f.control.signal.aborted).toBe(true); expect(f.control.failure).toBeInstanceOf(Error); expect(f.control.reason).toBeUndefined();
  });
  it.each(["object", "encoding", "ended", "destroyed"])("rejects %s stream mode before attaching input listeners", value => {
    const f = fixture(false);
    if (value === "object") f.input.readableObjectMode = true;
    if (value === "encoding") f.input.readableEncoding = "utf8";
    if (value === "ended") f.input.readableEnded = true;
    if (value === "destroyed") f.input.destroyed = true;
    f.control.enableStdin(); expect(f.control.signal.aborted).toBe(true); expect(f.control.failure).toBeInstanceOf(Error);
    expect(f.input.eventNames()).toEqual([]); f.control.dispose(); expect(f.input.pause).not.toHaveBeenCalled();
  });
  it("preserves the first transport failure and never changes it into normal shutdown", () => {
    const f = fixture(), original = Error("first transport error"); f.input.emit("error", original);
    const failure = f.control.failure; expect(failure?.cause).toBe(original);
    f.input.emit("error", Error("second")); f.input.emit("data", command); f.host.emit("SIGINT"); f.input.emit("end");
    expect(f.control.failure).toBe(failure); expect(f.control.reason).toBeUndefined(); expect(f.control.signal.aborted).toBe(true);
  });
  it("removes only its own listeners and pauses its enabled input exactly once", () => {
    const f = fixture(), unrelatedData = vi.fn(), unrelatedSignal = vi.fn();
    f.input.on("data", unrelatedData); f.host.on("SIGINT", unrelatedSignal);
    f.control.dispose(); f.control.dispose(); f.control.enableStdin();
    expect(f.input.listenerCount("data")).toBe(1); expect(f.input.listenerCount("end")).toBe(0); expect(f.input.listenerCount("error")).toBe(0);
    expect(f.host.listenerCount("SIGINT")).toBe(1); expect(f.host.listenerCount("SIGTERM")).toBe(0); expect(f.input.pause).toHaveBeenCalledTimes(1);
    f.input.emit("data", command); f.host.emit("SIGINT"); expect(f.control.signal.aborted).toBe(false); expect(f.control.failure).toBeUndefined();
    expect(unrelatedData).toHaveBeenCalledOnce(); expect(unrelatedSignal).toHaveBeenCalledOnce();
  });
});
