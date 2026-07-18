# Fork Changes — Stoat for Desktop

This document describes **all the changes this fork (`Trifall/stoat-for-desktop`) has made on top of upstream (`stoatchat/for-desktop`)**, why they exist, how they're integrated, and what must be preserved when merging upstream in the future.

It is intended as a reference for both humans and AI agents working on the fork — please read it before opening an upstream merge or removing any of the modules below.

- **Fork repo:** https://github.com/Trifall/stoat-for-desktop
- **Upstream repo:** https://github.com/stoatchat/for-desktop (remote name `upstream`)
- **Paired web client fork:** https://github.com/Trifall/stoat-for-web (also needed for PTT to be visible in the UI — see §2)

> **If you are an agent doing an upstream merge:** every section tagged **KEEP ON MERGE** below must be preserved through the merge. The merge commit on `main` is the canonical record of what was integrated; do not squash it away. If upstream and the fork make materially different changes to the same subsystem, stop and follow the user-approval process in §10 before resolving that area. See §11 for the merge checklist.

---

## Table of Contents

1. [Overview / Diff Summary](#1-overview--diff-summary)
2. [Push-to-Talk (PTT)](#2-push-to-talk-ptt) — the largest fork feature
3. [`stoat://` Local Web Asset Protocol](#3-stoat-local-web-asset-protocol)
4. [Tray Reload Button](#4-tray-reload-button)
5. [Custom CI/CD Workflow](#5-custom-cicd-workflow)
6. [Package / Packaging Configuration](#6-package--packaging-configuration)
7. [Cross-zip Patch](#7-cross-zip-patch)
8. [Config Schema Extensions](#8-config-schema-extensions)
9. [Files Deleted from Upstream](#9-files-deleted-from-upstream)
10. [Material Conflict Escalation and User Approval](#10-material-conflict-escalation-and-user-approval)
11. [Upstream Merge Checklist](#11-upstream-merge-checklist)
12. [Known Issues / Gotchas](#12-known-issues--gotchas)

---

## 1. Overview / Diff Summary

The fork's `main` branch contains a merge commit integrating `upstream/main`. To see everything the fork has added on top of upstream:

```bash
git diff upstream/main...HEAD --stat
git log upstream/main..HEAD --oneline
```

Approximate footprint (as of the latest merge):

```
.github/workflows/README.md             | 213 ++++++++
.github/workflows/build-desktop.yml     | 373 +++++++++++++
.github/workflows/build.yml             |  28 -    (deleted upstream file)
.github/workflows/git-town.yml         |  19 -    (deleted upstream file)
.github/workflows/release-please.yml    |  88 -    (deleted upstream file)
.github/workflows/release-webhook.yml  |  26 -    (deleted upstream file)
.github/workflows/validate-pr-title.yml|  23 -    (deleted upstream file)
.gitignore                              |   3 +
.gitmodules                             |   2 +-   (submodule points at stoatchat/assets)
README.md                               | 188 ++++++-
SETUP_GUIDE.md                          | 242 +++++++++
forge.config.ts                         | 115 ++++-
package.json                            |   6 +-
patches/cross-zip@4.0.1.patch          |  22 +
pnpm-lock.yaml                          | 204 +++++--
pnpm-workspace.yaml                     |   3 +
src/config.d.ts                         |  32 ++
src/main.ts                             |  59 ++-
src/native/config.ts                    | 103 ++++
src/native/pushToTalk.ts                | 882 +++++++++++++++++++++++++++++++  (new)
src/native/tray.ts                      |  19 +-
src/native/window.ts                    | 150 +++-
src/preload.ts                          |  1 +
src/world/pushToTalk.ts                 | 280 ++++++++++    (new)
strings.ts                              |   0
vite.main.config.ts                     |  14 +-
```

| Category | Files |
|---|---|
| New feature modules | `src/native/pushToTalk.ts`, `src/world/pushToTalk.ts` |
| Modified native modules | `src/native/window.ts`, `src/native/config.ts`, `src/native/tray.ts` |
| Modified entry points | `src/main.ts`, `src/preload.ts`, `src/config.d.ts` |
| Build config | `forge.config.ts`, `vite.main.config.ts`, `package.json`, `pnpm-workspace.yaml`, `patches/cross-zip@4.0.1.patch` |
| CI/CD | `.github/workflows/build-desktop.yml`, `.github/workflows/README.md` (replaces upstream's release/validate workflows) |
| Docs | `README.md`, `SETUP_GUIDE.md`, `fork-changes.md` (this file) |

---

## 2. Push-to-Talk (PTT) — `KEEP ON MERGE`

The single biggest fork addition. PTT lets users hold/toggle a hotkey to unmute their mic in voice channels, with global hotkey detection that works even when the app is unfocused (a hard problem on Linux Wayland).

### 2.1 Why it exists

Upstream has no push-to-talk. The fork needed:
- **Hold mode** (press-to-talk, release-to-mute) with optional release delay.
- **Toggle mode** (one press = unmute, next press = mute).
- **Global hotkey**: fire even when the app is blurred, on Linux (XWayland) and Windows.
- **Allow typing the PTT key** in chat when the window *is* focused.
- **Multiple keybinds** stored as a JSON array (with a single-string legacy fallback).

Neither Electron's `globalShortcut` nor `iohook` worked reliably, so the fork eventually settled on the **`keyspy`** native module, which spawns a separate native binary per platform (`WinKeyServer.exe` on Windows, `X11KeyServer` on Linux, `MacKeyServer` on macOS) and communicates over stdio.

### 2.2 Files involved

| Path | Role |
|---|---|
| `src/native/pushToTalk.ts` (882 lines) | **Main-process PTT engine.** Loads `keyspy`, registers IPC, manages keyspy lifecycle, watchdog, crash recovery, hold/toggle logic, window focus/blur handling, and the dual input path (focused `before-input-event` vs blurred keyspy global events). |
| `src/world/pushToTalk.ts` (280 lines) | **Preload/renderer bridge.** Exposes `window.pushToTalk` with `onStateChange`, `setManualState`, `getCurrentState`, `isAvailable`, `updateSettings`, `getConfig`, `onConfigChange`, etc. Adds capture-phase `keydown`/`keyup` DOM listeners to stop propagation of the PTT key (so the web client's own handlers don't fire) while still allowing typing in input fields. |
| `src/preload.ts` | Imports `./world/pushToTalk` so the bridge loads. |
| `src/config.d.ts` | Type declarations for `window.pushToTalk` and the `DesktopConfig` PTT fields. |
| `src/native/config.ts` | Adds `pushToTalk`, `pushToTalkKeybind`, `pushToTalkMode`, `pushToTalkReleaseDelay` to the `electron-store` schema + setters with side effects (re-registering/cleaning up the hotkey). |
| `src/main.ts` | Imports `initPushToTalk` / `cleanupPushToTalk`. Calls `initPushToTalk()` in `app.on("ready")` (after `initDiscordRpc()`). Calls `cleanupPushToTalk()` on `window-all-closed` and `before-quit`. |
| `forge.config.ts` | `packagerConfig.asar.unpack = "**/node_modules/keyspy/**/*"` (keyspy spawns a native child process and cannot live inside asar) and `prePackage`/`postPackage` hooks that compile keyspy's native server binaries at package time and copy `keyspy` + `@expo/sudo-prompt` into `app.asar.unpacked/node_modules/`. |
| `vite.main.config.ts` | Marks `keyspy` (and `bufferutil`, `utf-8-validate`) as `external` — they must not be bundled by Vite. |
| `package.json` | Declares `keyspy: ^1.1.1` as a runtime dependency and `electron-rebuild: ^3.2.9` as a dev dependency (used to rebuild native modules against Electron's headers). |
| `pnpm-workspace.yaml` | `nodeLinker: hoisted` — keyspy expects a hoisted node_modules layout. Also lists `bufferutil` and `utf-8-validate` in `onlyBuiltDependencies` because they ship native code. |
| `.github/workflows/build-desktop.yml` | Installs `libx11-dev libxi-dev` on Linux and `mingw` on Windows so the `prePackage` hook can compile the keyspy servers. |
| `assets` submodule | Provides the desktop tray icon. (Not PTT-specific but related — see §6.) |

### 2.3 How it boots

`src/main.ts` inside `app.on("ready")`:

```ts
// create window and application contexts
createMainWindow();
initTray();
initDiscordRpc();
initPushToTalk();   // <-- fork
```

And on shutdown:

```ts
app.on("window-all-closed", () => {
  cleanupPushToTalk();     // <-- fork
  if (process.platform !== "darwin") {
    process.kill(process.pid, "SIGKILL");
  }
});

app.on("before-quit", () => {
  cleanupPushToTalk();     // <-- fork
});
```

`initPushToTalk()` (`src/native/pushToTalk.ts:811`) registers three IPC handlers:

- `push-to-talk-manual` — renderer can manually set PTT on/off (for on-screen mic buttons).
- `push-to-talk-update-settings` — renderer can change `enabled`, `keybind`, `mode`, `releaseDelay`. Writes through to `electron-store` and re-registers the hotkey if `enabled` flipped.
- `push-to-talk-request-config` — renderer asks for current config (sent on preload load).

If `config.pushToTalk` is true at boot, `initPushToTalk()` also calls `registerPushToTalkHotkey()`.

### 2.4 The dual input path (important — don't collapse it)

PTT input is collected from **two** sources depending on window focus:

1. **Window focused** → Electron's `webContents.on("before-input-event", handleBeforeInputEvent)` is used. The event is *not* `preventDefault`'d so the user can still **type** the PTT key in chat. The DOM-level listener in `src/world/pushToTalk.ts` stops propagation *after* letting the keystroke through, so the web client never fires its own handlers twice.
2. **Window blurred** → `keyspy`'s `GlobalKeyboardListener` provides OS-wide keyboard events. The listener early-returns when `isWindowFocused` is true to avoid double-firing.

The fork attaches `mainWindow.on("focus", focusHandler)` and `mainWindow.on("blur", blurHandler)` in `registerPushToTalkHotkey()` to:
- Toggle `isWindowFocused`.
- Clear `heldKeys` / `heldPttBindings` / `heldPttBindingsByKey` on the transition (a stuck key across a focus change would otherwise leave PTT stuck on).
- In **hold mode only**, also call `deactivatePtt(...)` with `useDelay = false` so a blur doesn't leave the mic open. **Toggle mode intentionally does NOT deactivate on blur** — the user's toggle state is preserved.

If this dual-path behavior looks redundant, **it is not** — removing either side breaks PTT either when focused (can't type the PTT key) or when unfocused (no global hotkey). Multiple past commits reverted attempts to simplify it.

### 2.5 Keyspy lifecycle & crash recovery

`src/native/pushToTalk.ts` is defensive about the keyspy child process because in practice it dies often (especially EPIPE on its stdio under Electron). The machinery:

- **`loadKeyspy()`** — first tries `require("keyspy")`; on failure (asar packaging), falls back to `require(path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "keyspy", "dist", "index.js"))`. The unpacked path exists because of `packagerConfig.asar.unpack` (see §6).
- **`startKeyspy()`** — instantiates `GlobalKeyboardListener`, attaches error handlers on `proc.stdin`/`stdout`/`stderr`/`exit`/`error`, starts the watchdog, attaches the keyspy listener.
- **Process-level `uncaughtException` for `EPIPE`** (top of module) — caught and routed to `handleKeyspyCrash("epipe-uncaught", ...)` so one stray EPIPE doesn't tear down the app.
- **`startKeyspyWatchdog()`** — every 3s, `process.kill(proc.pid, 0)` to check the process is alive. If not, calls `handleKeyspyCrash("watchdog", ...)`.
- **`handleKeyspyCrash(reason, code, detail)`** — clears held-key state; in hold mode fails closed (`isPttActive = false; sendPttState(false)`); in toggle mode latches the current state; kills the listener; bumps `keyspyRestartAttempts`; waits `2000 + (attempts-1) * 1000` ms; retries `startKeyspy()` up to `MAX_KEYSPY_RESTART_ATTEMPTS = 5`. The `isKeyspyIntentionallyStopped` and `crashHandled` flags prevent loops between the `exit`/`error`/watchdog handlers all firing for the same crash.
- **`unregisterPushToTalkHotkey({ resetState })`** — sets `isKeyspyIntentionallyStopped = true` so crash handlers no-op, kills the process, removes all window listeners, clears state. `resetState` defaults to `true` but is set to `false` when re-registering in hold mode (we don't want a settings change to mute someone mid-push).

### 2.6 Keybind format

`pushToTalkKeybind` is stored in `electron-store` as a **string**. Two formats are supported:

- **Legacy:** a single accelerator string, e.g. `"Shift+V"` or `"F8"`.
- **Multiple keybinds:** a JSON array string, e.g. `'["Shift+V","F8","V"]'`.

Both `parseAccelerators()` in `src/native/pushToTalk.ts` and the matching `parseAccelerators()` in `src/world/pushToTalk.ts` try `JSON.parse` first; if it's not an array, they fall back to treating the whole string as a single accelerator. **Both parsers must stay in sync** — a keybind parsed differently on either side will silently break PTT.

There is also a `keyspyKeyToAccelerator()` map in `src/native/pushToTalk.ts` and a `codeToCharMap` in the same file for matching Windows OEM keys (`Semicolon`, `BracketLeft`, etc.). If you add a new special-key handling on one side, add it on the other.

### 2.7 IPC channels (do not rename without updating the web client)

| Channel | Direction | Payload |
|---|---|---|
| `push-to-talk` | main → renderer | `{ active: boolean }` |
| `push-to-talk-config` | main → renderer | `{ enabled, keybind, mode, releaseDelay }` |
| `push-to-talk-manual` | renderer → main | `{ active: boolean }` |
| `push-to-talk-update-settings` | renderer → main | `{ enabled?, keybind?, mode?, releaseDelay? }` |
| `push-to-talk-request-config` | renderer → main | (none) |

The paired web client fork (`Trifall/stoat-for-web`) listens for `push-to-talk` and renders the mic state in the voice UI (see `client/packages/client/components/rtc/state.tsx` referenced in `SETUP_GUIDE.md`). Renaming channels would break that integration.

### 2.8 The web client is a separate concern

PTT is **only visible in the UI** when the paired `Trifall/stoat-for-web` client has the matching listener code. Without it, the desktop's `push-to-talk` IPC messages still fire but nothing in the UI reacts. If you're testing PTT locally you must run the web client fork — see `SETUP_GUIDE.md`.

---

## 3. `stoat://` Local Web Asset Protocol — `KEEP ON MERGE`

### 3.1 Why it exists

Upstream loads the web client from `https://stoat.chat/app` (formerly `https://beta.revolt.chat`). The fork instead ships the **pre-built web client as a packaged resource** (`web-dist/`) and serves it through a custom `stoat://` Electron protocol, so the desktop app is self-contained and works offline against the production backend.

### 3.2 What was added in `src/native/window.ts`

- **Imports:** `net` and `protocol` from `electron` (added on top of upstream's imports). *After the Electron 40 merge*, `desktopCapturer` and `session` are also imported from upstream's screen picker — both sets of imports must coexist.
- **Scheme registration at module load:**
  ```ts
  protocol.registerSchemesAsPrivileged([{
    scheme: "stoat",
    privileges: { standard: true, secure: true, allowServiceWorkers: true,
                  supportFetchAPI: true, corsEnabled: true },
  }]);
  ```
  This runs at import time (before `app.ready`), which is required by Electron.
- **`initBuildUrl()`** — replaces upstream's top-level `export const BUILD_URL = new URL(...)` with a function called in `app.on("ready")`. It searches three locations for `web-dist/index.html`:
  1. `process.resourcesPath/web-dist` — packaged app
  2. `app.getAppPath()/../web-dist` — dev workspace
  3. `path.dirname(process.execPath)/web-dist` — alongside the exe
  - If found → sets `localWebDir`, calls `setupLocalProtocol()`, sets `BUILD_URL = new URL("stoat://-/index.html")`.
  - If not found (or `--force-server` passed) → falls back to the remote URL (`https://stoat.chat/app` or the `--force-server` value).
- **`BUILD_URL` is now `export let`** (was `export const` in upstream), because it's assigned inside `initBuildUrl()`.
- **`setupLocalProtocol()`** — registers `protocol.handle("stoat", ...)`:
  - Normalizes the path (default `/index.html`, handles `stoat://-/...` form).
  - **Path-traversal guard:** rejects any resolved `filePath` that doesn't start with `localWebDir`.
  - **SPA fallback:** if the resolved file doesn't exist, serves `index.html` instead so client-side routing (e.g. `/server/.../channel/...`) works. This fallback was added by commit `230e9f8` after the original protocol handler broke client-side navigation.

### 3.3 Changes in `src/main.ts`

`initBuildUrl()` is called at the start of `app.on("ready")`, before `createMainWindow()` (which consumes `BUILD_URL`).

The `web-contents-created` `will-navigate` handler was extended to allow `stoat:` URLs through:
```ts
if (url.protocol === "stoat:") return;
```
Plus an `allowedOrigins` list of Stoat/Revolt API+CDN domains the window may navigate to — blocking everything else. Both of these are fork additions.

### 3.4 `webSecurity` flag

In `createMainWindow()`:
```ts
webSecurity: BUILD_URL.protocol === "https:",
```
- `stoat://` (local) → `webSecurity: false` — needed so the local app can hit the HTTPS APIs.
- `https://` (remote) → `webSecurity: true`.

Upstream hard-coded `webSecurity: true`. Don't change this without considering both modes.

### 3.5 Build-time shipping of `web-dist/`

- `forge.config.ts` `packagerConfig.extraResource: ["web-dist"]` ships the directory next to the app.
- `.gitignore` ignores `web-dist` and `**/web-dist` — the directory is **not** committed. It's populated by:
  - **CI:** `build-desktop.yml` checks out `Trifall/stoat-for-web`, builds it with mise, and `cp -r client/packages/client/dist/* web-dist/` before `pnpm package`.
  - **Local dev:** `SETUP_GUIDE.md` documents running the web client dev server and pointing at it with `--force-server=http://localhost:5173`.
- The `prePackage` / `postPackage` hooks in `forge.config.ts` *do not* copy `web-dist` — Forge does that via `extraResource`.

---

## 4. Tray Reload Button — `KEEP ON MERGE`

`src/native/tray.ts` was extended with a **Reload** context menu item:

```ts
{ label: "Reload", type: "normal", click() { mainWindow.webContents.reload(); } }
```

When reloading the window (especially from local `stoat://` assets, where there's no live Vite HMR), the user needed a quick way to re-pull client changes without restarting the whole app. The renderer-side reload that upstream relies on doesn't cover this case.

`window.ts` also calls `updateTrayMenu()` on `mainWindow`'s `show` and `hide` events so the "Show App" / "Hide App" label stays in sync.

These were added in commit `230e9f8` alongside the SPA fallback fix.

---

## 5. Custom CI/CD Workflow — `KEEP ON MERGE`

### 5.1 What was removed

Upstream's `.github/workflows/` shipped:
- `build.yml`
- `git-town.yml`
- `release-please.yml`
- `release-webhook.yml`
- `validate-pr-title.yml`

All five are **deleted** in the fork (we don't use release-please, git-town, or the PR title validator).

### 5.2 What was added

- `.github/workflows/build-desktop.yml` (373 lines) — a single workflow named **"Build Desktop Release"** that:
  - Triggers on `push` of any `v*` tag, or via `workflow_dispatch` with a version input.
  - Runs two build jobs:
    - **`build-linux`** on `ubuntu-latest` → produces `out/make/zip/linux/x64/Stoat-Desktop-linux-x64-<version>.zip`.
    - **`build-windows`** on `windows-latest` → produces `out/make/zip/win32/x64/Stoat-Desktop-win32-x64-<version>.zip`.
  - Each job:
    1. Checks out the desktop repo (this repo) with `fetch-depth: 0`.
    2. Pulls the `assets` submodule with `git submodule update --init assets`.
    3. Checks out `Trifall/stoat-for-web` into `client/` (using `secrets.GITHUB_TOKEN`). The step is gated by `if: ${{ !env.ACT }}` so local `act` runs can supply their own `client/` directory.
    4. Sets up `pnpm`, Node 20, and `mise` (pointed at `client/.mise`).
    5. Builds the web client via `mise build:deps`, audio-asset copy, `mise lingui:extract` / `lingui:compile`, `mise build`.
    6. Copies `client/packages/client/dist/*` into `web-dist/`.
    7. Installs **desktop** deps with `pnpm install --frozen-lockfile`.
    8. Installs platform build deps (Linux: `libx11-dev libxi-dev`; Windows: `mingw` via chocolatey) — needed by the keyspy `prePackage` hook.
    9. Clears the Vite cache (`.vite`).
    10. Runs `pnpm package` then `pnpm make --platform=<platform> --targets=@electron-forge/maker-zip`.
    11. Finds the resulting zip, renames it with the version, uploads as a workflow artifact.
  - **`create-release`** job (only on tag/manual-with-v-prefix) depends on both build jobs, downloads both artifacts, generates a changelog from `git log` between the current and previous `v*` tag, and creates a GitHub Release with `softprops/action-gh-release@v1` attaching both zips.
- `.github/workflows/README.md` (213 lines) — documentation for the workflow, including triggering, customization, `act`-based local testing, and required secrets.

### 5.3 Important invariants

- The workflow **expects** `Trifall/stoat-for-web` to be the web client repo. The README has an explicit customization section telling people who fork the client to update the `repository:` field of the checkout step.
- The zip file naming (`Stoat-Desktop-{linux,win32}-x64-<version>.zip`) is enforced by the "Find ZIP" steps — changing the format means changing those steps and the README.
- Both build jobs assume `pnpm install --frozen-lockfile` — keep `pnpm-lock.yaml` in sync with `package.json` when changing deps.
- The keyspy build deps install step is version-aware enough to not break if upstream bumps Electron. It installs system packages only, no version pinning of pnpm/electron.

### 5.4 Why the upstream workflows were dropped

The fork's release pipeline (build ✕ 2 jobs → single consolidated GitHub Release with changelog) was incompatible with release-please's tag/versioning model, and `validate-pr-title.yml` got in the way of merge-commits-from-upstream. Cherry-picking upstream changes to keep release-please in sync was more effort than hosting our own single workflow.

---

## 6. Package / Packaging Configuration — `KEEP ON MERGE`

### 6.1 `package.json` (we merge with upstream — verify on every merge)

The fork's `package.json` carries forward:

- **`scripts`:**
  - `"start": "electron-forge start -- --no-sandbox"` — **`--no-sandbox` was added by upstream's Electron 40 PR** but is required for the app to run on Linux without root. Preserve it.
  - `"start:x11": "electron-forge start -- --no-sandbox --ozone-platform=x11"` — fork-only. The `--ozone-platform=x11` flag forces XWayland/X11 mode, which is required for PTT to work on Linux (Wayland-native mode doesn't let keyspy grab keys). Documented in `SETUP_GUIDE.md`.
  - `"install:flatpak"`, `"run:flatpak"`, `"run:nix"` — fork-only helpers (the flatpak ones pair with `MakerFlatpak`).
- **`dependencies`:**
  - `keyspy: ^1.1.1` — PTT (see §2).
  - `@homebridge/dbus-native`, `auto-launch`, `bufferutil`, `utf-8-validate` — some are fork-added dependencies for features below.
- **`devDependencies`:**
  - `electron-rebuild: ^3.2.9` — fork-added; needed to rebuild native modules against new Electron versions when upstream bumps Electron. Upstream relies on `@electron-forge/plugin-auto-unpack-natives` instead.
  - `electron: ^40.8.3` — **set by upstream's PR #193**, must stay in sync with upstream.
- **`packageManager`:** `pnpm@10.18.1+sha512:...` — pins pnpm version via Corepack. Critical because the lockfile is `pnpm-lock.yaml` v10.

### 6.2 `forge.config.ts`

Fork additions on top of upstream:

- **`packagerConfig.asar.unpack: "**/node_modules/keyspy/**/*"`** — required because keyspy spawns a native child process that cannot live inside asar. Lose this and packaged PTT silently breaks.
- **`packagerConfig.extraResource: ["web-dist"]`** — ships the web client alongside the app for `stoat://` (see §3).
- **`prePackage(forgeConfig, platform)`** — compiles keyspy's native server binaries at package time:
  - `win32`: compiles `keyspy/native/WinKeyServer/main.cpp` → `keyspy/build/WinKeyServer.exe`. Uses `c++` on Windows or `x86_64-w64-mingw32-g++` (cross-compiling from Linux, links `-luser32 -lkernel32`).
  - `linux`: compiles `keyspy/native/X11KeyServer/main.cpp` → `keyspy/build/X11KeyServer`. Uses `c++ -lX11 -lXi`, then `strip`.
  - Other platforms: relies on prebuilt runtime binaries that ship with the keyspy npm package.
  - Failures are logged as warnings, not fatal — a packaged build on a platform without these toolchains still produces *something*, just without working PTT.
- **`postPackage(forgeConfig, options)`** — recursively copies:
  - `node_modules/keyspy` → `resources/app.asar.unpacked/node_modules/keyspy`
  - `node_modules/@expo/sudo-prompt` → `resources/app.asar.unpacked/node_modules/@expo/sudo-prompt` (needed by auto-launch on some platforms).
- **Makers changed by upstream's Electron 40 PR (#193 + #195):** `MakerFlatpak` was updated with a new `runtimeVersion: "25.08"`, zypak `v2025.09`, refined `finishArgs` (X11/wayland sockets, pipewire, `ELECTRON_TRASH=gio`, etc.), and screenshot URL → URL in metainfo (`#195`). These are upstream changes — keep them when merging.
- **`MakerSquirrel` iconUrl** still points at `https://stoat.chat/app/assets/icon-DUSNE-Pb.ico`.
- **Publishers:** `PublisherGithub` → `{ owner: "stoatchat", name: "for-desktop" }`. Fork release artifacts go to the fork's own releases via `create-release` in the workflow; this publisher is used by `pnpm publish` (rarely run).

### 6.3 `vite.main.config.ts`

```ts
external: ["keyspy", "electron", "bufferutil", "utf-8-validate"]
```
All four must stay external — Vite must not try to bundle them. `keyspy` requires native loading; `bufferutil`/`utf-8-validate` are optional native peers of `ws` (used by `discord-rpc`).

### 6.4 `pnpm-workspace.yaml`

- **`nodeLinker: hoisted`** — required. `keyspy` and the unpacked-modules copy logic assume a flat `node_modules` layout. Switching to `isolated` will break PTT in packaged builds.
- **`onlyBuiltDependencies`:** `bufferutil`, `electron`, `electron-winstaller`, `esbuild`, `register-scheme`, `utf-8-validate` — restricts which packages' install scripts run. Adding native deps without listing them here usually silently breaks them.
- **`patchedDependencies`:** `cross-zip@4.0.1: patches/cross-zip@4.0.1.patch` (see §7).

### 6.5 `assets` submodule

`.gitmodules` points at `https://github.com/stoatchat/assets` (upstream's asset repo). The fork consumes these assets but does **not** host its own copy. CI pulls the submodule with:
```bash
git -c submodule."assets".update=checkout submodule update --init assets
```
The `update = checkout` setting in `.gitmodules` matters when the submodule branch diverges — preserve it.

---

## 7. Cross-zip Patch — `KEEP ON MERGE`

`patches/cross-zip@4.0.1.patch` replaces two deprecated `fs.rmdir(..., { recursive: true })` / `fs.rmdirSync(..., { recursive: true })` calls in `cross-zip`'s `index.js` with `fs.rm(..., { recursive, force })` / `fs.rmSync(...)`. Under the newer Node version bundled with Electron 40, the deprecated `rmdir` recursive form throws.

This patch is applied automatically by pnpm via the `patchedDependencies` entry in `pnpm-workspace.yaml`. If pnpm stops recognizing the patch (e.g. upgrade to pnpm 11), update the patches mechanism. Don't delete the patch file unless upstream bumps `cross-zip` past 4.0.1 and the deprecation is gone upstream.

---

## 8. Config Schema Extensions — `KEEP ON MERGE`

`src/native/config.ts` carries the full `electron-store` schema and a `Config` class with getters/setters. The fork added these fields (with defaults):

| Field | Type | Default | Side effects |
|---|---|---|---|
| `pushToTalk` | boolean | `false` | setter calls `registerPushToTalkHotkey()` or `cleanupPushToTalk()` |
| `pushToTalkKeybind` | string | `"Shift+Space"` | setter re-registers hotkey (if enabled) |
| `pushToTalkMode` | `"hold" \| "toggle"` | `"hold"` | setter re-registers hotkey (if enabled) |
| `pushToTalkReleaseDelay` | number (0–5000) | `0` | no side effect |

`windowState` was already in upstream's schema; the original fork bug was a `config.sync()` call on first launch when `mainWindow` was still null. Commit `f44458e` added a guard at the top of `sync()`:
```ts
sync() {
  if (!mainWindow) return;
  mainWindow.webContents.send("config", {...});
}
```
Don't remove this guard — first-launch crashes otherwise.

The matching `DesktopConfig` type lives in `src/config.d.ts`. **Adding a new config field requires changing three places in lockstep:**
1. `schema` and `defaults` in `src/native/config.ts`
2. The `Config` class getters/setters and the `sync()` payload in `src/native/config.ts`
3. `DesktopConfig` in `src/config.d.ts`

If you forget the `config.d.ts` update, the renderer-side preload will type-check against an incomplete interface.

---

## 9. Files Deleted from Upstream

When merging upstream, these forks deletions must be preserved (do not let `git checkout --theirs` bring them back):

- `.github/workflows/build.yml` — replaced by `build-desktop.yml`
- `.github/workflows/git-town.yml` — not used
- `.github/workflows/release-please.yml` — fork uses `softprops/action-gh-release` directly
- `.github/workflows/release-webhook.yml` — not used
- `.github/workflows/validate-pr-title.yml` — conflicts with upstream-merge commit messages

Also `strings.ts` is an empty file at the repo root (kept around for historical reasons, harmless).

---

## 10. Material Conflict Escalation and User Approval

This section defines how a migration or merge agent must handle conflicts where upstream and the fork have both made important changes to the same subsystem. The goal is to prevent a mechanically valid conflict resolution from silently removing fork behavior, rejecting valuable upstream work, or creating an integration whose product behavior the user did not approve.

### 10.1 When the agent must stop and ask

Do **not** resolve a conflict autonomously when the choice could materially change functionality, architecture, security, packaging, compatibility, persisted data, user-visible behavior, or the maintenance strategy of the fork. Pause before editing that conflict area and ask the user how to proceed.

Examples that require approval include:

- Upstream replaces or substantially redesigns a subsystem extended by this fork, such as window creation, display-media capture, configuration, preload bridges, IPC, PTT, local asset serving, packaging, or CI/CD.
- Preserving the fork implementation would require discarding an important upstream feature, security fix, migration, API change, or architectural change.
- Adopting upstream would remove, weaken, or substantially rewrite a feature tagged **KEEP ON MERGE**.
- Both implementations are individually valid but cannot coexist without choosing product behavior, such as audio capture semantics, navigation policy, startup behavior, update behavior, release strategy, or platform support.
- A dependency, Electron API, native module, or build-tool upgrade makes an existing fork implementation obsolete, unsupported, or unsafe.
- The apparent resolution requires compatibility code, data migration, new dependencies, significant refactoring, or changes in the paired `Trifall/stoat-for-web` repository.
- Tests and documentation do not establish the intended behavior well enough to choose safely.

Routine conflicts may still be resolved without interruption when the correct integration is unambiguous and behavior-preserving. Examples include formatting-only conflicts, lockfile regeneration after an already-approved dependency merge, combining non-overlapping imports, accepting an upstream version bump while retaining required fork dependencies, or preserving an explicitly documented upstream-file deletion.

### 10.2 Required analysis before asking

For **each affected subsystem**, investigate both sides before asking the user. Do not present a generic "which side should I keep?" question. Provide:

1. **Conflict area:** the subsystem and exact files/functions involved.
2. **Fork behavior:** what the fork currently does, why it exists, and which other files or repositories depend on it.
3. **Upstream behavior:** what upstream changed, what problem it solves, and whether it replaces or merely overlaps the fork implementation.
4. **Compatibility assessment:** what can coexist, what cannot, and any API, lifecycle, security, packaging, persistence, or platform implications.
5. **Recommended integration:** the preferred approach and why it best preserves the fork while incorporating upstream improvements.
6. **Alternatives:** concise viable options, including the effect and risk of each option.
7. **Validation plan:** the tests, builds, or manual checks that will verify the selected approach.

The recommendation should normally be **integrate both implementations**, adapting the fork to the new upstream architecture rather than blindly choosing `ours` or `theirs`. Recommend dropping fork behavior only when it is genuinely obsolete, duplicated by upstream, unsafe, or explicitly no longer wanted.

### 10.3 Ask separately by decision area

Ask for a decision on each materially different area. Do not bundle unrelated choices into one broad approval request. For example, screen-sharing integration, PTT lifecycle changes, local protocol changes, and CI/release changes should be separate decisions even if they appear in the same merge.

Use a structure similar to:

```text
Conflict area: Screen-sharing audio in src/native/window.ts

Fork behavior: ...
Upstream change: ...
Compatibility/risk: ...

Recommended: Integrate upstream's picker while preserving the fork's local
protocol and navigation behavior, because ...

Options:
1. Integrate both (recommended): ...
2. Prefer upstream: ...
3. Preserve the fork implementation: ...

Which approach should I apply for this area?
```

When the interaction supports selectable choices, put the recommended option first and clearly label it **Recommended**. Allow the user to provide a custom response instead of forcing one of the listed options.

### 10.4 State management while waiting

- Keep the repository in its current merge state while waiting for the answer; do not abort, reset, commit, or push unless the user asks.
- It is acceptable to resolve independent, routine conflicts while a material decision is pending, but do not edit the disputed area in a way that prejudges the user's choice.
- Record the user's decision and apply it only to the corresponding area. If implementation reveals a materially different tradeoff from the one approved, stop and ask again.
- After all material decisions are approved and implemented, summarize how each area was resolved before committing.
- Never interpret silence, an unrelated response, or general permission to "merge upstream" as approval to remove a documented fork feature.

---

## 11. Upstream Merge Checklist

Use this whenever merging `upstream/main` into `main`. Past merges have historically lost one or more of the items below.

### Distinguish an upstream merge from local branch reconciliation

Do not start another upstream merge merely because local `main` is behind `origin/main`. A common situation is:

- GitHub already merged current upstream into fork `origin/main` with a real merge commit.
- Local `main` still has unpublished fork-only commits based on the previous fork tip.
- Local `main` is therefore both ahead of and behind `origin/main`, even though the GitHub fork is already 0 commits behind upstream.

In that specific case, rebasing the **unpublished local fork commits** onto `origin/main` is appropriate and does not replace or rewrite the upstream merge already present on the remote:

```bash
git fetch --all --prune
git merge-base --is-ancestor upstream/main origin/main
git branch backup/main-pre-reconcile-YYYYMMDD main
git rebase origin/main
git range-diff <old-base>..backup/main-pre-reconcile-YYYYMMDD origin/main..main
```

Review every skipped commit. Git may skip a local patch when upstream independently landed an equivalent fix; compare both diffs before accepting the skip. Push normally after verification; never force-push. Do **not** use this exception to import upstream by rebase, rebase commits already shared on `origin/main`, or bypass the required upstream merge commit. If `origin/main` does not contain the upstream tip, follow the real merge process below instead.

1. **Fetch both remotes and inspect divergence:** `git fetch --all --prune`, then check `git status --short --branch`, `git rev-list --left-right --count main...origin/main`, and `git rev-list --left-right --count main...upstream/main` before deciding whether this is an upstream merge or local branch reconciliation.
2. **Start a real merge (not a cherry-pick):** `git merge upstream/main --no-ff --no-commit` — preserves upstream history and avoids the "x commits behind" indicator.
3. **Classify conflicts before resolving them:** compare both sides and §2–§9 of this document. Resolve routine, behavior-preserving conflicts directly. For every material behavioral or architectural conflict, follow §10 and obtain a separate user decision for that area before editing it.
4. **Expected routine conflicts and their usual resolutions:** these instructions apply only while the underlying behavior still matches this document. If upstream has substantially redesigned one of these areas, treat it as a material conflict under §10 instead of applying this recipe blindly.
   - `.github/workflows/release-webhook.yml` and `.github/workflows/validate-pr-title.yml` (modify/delete) → `git rm` them (keep our deletion). The fork does not use release-please or the PR title validator.
   - `package.json`:
     - Keep the fork's `scripts.start:x11`, `install:flatpak`, `run:flatpak`, `run:nix`.
     - Keep `--no-sandbox` on `start` (added by upstream PR #193 — keep it).
     - Keep `electron-rebuild` in devDeps.
     - Keep `keyspy` in dependencies.
     - Adopt upstream's `electron: ^<latest>` version.
   - `pnpm-lock.yaml` → `git checkout --theirs pnpm-lock.yaml`, then `pnpm install --no-frozen-lockfile` to regenerate.
   - `src/native/window.ts`:
     - Keep `net` and `protocol` imports (fork).
     - Add upstream's new `desktopCapturer` and `session` imports (from the Electron 40 PR).
     - Keep `initBuildUrl()`, the privileged `stoat` scheme, `setupLocalProtocol()`, `localWebDir`, and `BUILD_URL` as `export let`.
     - Adopt upstream's `setDisplayMediaRequestHandler` + screen picker IPC inside `createMainWindow()`.
     - Update the fallback URL inside `initBuildUrl()` to `https://stoat.chat/app` (upstream) — *not* `https://beta.revolt.chat`.
   - `forge.config.ts` — usually auto-merges, but verify:
     - `asar.unpack: "**/node_modules/keyspy/**/*"` preserved.
     - `extraResource: ["web-dist"]` preserved.
     - `prePackage` / `postPackage` hooks preserved.
     - New upstream flatpak/metainfo changes (e.g. `runtimeVersion`, zypak tag, screenshot URL) adopted.
5. **Review approved decisions:** before staging, summarize each material area, the user's selected approach, and how the implementation reflects it. Ask again if the implemented tradeoff differs materially from what was approved.
6. **After resolving:** `git add -A`, `git commit` (uses `.git/MERGE_MSG`).
7. **Sanity checks before pushing:**
   - `grep -r '<<<<<<<' .` returns nothing.
   - `npx tsc --noEmit` — expect pre-existing parser errors under `node_modules/type-fest` and `node_modules/@types/node`, but no errors in `src/`. The fork runs TypeScript 4.5.4 — don't try to "fix" dependency declarations in `node_modules`.
   - `pnpm package` succeeds locally (or at least `npx tsc --noEmit` + a `pnpm install`).
   - `pnpm lint` — pre-existing errors are expected; the merge must not **add** any.
8. **Commit message:** keep the auto-generated `Merge remote-tracking branch 'upstream/main'`. Edit only to add a one-line summary of conflict resolutions if helpful.
9. **Fetch immediately before pushing:** fetch `origin` and `upstream` again. Confirm both `git merge-base --is-ancestor origin/main main` and `git merge-base --is-ancestor upstream/main main` succeed, then `git push origin main`. The merge commit keeps the branch in sync with `upstream/main` (no "x commits behind" on the fork page).
10. **PR cleanup:** if the merge was triggered by a PR on the fork, GitHub usually auto-closes it once `main` advances past the head branch. Otherwise close manually.
11. **Verify GitHub's comparison:** local refs are not the final authority. Run `gh api repos/stoatchat/for-desktop/compare/main...Trifall:main --jq '{status: .status, ahead_by: .ahead_by, behind_by: .behind_by}'` and require `behind_by: 0`.

---

## 12. Known Issues / Gotchas

Things that look like bugs but are actually load-bearing:

- **`src/native/badges.ts` is never imported by `main.ts`.** The `ipcMain.on("setBadgeCount", ...)` listener it registers never fires; `window.native.setBadgeCount()` calls from the renderer are dropped silently. This is a **pre-existing fork condition**, *not* a merge regression. Fixing it is a separate task — but do not be alarmed during merges if a "missing setBadgeCount handler" appears in logs.
- **`tsconfig.json` has `types: ["electron-vite/node"]` but `electron-vite` isn't a direct dep** — works because the package is hoisted transitively. Pre-existing, presumably stale, harmless. Leave alone.
- **`tsconfig.json#outDir: "dist"` is unused** — the real build output is `.vite/build/` per `package.json#main`. Pre-existing.
- **TypeScript 4.5.4 produces parser errors under `node_modules/type-fest` and `node_modules/@types/node`** — pre-existing dependency declarations use syntax this compiler cannot parse. These errors come from `node_modules`; there should still be no errors in `src/`. Don't edit `node_modules` to suppress them — pin compatible dependency types or handle a TypeScript upgrade as a separate migration.
- **Six pre-existing ESLint errors / four warnings on `main` after upstream 1.4.2** — the extra warning is the unused `autoLaunch` import left when upstream stopped enabling autostart on first launch. The merge must not introduce additional problems, but it is fine for `pnpm lint` to exit non-zero. Compare counts and paths against the pre-merge tip rather than treating a non-zero exit alone as a regression.
- **`start:x11` is required for Linux PTT** — under native Wayland, keyspy can't grab keys. `--ozone-platform=x11` forces XWayland on Linux. `SETUP_GUIDE.md` documents this.
- **`web-dist/` is intentionally git-ignored** — don't commit it. The CI workflow populates it from the web client build.
- **`--no-sandbox` is required** — it's in `start` and `start:x11` for a reason; the app can't run on Linux as a regular user otherwise.
- **PTT keybind parser duplication** — `parseAccelerators()` exists in both `src/native/pushToTalk.ts` and `src/world/pushToTalk.ts`. They must parse identically. If you change one, change the other.
- **Preload's `setManualState` updates `currentPttState` itself** before telling the main process — this means UI toggles feel instant but the canonical state still lives in the main process; if the two get out of sync the user will see a flicker. Don't "fix" by removing the optimistic update.
- **Circular imports** between `config.ts ↔ discordRpc.ts`, `config.ts ↔ pushToTalk.ts`, `window.ts ↔ tray.ts` — work fine under CommonJS because the exports are functions/objects resolved lazily. Don't refactor to ESM without testing.

---

*Last updated: after syncing upstream 1.4.2 and rebasing unpublished PTT lifecycle fixes onto the fork's existing upstream merge.*
