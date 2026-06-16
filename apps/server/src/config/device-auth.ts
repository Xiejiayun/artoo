/**
 * Device-auth configuration (#28 v2-C, slice 3). Server-wide secrets and policy
 * for device pairing + node credential validation, carried on {@link
 * ServerContext} so routes receive it by injection and never read env directly.
 *
 * Fail-closed by construction:
 *  - the pairing HMAC pepper is REQUIRED; {@link loadDeviceAuthConfig} throws if
 *    it is missing, so the server refuses to start without it. Tests inject a
 *    fixed pepper via {@link testDeviceAuthConfig} and never go through the env
 *    loader.
 *  - the legacy `token=dev` node escape is OFF unless BOTH `NODE_ENV` is not
 *    "production" AND `ARTOO_ALLOW_DEV_NODE_TOKEN === "1"`. Production can never
 *    enable it; there is no code path that accepts `token=dev` in production.
 */
export interface DeviceAuthConfig {
  /** HMAC pepper for pairing codes (#28 slice 3c). Never logged. */
  pairingPepper: string;
  /**
   * When non-null, this exact token authenticates a node on `/api/v1/node` as a
   * legacy dev/test escape (preserving v1 `node.hello` -> computer mapping).
   * `null` disables the escape — the only path then is a real device node token.
   */
  devNodeToken: string | null;
}

/** The subset of process env this loader reads. */
export interface DeviceAuthEnv {
  NODE_ENV?: string | undefined;
  ARTOO_PAIRING_PEPPER?: string | undefined;
  ARTOO_ALLOW_DEV_NODE_TOKEN?: string | undefined;
  ARTOO_DEV_NODE_TOKEN?: string | undefined;
}

/**
 * Load device-auth config from the environment, failing closed. Throws when the
 * pairing pepper is absent (so a misconfigured server cannot silently run with
 * an unverifiable pairing scheme). The dev node-token escape is enabled only in
 * non-production with the explicit opt-in flag.
 */
export function loadDeviceAuthConfig(env: DeviceAuthEnv): DeviceAuthConfig {
  const pepper = env.ARTOO_PAIRING_PEPPER?.trim();
  if (pepper === undefined || pepper === "") {
    throw new Error(
      "ARTOO_PAIRING_PEPPER is required (device pairing HMAC pepper); refusing to start without it",
    );
  }
  const escapeAllowed = env.NODE_ENV !== "production" && env.ARTOO_ALLOW_DEV_NODE_TOKEN === "1";
  const devToken = env.ARTOO_DEV_NODE_TOKEN?.trim();
  const devNodeToken = escapeAllowed ? (devToken !== undefined && devToken !== "" ? devToken : "dev") : null;
  return { pairingPepper: pepper, devNodeToken };
}

/** Fixed config for tests/fixtures (dev escape on, deterministic pepper). */
export function testDeviceAuthConfig(overrides: Partial<DeviceAuthConfig> = {}): DeviceAuthConfig {
  return { pairingPepper: "test-pairing-pepper-0123456789", devNodeToken: "dev", ...overrides };
}
