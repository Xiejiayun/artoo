import { execFileSync } from "node:child_process";

export interface DeliveryClock { readonly id: string; tickMs(): number }
/** This macOS-only slice binds persisted monotonic deadlines to the actual boot
 * session. A reboot/unavailable read cannot silently reset or expire a budget.
 * The fixed, read-only system utility is bounded; it does not execute a shell. */
export function readDeliveryClock(): DeliveryClock | null {
  try {
    const id = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
      encoding: "utf8", timeout: 2000, maxBuffer: 1024, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    }).trim().toLowerCase();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) return null;
    let last = Number(process.hrtime.bigint() / 1_000_000n);
    return { id, tickMs() {
      const now = Number(process.hrtime.bigint() / 1_000_000n);
      if (!Number.isSafeInteger(now) || now < last) throw new Error("Delivery monotonic clock continuity failed");
      last = now; return now;
    } };
  } catch { return null; }
}
