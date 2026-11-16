import { loadAuthConfig, type AuthConfig, type AuthConfigEnv } from "./auth/auth-config.js";
import { loadDeviceAuthConfig, type DeviceAuthConfig } from "./config/device-auth.js";

export interface ServerAccessConfig {
  readonly production: boolean;
  readonly port: number;
  readonly host: string;
  readonly authConfig: AuthConfig;
  readonly deviceAuth: DeviceAuthConfig;
}

function resolveAuthConfig(env: AuthConfigEnv, origin: string): AuthConfig {
  if (env.NODE_ENV === "production") return loadAuthConfig(env);
  return loadAuthConfig({
    ...env,
    GOOGLE_CLIENT_ID: env.GOOGLE_CLIENT_ID ?? "dev-client-id",
    GOOGLE_CLIENT_SECRET: env.GOOGLE_CLIENT_SECRET ?? "dev-client-secret",
    GOOGLE_REDIRECT_URI: env.GOOGLE_REDIRECT_URI ?? `${origin}/auth/google/callback`,
  });
}

/** Keep initial access checks independent of application and storage imports. */
export function loadServerAccessConfig(env: NodeJS.ProcessEnv): ServerAccessConfig {
  const production = env.NODE_ENV === "production";
  const port = Number(env.ARTOO_PORT ?? env.PORT ?? "4000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid ARTOO_PORT");
  const host = env.ARTOO_HOST ?? "127.0.0.1";
  const authConfig = resolveAuthConfig(env, `http://${host}:${port}`);
  const deviceAuth = loadDeviceAuthConfig(env);
  if (!authConfig.enforceApiAuth && !["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Authentication is required when listening beyond loopback");
  }
  return { production, port, host, authConfig, deviceAuth };
}
