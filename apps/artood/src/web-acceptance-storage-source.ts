import { createHash } from "node:crypto";

/** Fixed trusted initializer. No product value is interpolated into this source. */
export const STORAGE_FAULT_INITIALIZER_SOURCE = `(() => {
  const targetWindow = globalThis, apply = Reflect.apply, define = Object.defineProperty;
  const describe = Object.getOwnPropertyDescriptor, freeze = Object.freeze, create = Object.create;
  const NativeDOMException = DOMException, NativeError = Error, storagePrototype = Storage.prototype;
  const descriptor = describe(targetWindow, 'localStorage'), setDescriptor = describe(storagePrototype, 'setItem');
  const nativeGetter = descriptor && descriptor.get, nativeSetItem = setDescriptor && setDescriptor.value;
  let mode = 'none', readHits = 0, writeHits = 0, controls = 0, installed = false;
  if (descriptor && descriptor.configurable === true && typeof nativeGetter === 'function'
      && setDescriptor && setDescriptor.configurable === true && typeof nativeSetItem === 'function') {
    define(targetWindow, 'localStorage', { enumerable: descriptor.enumerable, configurable: false, get() {
      if (mode === 'read-security') { readHits++; throw new NativeDOMException('Protected synthetic read failure', 'SecurityError'); }
      return apply(nativeGetter, targetWindow, []);
    }});
    define(storagePrototype, 'setItem', { enumerable: setDescriptor.enumerable, configurable: false, writable: false, value: function(key, value) {
      if (mode === 'write-quota' && this === apply(nativeGetter, targetWindow, [])) {
        writeHits++; throw new NativeDOMException('Protected synthetic write failure', 'QuotaExceededError');
      }
      return apply(nativeSetItem, this, [key, value]);
    }});
    installed = true;
  }
  const controller = freeze(function(operation, value) {
    if (operation === 'arm') {
      if (value !== 'none' && value !== 'read-security' && value !== 'write-quota') throw new NativeError('Unsupported storage fault mode');
      mode = value; controls++;
    } else if (operation !== 'inspect') throw new NativeError('Unsupported storage controller operation');
    const result = create(null); result.installed = installed; result.mode = mode;
    result.read_hits = readHits; result.write_hits = writeHits; result.controls = controls; return result;
  });
  debugger;
})();
//# sourceURL=artoo-protected-storage-fault-v1.js`;

export const STORAGE_FAULT_INITIALIZER_DIGEST = `sha256:${createHash("sha256").update(STORAGE_FAULT_INITIALIZER_SOURCE).digest("hex")}`;
export const STORAGE_FAULT_MAX_KEYS = 512;
export const STORAGE_FAULT_MAX_UTF8_BYTES = 1024 * 1024;
export const STORAGE_FAULT_MAX_EVENTS = 512;

export interface NativeStorageSnapshotV1 {
  entries: [string, string][];
  summary: { digest: string; key_count: number; utf8_bytes: number };
}

/** Actual CDP entries remain private; evidence only receives the bounded summary. */
export function nativeStorageSnapshotV1(input: unknown): NativeStorageSnapshotV1 {
  if (!Array.isArray(input) || input.length > STORAGE_FAULT_MAX_KEYS) throw new Error("Native localStorage snapshot exceeds its key bound or is malformed");
  let bytes = 0;
  const keys = new Set<string>();
  const entries = input.map((item): [string, string] => {
    if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || typeof item[1] !== "string") throw new Error("Malformed native localStorage entry");
    if (keys.has(item[0])) throw new Error("Native localStorage snapshot contains duplicate keys");
    keys.add(item[0]); bytes += Buffer.byteLength(item[0], "utf8") + Buffer.byteLength(item[1], "utf8");
    if (bytes > STORAGE_FAULT_MAX_UTF8_BYTES) throw new Error("Native localStorage snapshot exceeds its UTF-8 byte bound");
    return [item[0], item[1]];
  }).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return { entries, summary: { digest: `sha256:${createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`,
    key_count: entries.length, utf8_bytes: bytes } };
}
