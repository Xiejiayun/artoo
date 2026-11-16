/** Private native-process wire only. This never travels in task context or
 * grants a start; the original journal still owns the one-use permit. */
export interface WindowsLaunchWindowV1 {
  readonly version: 1;
  readonly clock: "windows-qpc-ms.v1";
  readonly deadline_ms: number;
}
export const windowsQpcMs = () => Number(process.hrtime.bigint() / 1_000_000n);
export function snapshotWindowsLaunchWindow(
  input: WindowsLaunchWindowV1 | undefined,
): WindowsLaunchWindowV1 | undefined {
  if (input === undefined) return;
  const now = windowsQpcMs();
  if (
    process.platform !== "win32" ||
    input.version !== 1 ||
    input.clock !== "windows-qpc-ms.v1" ||
    !Number.isSafeInteger(input.deadline_ms) ||
    input.deadline_ms <= now ||
    input.deadline_ms - now > 5000
  )
    throw new Error("An unexpired original bounded Windows QPC launch window is required");
  return Object.freeze({ version: 1, clock: "windows-qpc-ms.v1", deadline_ms: input.deadline_ms });
}
