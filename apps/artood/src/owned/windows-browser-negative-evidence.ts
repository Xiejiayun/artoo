/** Fixed failure facts only. None of these fields grants process or cleanup authority. */
export interface WindowsBrowserAncestryFailureV1 {
  readonly version: 1;
  readonly attempt: number;
  readonly census: "first" | "second" | "corroborating";
  readonly root_pid: number;
  readonly parent_pid: number;
  readonly child_pid: number;
  readonly root_filetime: string;
  readonly parent_filetime: string;
  readonly child_filetime: string;
  readonly root_type: "System.Int64";
  readonly parent_type: "System.Int64";
  readonly child_type: "System.Int64";
  readonly delta_ticks: string;
}
const fields = ["version", "attempt", "census", "root_pid", "parent_pid", "child_pid", "root_filetime", "parent_filetime",
  "child_filetime", "root_type", "parent_type", "child_type", "delta_ticks"] as const;
const pid = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 0xffffffff;
const invalid = () => new Error("Invalid protected browser ancestry failure evidence");

/** Copy only closed fields; exact decimal FILETIME values never pass through Number. */
export function parseWindowsBrowserAncestryFailure(value: unknown,
  history: Readonly<{ parentPid: number; pids: readonly number[] }>): Readonly<WindowsBrowserAncestryFailureV1> {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key as typeof fields[number]))
    || fields.some(key => !Object.hasOwn(descriptors[key]!, "value"))) throw invalid();
  const record = Object.fromEntries(fields.map(key => [key, descriptors[key]!.value])) as Record<typeof fields[number], unknown>;
  if (!pid(history.parentPid) || !Array.isArray(history.pids) || history.pids.length > 127
    || history.pids.some(value => !pid(value) || value === history.parentPid) || new Set(history.pids).size !== history.pids.length
    || record.version !== 1 || !Number.isInteger(record.attempt) || (record.attempt as number) < 1 || (record.attempt as number) > 3
    || !["first", "second", "corroborating"].includes(record.census as string)
    || !pid(record.root_pid) || !pid(record.parent_pid) || !pid(record.child_pid)
    || record.root_pid !== history.parentPid || record.child_pid === record.root_pid || record.child_pid === record.parent_pid
    || !history.pids.includes(record.child_pid) || record.parent_pid !== record.root_pid && !history.pids.includes(record.parent_pid)
    || [record.root_type, record.parent_type, record.child_type].some(type => type !== "System.Int64")) throw invalid();
  for (const key of ["root_filetime", "parent_filetime", "child_filetime"] as const) {
    const ticks = record[key];
    if (typeof ticks !== "string" || /^[1-9][0-9]{0,18}$/.exec(ticks)?.[0] !== ticks || BigInt(ticks) > 9223372036854775807n) throw invalid();
  }
  const rootTicks = record.root_filetime as string, parentTicks = record.parent_filetime as string, childTicks = record.child_filetime as string;
  if (typeof record.delta_ticks !== "string" || /^-[1-9][0-9]{0,18}$/.exec(record.delta_ticks)?.[0] !== record.delta_ticks
    || BigInt(childTicks) - BigInt(parentTicks) !== BigInt(record.delta_ticks)
    || record.parent_pid === record.root_pid && parentTicks !== rootTicks) throw invalid();
  // This literal fixes output order and excludes accessors, extra fields and aliases.
  const result: WindowsBrowserAncestryFailureV1 = { version: 1, attempt: record.attempt as number,
    census: record.census as WindowsBrowserAncestryFailureV1["census"], root_pid: record.root_pid, parent_pid: record.parent_pid,
    child_pid: record.child_pid, root_filetime: rootTicks, parent_filetime: parentTicks, child_filetime: childTicks,
    root_type: "System.Int64", parent_type: "System.Int64", child_type: "System.Int64", delta_ticks: record.delta_ticks };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 768) throw invalid();
  return Object.freeze(result);
}
