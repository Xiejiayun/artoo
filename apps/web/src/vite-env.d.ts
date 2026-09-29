// Ambient types for Vite's `import.meta.env`. Kept minimal: the web app reads
// only VITE_AUTH_ENABLED (the #34 Google-auth gate flag). Add keys here as the
// app grows rather than pulling in all of vite/client's asset-module shims.
interface ImportMetaEnv {
  /** "true" enables the #34 auth gate; any other value (incl. undefined) leaves it off. */
  readonly VITE_AUTH_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  readonly artooDesktop?: {
    readonly serverUrl: string;
    readonly platform: string;
    readonly electronVersion: string;
    getToken?(): Promise<string | null>;
    getConnection?(): Promise<DesktopConnection>;
    configureServer?(serverUrl: string): Promise<void>;
    pairDevice?(input: { code: string; displayName: string }): Promise<DesktopConnection>;
    logout?(): Promise<void>;
    daemonStatus?(): Promise<{ state: string; pid?: number; lastError?: string; config: DesktopDaemonConfig }>;
    configureDaemon?(config: DesktopDaemonConfig): Promise<void>;
    startDaemon?(): Promise<void>;
    stopDaemon?(): Promise<void>;
    restartDaemon?(): Promise<void>;
    chooseDirectory?(): Promise<string | null>;
    openExternal?(url: string): Promise<void>;
  };
}

interface DesktopConnection { serverUrl: string; paired: boolean; deviceId: string | null; computerId: string | null }
interface DesktopDaemonConfig { allowedRoots: string[]; runtimes: string[]; worktreeBaseRepo?: string; trustedExecution: boolean }
