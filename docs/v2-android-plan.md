# artoo Android client — plan & first implementation path (#31 / v2-F)

The Android **control surface** for the v2 multi-client push: monitor and drive
team collaboration from a phone, against the shared server contract. This is the
plan + first slice path; it is **not** a built APK (see *Toolchain & smoke*).

## Scope (slice 1)

In scope — a read+command **control surface** over the #27 shared contract:

- **Pairing / login** (depends on #28 device auth/pairing)
- **Task list + detail** (status, runs, approvals, artifacts)
- **Room messages** (read; send is a fast follow)
- **Approval inbox** (review/approve/reject)
- **Run summary / artifacts**
- **Realtime updates** (WS subscriptions via #27)

**Out of scope (slice 1):** running a local runtime / `artood` *on the phone*
(the desktop owns the local-node seam, #29). A phone is a control client, not a
compute node, until separately proven.

## Framework: **React Native** (recommended) — vs Kotlin/Compose

| | React Native (recommended) | Kotlin/Compose | Capacitor (fallback) |
|---|---|---|---|
| Native feel | native components, good | best (fully native) | WebView (least native) |
| Reuse of existing work | **high** — reuse the TS `ApiClient`, domain types, and #27 client SDK; same React mental model as `apps/web` | low — needs a Kotlin client (or a #27 Kotlin SDK) + full UI rewrite | **highest** — wraps the actual `apps/web` UI |
| Team fit | one team maintains `apps/web` + RN (TS/React) | separate Kotlin skill/codebase | web team, zero new skill |
| Effort to first APK | medium | highest | lowest |
| iOS reuse later | **yes** (same RN app targets iOS too) | no | yes (Capacitor iOS) |

**Recommendation: React Native.** It is the best balance of a genuinely native,
installable client and **reuse of the existing TypeScript contract layer** (the
web `ApiClient` + `@artoo/domain` types + the #27 client SDK) and the team's
React expertise — and the same RN app later covers iOS, shrinking the Apple-side
work. Kotlin/Compose gives the most native polish but at the cost of a separate
codebase and a duplicate client; reserve it only if a pure-native bar is required.
Capacitor stays a documented fallback if a WebView control surface is acceptable
and speed dominates.

## API / SDK reuse plan

- Consume the **#27 shared client SDK** (read APIs, command APIs, realtime sync,
  device identity, offline replay, presence). RN is TypeScript, so it reuses the
  SDK and `@artoo/domain` types **directly** — no second client implementation.
- The existing web `ApiClient` (fetch-based, `Idempotency-Key`, error envelope)
  is the reference shape; #27 should publish it as a platform-agnostic package
  (`@artoo/client`) the RN app imports, so web + desktop + mobile share one client.
- Realtime: reuse the web `RealtimeClient` topic model (`task:`/`room:`/`run:`/
  `inbox:`/`project:`) over the #27 sync channel.

## Auth / pairing (depends on #28)

- First launch runs the **#28 pairing flow**: pair the device to the org, store a
  device token in secure storage (Android Keystore), and target the paired server
  endpoint. No same-origin assumption — the client always holds an absolute base
  URL + token (same seam the desktop shell defined in #30).

## Offline (depends on #27)

- Reads are cached; commands enqueue to the **#27 offline queue** and replay on
  reconnect with conflict handling owned by #27. The RN app surfaces queue/sync
  state (pending/just like presence) but does not invent its own merge policy.

## Toolchain & emulator/device smoke (this Windows machine)

**This machine has none of the Android toolchain:** `java`/JDK ✗, `gradle` ✗,
Android SDK (`ANDROID_HOME` empty) ✗, `adb` ✗ — and (per #30) this Win11
Enterprise agent env is hostile to native binary toolchains. **So no APK can be
built or smoked here.** The path on a normal dev machine / CI:

1. Install JDK 17 + Android Studio (SDK, platform-tools, an AVD system image).
2. `npx react-native@latest init ArtooMobile` (or Expo prebuild) under `apps/mobile`.
3. Implement the control-surface screens against `@artoo/client` (#27).
4. **Emulator smoke (Windows-capable):** launch an **AVD emulator** (Android Studio
   runs emulators on Windows) *or* a USB device; `./gradlew assembleDebug` →
   `adb install app-debug.apk` → launch → pair/login → read task/inbox/run →
   quit. (A physical device over `adb` works identically.)

## Release gate

A platform is "directly installable/runnable" only after **APK build + emulator
or device smoke** evidence (install → launch → pair → read flow → quit), same bar
as #30 desktop / iOS. Until that runs on a toolchain-equipped machine/CI, Android
is **planned, not installable-proven**.

## First implementation path (slice 1)

1. `apps/mobile` RN app scaffold (TS) + `@artoo/client` (#27) wired in.
2. Pairing/login screen (#28) → store token → target paired server.
3. Tabs: Tasks (list+detail), Inbox (approvals), Rooms (messages), Runs.
4. Realtime subscriptions + offline queue surfacing (#27).
5. APK build + emulator/device smoke on a toolchain machine → release evidence.

Dependencies: **#27 client SDK** (the contract this consumes) and **#28 pairing**
must land first; this plan is ready to start the moment those contracts are firm.
