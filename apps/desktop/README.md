# artoo desktop shell - Electron spike (#30 / v2-E)

A spike to prove the fastest credible path to a Windows-installable desktop app
that reuses the web reference UI, with clean seams for device pairing (#28) and
a client-managed local `artood` (#29). This is not the full desktop product.

## TL;DR - recommendation

- Use Electron for the first desktop shell. It is the fastest credible Windows
  packaging path on the current Node toolchain, and its main process gives a
  direct child-process seam for supervising a local `artood`.
- Windows packaging is now proven on this Windows machine: `npm run smoke:win
  --workspace @artoo/desktop` builds the NSIS installer, installs it, launches
  installed `Artoo.exe`, connects to a temp server, reads and writes through the
  packaged renderer, screenshots, closes, uninstalls, and verifies the app exe is
  removed.
- macOS packaging remains a plan only until a real Mac/Xcode runner or human Mac
  proof exists.

## Windows evidence

Latest passing command on 2026-06-23:

```bash
npm run smoke:win --workspace @artoo/desktop
```

What the smoke proves:

| Step | Evidence |
| --- | --- |
| Build server | `npm run build --workspace @artoo/server` |
| Build packaged renderer | `npm run build --workspace @artoo/web` then copy `apps/web/dist` to `apps/desktop/renderer` |
| Build installer | NSIS installer at `apps/desktop/release/Artoo Setup 0.1.0.exe` |
| Install | silent NSIS install into a temp directory |
| Launch | Playwright Electron launches the installed `Artoo.exe` |
| Connect | preload bridge exposes the temp `ARTOO_SERVER_URL`; renderer fetches `/api/v1/bootstrap` |
| Read | renderer task list shows `Windows desktop smoke <timestamp>` from the temp server |
| Write | renderer performs a CORS-backed `POST /api/v1/tasks` through the packaged `file://` app |
| Screenshot | `apps/desktop/release/smoke-artifacts/windows-desktop-smoke.png` |
| Quit/uninstall | app closes, silent uninstaller runs, smoke waits until `Artoo.exe` is gone |

## Commands

```bash
# from repo root
npm install
npm run pack:win --workspace @artoo/desktop
npm run dist:win --workspace @artoo/desktop
npm run smoke:win --workspace @artoo/desktop
```

- `pack:win` builds `apps/desktop/release/win-unpacked/Artoo.exe`.
- `dist:win` builds `apps/desktop/release/Artoo Setup <version>.exe`.
- `smoke:win` is the install/launch/connect/read/write/quit/uninstall proof.

## Runtime bridge

- `preload.cjs` exposes `window.artooDesktop.serverUrl`, `platform`, and
  `electronVersion` to the context-isolated renderer.
- The web app detects that bridge, uses an absolute `/api/v1` base URL, omits
  browser credentials for the desktop smoke, uses a desktop WebSocket URL, and
  uses `HashRouter` so packaged `file://` navigation works.
- The web build uses relative Vite assets (`base: "./"`) so the same bundle works
  under both server static hosting and `app.asar`.
- The smoke server enables `ARTOO_DESKTOP_CORS=1` so a packaged `file://` renderer
  can make JSON API writes. `ARTOO_DESKTOP_CORS_ORIGINS` defaults to `null`, the
  Origin Chromium sends for `file://`; set it explicitly for any future custom
  app scheme.

## Toolchain notes

- `electron-builder` must not run the workspace production-dependency rebuild for
  this app because the desktop package has no production dependencies and npm can
  prune the builder's own workspace dev tools. The desktop builder config sets
  `npmRebuild: false`.
- On this Windows host, direct `spawnSync("npm.cmd", ...)` returns `EINVAL` under
  the smoke's Node process. The smoke invokes npm as `node <npm-cli.js>` via
  `process.env.npm_execpath`.
- On this host, `npm install` can leave `node_modules/electron/dist` without
  `electron.exe`; restoring Electron from the `@electron/get` cache recovered the
  local toolchain before the passing smoke. That is a host install-cache issue,
  not a committed source change; the repo fixes are in package config/scripts and
  app code.

## Seams left for later slices

- #28 device pairing replaces the static `ARTOO_SERVER_URL` with a paired device
  endpoint and scoped token flow.
- #29 implements the real local `artood` start/stop/status/restart and heartbeat
  control plane. This shell owns only the child-process lifecycle seam
  (`ARTOO_ARTOOD_CMD`).
- Full v2 desktop release still needs the broader product gate: Google login or
  equivalent desktop auth, task approval/review smoke, signed release policy, and
  update feed. The current proof is the Windows installer and packaged renderer
  API path.

## Tauri comparison

| | Electron (chosen) | Tauri |
| --- | --- | --- |
| Toolchain on this machine | Node-based | needs Rust/`rustup` |
| App size | larger; bundles Chromium | smaller; uses system WebView2 |
| `artood` supervision | natural via Node `child_process` | via Rust `std::process` |
| Ecosystem | mature | mature, smaller desktop ecosystem |
| Why for first slice | fastest credible Windows installer proof + Node seam | revisit if app size becomes a hard product requirement |

## macOS plan

Use the same Electron shell with `electron-builder --mac` on a macOS runner.
DMG/zip output, code signing, notarization, and Apple Developer credentials need
real Mac evidence. No macOS build/run/test was done on this Windows machine.
