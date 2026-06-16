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
