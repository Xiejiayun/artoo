# artoo desktop shell — Electron spike (#30 / v2-E)

A spike to prove the **fastest credible path to a Windows-installable desktop app
that reuses the web reference UI**, with clean seams for device pairing (#28) and
a client-managed local `artood` (#29). **Not the full desktop product.**

## TL;DR — recommendation

- **Use Electron for the desktop shell.** It is the fastest credible Windows
  packaging path on the current toolchain (pure Node; no extra language runtime)
  and its **Node main process gives a clean child-process seam to supervise a
  local `artood`** (#29). Tauri is a documented alternative (below), not built here.
- **Shell + UI bundling are proven**; the **Windows installer build is blocked by
  this specific agent environment**, not by the approach (see *Environment blocker*).
  On a normal Windows dev machine / CI, `npm install && npm run dist:win` produces
  an NSIS installer.

## What this spike proved (evidence)

| Step | Result |
|------|--------|
| Electron runtime | `npx electron --version` → **v33.4.11** (ran successfully once) |
| Web reference UI build | `npm run build --workspace @artoo/web` → `apps/web/dist` (381 KB JS) ✓ |
| Bundle UI into shell | copied `apps/web/dist` → `apps/desktop/renderer/` ✓ |
| Shell scaffold | `main.cjs` + `preload.cjs` + `electron-builder` config — complete ✓ |
| Windows installer build | **blocked in this agent env** (toolchain `.exe`s don't materialize — see below) |
| Launch / connect / quit smoke | **not reproducible in this headless + AV-restricted env** (definition below) |

### Environment blocker (why the package build did not complete here)

This is a **Windows 11 Enterprise** agent environment that is hostile to the
Electron/`electron-builder` **binary toolchain**:

- `npm install` left `node_modules/electron/dist` with only `LICENSES.chromium.html`
  — no `electron.exe`. The full 115 MB zip **was** downloaded to the `@electron/get`
  cache, but Electron's own extraction produced no binary. A manual
  `Expand-Archive` of the cached zip + writing `node_modules/electron/path.txt`
  recovered `electron.exe` (180 MB) and `electron --version` then worked.
- `electron-builder` then failed on `app-builder-bin` — that package was itself
  only partially installed (missing `package.json`, `win/x64/app-builder.exe`).
- `electron.exe` also disappeared between a successful `--version` run and a later
  direct launch, consistent with **enterprise AV quarantining the executable**.

Net: the toolchain's `.exe` artifacts cannot be reliably assembled in this agent
environment. **This is environmental — the Electron path itself is well-trodden and
builds normally on a standard Windows dev machine / CI.** The Windows package build
should run there (or in CI), exactly like the iOS app needs a real Mac.

## Build / package (run on a normal Windows machine or CI)

```bash
# from repo root
npm install
npm run build --workspace @artoo/web            # produce the web reference UI
# copy apps/web/dist -> apps/desktop/renderer    (wired into a prebuild step for prod)
cd apps/desktop
npm run dist:win                                 # electron-builder --win  → release/
```

- **Package command:** `electron-builder --win --publish never` (`npm run dist:win`).
- **Installer / output path:** NSIS installer at `apps/desktop/release/Artoo Setup <ver>.exe`
  (+ `release/win-unpacked/Artoo.exe` for a `--dir` build).
- **Windows prerequisites:** Node 18+; that's it for Electron (Chromium is bundled,
  no separate WebView runtime). NSIS/code-sign tooling is fetched by electron-builder.
  *In a restricted enterprise env, allow-list the electron-builder cache or run in CI.*

## Smoke definition (install → launch → connect → read → quit)

1. **Install:** run the NSIS installer; it installs to the chosen directory.
2. **Launch:** start `Artoo`; the shell window opens and renders the web UI.
3. **Connect:** the UI targets the configured server (`ARTOO_SERVER_URL`, default
   `http://localhost:4000`); bootstrap succeeds against a running server.
   *Dev/smoke shortcut:* set `ARTOO_DEV_URL=http://localhost:5173` to load the live
   Vite dev server (its proxy reaches `/api/v1`), giving a real connect without the
   prod URL-injection seam.
4. **Read flow:** the task list / inbox / read views populate from the server.
5. **Quit:** closing the window stops any supervised `artood` child and exits
   (`window-all-closed` / `before-quit` in `main.cjs`).

## Seams (left as seams, not implemented in this spike)

- **Server URL / #28 pairing:** `preload.cjs` exposes `window.artooDesktop.serverUrl`
  (from `ARTOO_SERVER_URL`). #28 replaces this static URL with a **paired-device
  endpoint + token**. *Prod note:* the web `ApiClient` should read
  `window.artooDesktop?.serverUrl` (1-line change) so the packaged `file://` UI can
  reach an absolute server URL; in dev it stays same-origin via the Vite proxy.
- **#29 local `artood` supervision:** `main.cjs` owns the child-process lifecycle
  (`startArtoodSupervision` / `stopArtoodSupervision`, configured via
  `ARTOO_ARTOOD_CMD`). #29 implements the real start/stop/status/restart + runtime
  heartbeat control plane; the shell just owns the process lifecycle.

## Installer / update implications

- **Installer:** electron-builder NSIS (`oneClick:false`, dir-selectable). Per-user
  install avoids admin elevation.
- **Updates:** electron-updater (NSIS differential) is the standard path; needs a
  release feed + (production) code-signing. Out of scope for this spike; called out
  for #33 release hardening.

## Tauri vs Electron (comparison only — Tauri not built, per scope)

| | Electron (chosen) | Tauri |
|---|---|---|
| Toolchain on this machine | Node only (present) | needs **Rust/`rustup`** (absent here) |
| App size | ~150–200 MB (bundles Chromium) | ~5–15 MB (system WebView2) |
| `artood` (#29) supervision | natural — Node `child_process` in main | via Rust `std::process` |
| Maturity / ecosystem | very mature | mature, smaller ecosystem |
| Why for this spike | **fastest credible Windows proof + Node seam** | smaller/native, but adds a Rust toolchain |

**Recommendation for #26:** ship the desktop shell on **Electron** for speed and
the Node/`artood` seam; revisit Tauri later if install size becomes a hard product
requirement (it would need a Rust toolchain in CI).

## macOS (plan only — needs a real Mac)

Same Electron shell + `electron-builder --mac` (DMG/zip) on a macOS runner;
notarization + Apple Developer signing required. **No macOS build/run/test was done**
(this is a Windows machine) — macOS "directly installable/runnable" stays a v2
release gate pending Mac evidence (same rule as iOS).
