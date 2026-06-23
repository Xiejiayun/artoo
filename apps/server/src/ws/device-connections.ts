/**
 * Live device-connection registry (#28 4b review — revoke must drop live
 * sockets, not only reject reconnects). Indexes authenticated device sockets
 * (node plane `/api/v1/node` and control plane `/api/v1/ws`) by `deviceId`, so a
 * device revoke can synchronously close every connection that device still holds.
 *
 * Pure in-process state: a connection registers when it authenticates and
 * unregisters when its socket closes (the returned disposer). `closeForDevice`
 * is what the revoke route calls after flipping the device to revoked.
 */

/** Anything the registry can close — a thin view over a WS socket's close. */
export interface DeviceConnection {
  close(code: number, reason: string): void;
}

export interface DeviceConnectionRegistry {
  /**
   * Register a live socket for a device. Returns a disposer the caller MUST run
   * on socket close so the index does not leak closed sockets.
   */
  add(deviceId: string, conn: DeviceConnection): () => void;
  /**
   * Close every live socket currently held for a device and forget them.
   * Returns how many were closed. Idempotent: a second call closes nothing.
   * Does NOT fire `onDeviceOffline` — the revoke caller owns that transition.
   */
  closeForDevice(deviceId: string, code: number, reason: string): number;
  /** Live socket count for a device (test/observability aid). */
  countForDevice(deviceId: string): number;
}

export interface DeviceConnectionRegistryOptions {
  /**
   * Fired once when a device's live socket count falls to zero through normal
   * socket close (the last connection released) — the presence offline edge.
   * NOT fired by `closeForDevice` (revoke), which emits its own offline event.
   */
  onDeviceOffline?: (deviceId: string) => void;
}

export function createDeviceConnectionRegistry(
  options: DeviceConnectionRegistryOptions = {},
): DeviceConnectionRegistry {
  const byDevice = new Map<string, Set<DeviceConnection>>();

  return {
    add(deviceId, conn): () => void {
      let set = byDevice.get(deviceId);
      if (set === undefined) {
        set = new Set();
        byDevice.set(deviceId, set);
      }
      set.add(conn);
      return () => {
        const current = byDevice.get(deviceId);
        if (current === undefined) {
          return; // already cleared (e.g. by closeForDevice) — no offline edge here
        }
        current.delete(conn);
        if (current.size === 0) {
          byDevice.delete(deviceId);
          options.onDeviceOffline?.(deviceId); // last socket gone -> offline edge
        }
      };
    },

    closeForDevice(deviceId, code, reason): number {
      const set = byDevice.get(deviceId);
      if (set === undefined) {
        return 0;
      }
      // Snapshot before closing: a socket's close handler runs its disposer,
      // mutating the set as we iterate. Deleting first means those disposers find
      // no set and do NOT fire onDeviceOffline — revoke emits offline itself.
      const conns = [...set];
      byDevice.delete(deviceId);
      for (const conn of conns) {
        conn.close(code, reason);
      }
      return conns.length;
    },

    countForDevice(deviceId): number {
      return byDevice.get(deviceId)?.size ?? 0;
    },
  };
}
