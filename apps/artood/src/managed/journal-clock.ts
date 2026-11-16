import { execFileSync } from "node:child_process";
import { readWindowsJournalBootSample } from "./windows-journal-native.js";

export interface DeliveryClock {
  readonly id: string;
  tickMs(): number;
}
/** Binds persisted monotonic deadlines to the actual platform boot
 * session. A reboot/unavailable read cannot silently reset or expire a budget.
 * The fixed, read-only system utility is bounded; it does not execute a shell. */
export function readDeliveryClock(): DeliveryClock | null {
  try {
    let id: string;
    if (process.platform === "win32") {
      const before = process.hrtime.bigint(),
        sample = readWindowsJournalBootSample(),
        after = process.hrtime.bigint();
      // QPC is system-wide. Confirm Node uses that same origin/scale rather
      // than introducing a per-process offset that would renew old budgets.
      if (sample.counterNs < before || sample.counterNs > after || after < before) return null;
      id = sample.id;
    } else if (process.platform === "darwin") {
      id = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
      })
        .trim()
        .toLowerCase();
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) return null;
    } else return null;
    let last = Number(process.hrtime.bigint() / 1_000_000n);
    if (!Number.isSafeInteger(last) || last < 0) return null;
    return {
      id,
      tickMs() {
        const now = Number(process.hrtime.bigint() / 1_000_000n);
        if (!Number.isSafeInteger(now) || now < last) throw new Error("Delivery monotonic clock continuity failed");
        last = now;
        return now;
      },
    };
  } catch {
    return null;
  }
}
