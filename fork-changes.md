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
13. [Wayland Virtual Microphone](#13-wayland-virtual-microphone)

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
.github/build/appimage/                 |   3 files
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
src/native/virtualMic.ts                |  new
src/native/window.ts                    | 150 +++-
src/preload.ts                          |  1 +
src/world/pushToTalk.ts                 | 280 ++++++++++    (new)
strings.ts                              |   0
vite.main.config.ts                     |  14 +-
```

| Category                | Files                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| New feature modules     | `src/native/pushToTalk.ts`, `src/world/pushToTalk.ts`, `src/native/virtualMic.ts`                                     |
| Modified native modules | `src/native/window.ts`, `src/native/config.ts`, `src/native/tray.ts`                                                  |
| Modified entry points   | `src/main.ts`, `src/preload.ts`, `src/config.d.ts`                                                                    |
| Build config            | `forge.config.ts`, `vite.main.config.ts`, `package.json`, `pnpm-workspace.yaml`, `patches/cross-zip@4.0.1.patch`      |
| CI/CD                   | `.github/workflows/build-desktop.yml`, `.github/workflows/README.md` (replaces upstream's release/validate workflows) |
| Docs                    | `README.md`, `SETUP_GUIDE.md`, `fork-changes.md` (this file)                                                          |

---

## 2. Push-to-Talk (PTT) — `KEEP ON MERGE`

The single biggest fork addition. PTT lets users hold/toggle a hotkey to unmute their mic in voice channels, with global hotkey detection that works even when the app is unfocused (a hard problem on Linux Wayland).

### 2.1 Why it exists

Upstream has no push-to-talk. The fork needed:

- **Hold mode** (press-to-talk, release-to-mute) with optional release delay.
- **Toggle mode** (one press = unmute, next press = mute).
- **Global hotkey**: fire even when the app is blurred, on Linux (XWayland) and Windows.
- **Allow typing the PTT key** in chat when the window _is_ focused.
- **Multiple keybinds** stored as a JSON array (with a single-string legacy fallback).

Neither Electron's `globalShortcut` nor `iohook` worked reliably, so the fork eventually settled on the **`keyspy`** native module, which spawns a separate native binary per platform (`WinKeyServer.exe` on Windows, `X11KeyServer` on Linux, `MacKeyServer` on macOS) and communicates over stdio.

### 2.2 Files involved

| Path                                   | Role                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/native/pushToTalk.ts` (882 lines) | **Main-process PTT engine.** Loads `keyspy`, registers IPC, manages keyspy lifecycle, watchdog, crash recovery, hold/toggle logic, window focus/blur handling, and the dual input path (focused `before-input-event` vs blurred keyspy global events).                                                                                                                    |
| `src/world/pushToTalk.ts` (280 lines)  | **Preload/renderer bridge.** Exposes `window.pushToTalk` with `onStateChange`, `setManualState`, `getCurrentState`, `isAvailable`, `updateSettings`, `getConfig`, `onConfigChange`, etc. Adds capture-phase `keydown`/`keyup` DOM listeners to stop propagation of the PTT key (so the web client's own handlers don't fire) while still allowing typing in input fields. |
| `src/preload.ts`                       | Imports `./world/pushToTalk` so the bridge loads.                                                                                                                                                                                                                                                                                                                         |
| `src/config.d.ts`                      | Type declarations for `window.pushToTalk` and the `DesktopConfig` PTT fields.                                                                                                                                                                                                                                                                                             |
| `src/native/config.ts`                 | Adds `pushToTalk`, `pushToTalkKeybind`, `pushToTalkMode`, `pushToTalkReleaseDelay` to the `electron-store` schema + setters with side effects (re-registering/cleaning up the hotkey).                                                                                                                                                                                    |
| `src/main.ts`                          | Imports `initPushToTalk` / `cleanupPushToTalk`. Calls `initPushToTalk()` in `app.on("ready")` (after `initDiscordRpc()`). Calls `cleanupPushToTalk()` on `window-all-closed` and `before-quit`.                                                                                                                                                                           |
| `forge.config.ts`                      | `packagerConfig.asar.unpack = "**/node_modules/keyspy/**/*"` (keyspy spawns a native child process and cannot live inside asar) and `prePackage`/`postPackage` hooks that compile keyspy's native server binaries at package time and copy `keyspy` + `@expo/sudo-prompt` into `app.asar.unpacked/node_modules/`.                                                         |
| `vite.main.config.ts`                  | Marks `keyspy` (and `bufferutil`, `utf-8-validate`) as `external` — they must not be bundled by Vite.                                                                                                                                                                                                                                                                     |
| `package.json`                         | Declares `keyspy: ^1.1.1` as a runtime dependency and `electron-rebuild: ^3.2.9` as a dev dependency (used to rebuild native modules against Electron's headers).                                                                                                                                                                                                         |
| `pnpm-workspace.yaml`                  | `nodeLinker: hoisted` — keyspy expects a hoisted node_modules layout. Its `allowBuilds` map includes native dependencies such as `keyspy`, `lzma-native`, `bufferutil`, and `utf-8-validate`.                                                                                                                                                                             |
| `.github/workflows/build-desktop.yml`  | Installs `libx11-dev libxi-dev` on Linux and `mingw` on Windows so the `prePackage` hook can compile the keyspy servers.                                                                                                                                                                                                                                                  |
| `assets` submodule                     | Provides the desktop tray icon. (Not PTT-specific but related — see §6.)                                                                                                                                                                                                                                                                                                  |

### 2.3 How it boots

`src/main.ts` inside `app.on("ready")`:

```ts
// create window and application contexts
createMainWindow();
initTray();
initDiscordRpc();
initPushToTalk(); // <-- fork
```

And on shutdown:

```ts
app.on("window-all-closed", () => {
  cleanupPushToTalk(); // <-- fork
  if (process.platform !== "darwin") {
    process.kill(process.pid, "SIGKILL");
  }
});

app.on("before-quit", () => {
  cleanupPushToTalk(); // <-- fork
});
```

`initPushToTalk()` (`src/native/pushToTalk.ts:811`) registers three IPC handlers:

- `push-to-talk-manual` — renderer can manually set PTT on/off (for on-screen mic buttons).
- `push-to-talk-update-settings` — renderer can change `enabled`, `keybind`, `mode`, `releaseDelay`. Writes through to `electron-store` and re-registers the hotkey if `enabled` flipped.
- `push-to-talk-request-config` — renderer asks for current config (sent on preload load).

If `config.pushToTalk` is true at boot, `initPushToTalk()` also calls `registerPushToTalkHotkey()`.

### 2.4 The dual input path (important — don't collapse it)

PTT input is collected from **two** sources depending on window focus:

1. **Window focused** → Electron's `webContents.on("before-input-event", handleBeforeInputEvent)` is used. The event is _not_ `preventDefault`'d so the user can still **type** the PTT key in chat. The DOM-level listener in `src/world/pushToTalk.ts` stops propagation _after_ letting the keystroke through, so the web client never fires its own handlers twice.
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

| Channel                        | Direction       | Payload                                        |
| ------------------------------ | --------------- | ---------------------------------------------- |
| `push-to-talk`                 | main → renderer | `{ active: boolean }`                          |
| `push-to-talk-config`          | main → renderer | `{ enabled, keybind, mode, releaseDelay }`     |
| `push-to-talk-manual`          | renderer → main | `{ active: boolean }`                          |
| `push-to-talk-update-settings` | renderer → main | `{ enabled?, keybind?, mode?, releaseDelay? }` |
| `push-to-talk-request-config`  | renderer → main | (none)                                         |

The paired web client fork (`Trifall/stoat-for-web`) listens for `push-to-talk` and renders the mic state in the voice UI (see `client/packages/client/components/rtc/state.tsx` referenced in `SETUP_GUIDE.md`). Renaming channels would break that integration.

### 2.8 The web client is a separate concern

PTT is **only visible in the UI** when the paired `Trifall/stoat-for-web` client has the matching listener code. Without it, the desktop's `push-to-talk` IPC messages still fire but nothing in the UI reacts. If you're testing PTT locally you must run the web client fork — see `SETUP_GUIDE.md`.

---

## 3. `stoat://` Local Web Asset Protocol — `KEEP ON MERGE`

### 3.1 Why it exists

Upstream loads the web client from `https://stoat.chat/app` (formerly `https://beta.revolt.chat`). The fork instead ships the **pre-built web client as a packaged resource** (`web-dist/`) and serves it through a custom `stoat://` Electron protocol, so the desktop app is self-contained and works offline against the production backend.

### 3.2 What was added in `src/native/window.ts`

- **Imports:** `net` and `protocol` from `electron` (added on top of upstream's imports). _After the Electron 40 merge_, `desktopCapturer` and `session` are also imported from upstream's screen picker — both sets of imports must coexist.
- **Scheme registration at module load:**
  ```ts
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "stoat",
      privileges: {
        standard: true,
        secure: true,
        allowServiceWorkers: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
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
- The `prePackage` / `postPackage` hooks in `forge.config.ts` _do not_ copy `web-dist` — Forge does that via `extraResource`.

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

- `.github/workflows/build-desktop.yml` — a single workflow named **"Build Desktop Release"** that:
  - Triggers on `push` of any `v*` tag, or via `workflow_dispatch` with a version input.
  - Runs two build jobs:
    - **`build-linux`** on `ubuntu-latest` → produces `out/make/zip/linux/x64/Stoat-Desktop-linux-x64-<version>.zip`.
    - **`build-windows`** on `windows-2022` → produces `out/make/zip/win32/x64/Stoat-Desktop-win32-x64-<version>.zip`.
  - Each job:
    1. Checks out the desktop repo (this repo) with `fetch-depth: 0`.
    2. Pulls the `assets` submodule with `git submodule update --init assets`.
    3. Checks out `Trifall/stoat-for-web` into `client/` (using `secrets.GITHUB_TOKEN`). The step is gated by `if: ${{ !env.ACT }}` so local `act` runs can supply their own `client/` directory.
    4. Sets up `pnpm`, Node 24 for the paired web build, and `mise` (pointed at `client/.mise`, whose config controls the client task runtime).
    5. Builds the web client through mise tasks on Linux and equivalent direct pnpm commands on Windows, with audio-asset setup and Lingui extraction/compilation on both platforms.
    6. Copies `client/packages/client/dist/*` into `web-dist/`.
    7. Switches to Node 22, then installs **desktop** deps with `pnpm install --frozen-lockfile`.
    8. Installs platform build deps (Linux: `libx11-dev libxi-dev`; Windows: `mingw` via chocolatey) — needed by the keyspy `prePackage` hook.
    9. Clears the Vite cache and platform-specific package/ZIP output.
    10. Runs one explicit x64 `pnpm package`, then reuses that output with `pnpm make --platform=<platform> --arch=x64 --targets=zip --skip-package`.
    11. Finds the resulting zip, renames it with the version, uploads as a workflow artifact.
- **`create-release`** job (only on tag/manual-with-v-prefix) depends on both build jobs, downloads both artifacts, generates a changelog from `git log` between the current and previous `v*` tag, and creates a GitHub Release with `softprops/action-gh-release@v3` attaching both zips.
- **`build-appimage`** depends on the completed Linux ZIP, wraps that self-contained package in an x64 AppImage, emits matching zsync metadata, and uploads both without rebuilding the desktop or paired web client.
- **`create-release`** also downloads the AppImage artifacts and attaches the ZIP, AppImage, and zsync files to the same release.
- `.github/workflows/README.md` — documentation for the workflow, including triggering, customization, `act`-based local testing, and required secrets.

### 5.3 Important invariants

- The workflow **expects** `Trifall/stoat-for-web` to be the web client repo. The README has an explicit customization section telling people who fork the client to update the `repository:` field of the checkout step.
- The zip file naming (`Stoat-Desktop-{linux,win32}-x64-<version>.zip`) is enforced by the "Find ZIP" steps — changing the format means changing those steps and the README.
- Both build jobs assume `pnpm install --frozen-lockfile` — keep `pnpm-lock.yaml` in sync with `package.json` when changing deps.
- The keyspy build deps install step is version-aware enough to not break if upstream bumps Electron. It installs system packages only, no version pinning of pnpm/electron.
- Keep `jdx/mise-action` on v4 or newer. Current client mise installs Node and pnpm from `client/.mise/config.toml`; on Windows, these tools require the action's `mise-shim.exe` setup. Mise 2026.7.7 can still lose Node at its nested Windows task-process boundary even while PowerShell resolves Node correctly, so the Windows job expands the relevant `client/.mise/tasks/` operations into direct pnpm commands. Keep those commands synchronized with the client tasks. Do not "fix" this by reconstructing PATH from machine/user environment variables because that drops paths GitHub added through `GITHUB_PATH`.
- Keep the Windows release job on `windows-2022`, run `ilammy/msvc-dev-cmd` before installing client or desktop dependencies, and set `npm_config_msvs_version: "2022"`. The Git-hosted `register-scheme` dependency invokes `node-gyp` during installation and requires a discoverable Visual Studio C++ toolchain.
- Use the configured `MakerZIP` target name `zip`. Package once and use `--skip-package`; deleting `out/Stoat-<platform>-x64` before `make` removes the package that `--skip-package` needs. Forge 7.11's progress renderer may leave the initial target list blank even when the target resolved; the subsequent `Making a zip distributable` task is authoritative.
- Keep Electron Forge package/make and desktop dependency installation on Node 22. Forge 7.11 with `@electron/packager` 18.4.4 can silently exit at `Finalizing package` on Node 24 with status 0 and no package output (`electron/forge#4282`). Node 24 remains the paired web build runtime and the GitHub Actions themselves remain on Node 24-capable action majors.
- Keep the workflow actions on Node 24-capable major versions or newer: `actions/checkout@v7`, `actions/setup-node@v7`, `actions/upload-artifact@v7`, `actions/download-artifact@v8`, `pnpm/action-setup@v6`, and `softprops/action-gh-release@v3`. Older majors emit Node 20 action-runtime deprecation warnings even when the configured build toolchain itself is newer.
- Both web-client build steps must set `VITE_CFG_ENABLE_VIDEO: "true"`. The client's local ignored `.env` enables camera/screenshare for developer builds, but CI checkouts do not contain it. Omitting the workflow environment variable produces a valid bundle whose camera and screen-share buttons say "Coming soon!" despite the desktop screen-picker integration being present.
- Both web-client build steps must set `VITE_RELEASE_TAG` from the workflow version input or pushed tag. The paired client uses this build-time value in its settings sidebar and falls back to its upstream package version when it is absent.
- The AppImage flow must consume the fork's renamed `Stoat-Desktop-linux-x64-<version>.zip`, keep updater metadata pointed at `Trifall/stoat-for-desktop`, and preserve the complete packaged directory including `resources/web-dist` and unpacked native modules.
- Keep the AppImage container's explicit GTK, AT-SPI, CUPS, Cairo, Pango, X11, and xkbcommon runtime providers. Sharun aborts before bundling when Electron-linked libraries are absent from the build container.
- Keep the AppImage container digest, Anylinux script/source commit, hook source, and versions/checksums for appimagetool, Sharun, mkdwarfs, and uruntime pinned. Release jobs must not execute mutable `latest` images, branch-head packaging scripts, or unverified tool binaries.
- Keep the release-ref validation job ahead of both platform builds so an existing tag cannot receive assets built from a different manual-dispatch commit.
- Release instructions must tell users to extract the complete archive into a fresh directory. Copying only the executable omits `resources/web-dist` and makes the app silently use the remote fallback client.

### 5.4 Why the upstream workflows were dropped

The fork's release pipeline (build ✕ 2 jobs → single consolidated GitHub Release with changelog) was incompatible with release-please's tag/versioning model, and `validate-pr-title.yml` got in the way of merge-commits-from-upstream. Cherry-picking upstream changes to keep release-please in sync was more effort than hosting our own single workflow.

---

## 6. Package / Packaging Configuration — `KEEP ON MERGE`

### 6.1 `package.json` (we merge with upstream — verify on every merge)

The fork's `package.json` carries forward:

- **`scripts`:**
  - `"start": "electron-forge start -- --no-sandbox"` — **`--no-sandbox` was added by upstream's Electron 40 PR** but is required for the app to run on Linux without root. Preserve it.
  - `"start:x11": "electron-forge start -- --no-sandbox --ozone-platform=x11"` — fork-only. The `--ozone-platform=x11` flag forces XWayland/X11 mode, which is required for PTT to work on Linux (Wayland-native mode doesn't let keyspy grab keys). Documented in `SETUP_GUIDE.md`.
  - `"install:flatpak"`, `"run:flatpak"`, `"run:nix"` — preserve these platform test helpers; the Flatpak scripts use the upstream `chat.stoat.StoatDesktop` application ID.
- **`dependencies`:**
  - `keyspy: ^1.1.1` — PTT (see §2).
  - `@homebridge/dbus-native`, `auto-launch`, `bufferutil`, `utf-8-validate` — some are fork-added dependencies for features below.
- **`devDependencies`:**
  - `electron-rebuild: ^3.2.9` — fork-added; needed to rebuild native modules against new Electron versions when upstream bumps Electron. Upstream relies on `@electron-forge/plugin-auto-unpack-natives` instead.
  - `electron: 44.3.0` (exact) — adopted from upstream 1.5.4; native ABI and packaged PTT require revalidation when this changes.
  - `@electron-forge/plugin-auto-unpack-natives: ^7.11.2` — required for the `node-pipewire` native binding.
- **`packageManager`:** `pnpm@11.17.0+sha512:...` — pins pnpm via Corepack and matches `.mise/config.toml`. Regenerate and verify the lockfile with this version.

### 6.2 `forge.config.ts`

Fork additions on top of upstream:

- **`packagerConfig.asar.unpack: "**/node_modules/keyspy/**/\*"`** — required because keyspy spawns a native child process that cannot live inside asar. Lose this and packaged PTT silently breaks.
- **`packagerConfig.extraResource: ["web-dist"]`** — ships the web client alongside the app for `stoat://` (see §3).
- **Platform icon selection** — macOS uses the liquid-glass `.icon` asset while other platforms retain the existing icon base. Upstream's blanket `osxSign.optionsForFile` configuration is intentionally not carried because post-package native copies would invalidate the signature and one minimal entitlement set is unsafe for every helper.
- **`packageAfterCopy`** — on Linux, stages only `node-pipewire`'s runtime `dist`, `LICENSE`, and `package.json` before asar/signing. The auto-unpack-natives plugin keeps its native binding outside asar.
- **`prePackage(forgeConfig, platform)`** — compiles keyspy's native server binaries at package time:
  - `win32`: compiles `keyspy/native/WinKeyServer/main.cpp` → `keyspy/build/WinKeyServer.exe`. Uses `c++` on Windows or `x86_64-w64-mingw32-g++` (cross-compiling from Linux, links `-luser32 -lkernel32`).
  - `linux`: compiles `keyspy/native/X11KeyServer/main.cpp` → `keyspy/build/X11KeyServer`. Uses `c++ -lX11 -lXi`, then `strip`.
  - Other platforms: relies on prebuilt runtime binaries that ship with the keyspy npm package.
  - Failures are logged as warnings, not fatal — a packaged build on a platform without these toolchains still produces _something_, just without working PTT.
- **`postPackage(forgeConfig, options)`** — recursively copies:
  - `node_modules/keyspy` → `resources/app.asar.unpacked/node_modules/keyspy`
  - `node_modules/@expo/sudo-prompt` → `resources/app.asar.unpacked/node_modules/@expo/sudo-prompt` (needed by auto-launch on some platforms).
- **Flatpak configuration:** `MakerFlatpak` uses application ID `chat.stoat.StoatDesktop`, runtime `25.08`, zypak `v2025.09`, and the current socket, PipeWire, filesystem, and environment permissions. Keep the maker configuration available for local builds, but do not add Flatpak publication to the fork's release workflow without a separate decision. Upstream 1.5.4 sets a runtime `TMPDIR` under `FLATPAK_ID` in `src/main.ts` for tray-icon visibility (user-approved 9/22 even though it targets the same path removed from the manifest for the single-instance lock); the manifest itself keeps no `TMPDIR`/`ELECTRON_TRASH` env, and `run:flatpak` runs without `--socket=session-bus`.
- **`MakerSquirrel` iconUrl** still points at `https://stoat.chat/app/assets/icon-DUSNE-Pb.ico`.
- **Publishers:** `PublisherGithub` → `{ owner: "stoatchat", name: "for-desktop" }`. Fork release artifacts go to the fork's own releases via `create-release` in the workflow; this publisher is used by `pnpm publish` (rarely run).

### 6.3 `vite.main.config.ts`

```ts
external: [
  "keyspy",
  "electron",
  "bufferutil",
  "utf-8-validate",
  "node-pipewire",
];
```

All five must stay external — Vite must not try to bundle them. `keyspy` and `node-pipewire` require native loading; `bufferutil`/`utf-8-validate` are optional native peers of `ws` (used by `discord-rpc`).

### 6.4 `pnpm-workspace.yaml`

- **`nodeLinker: hoisted`** — required. `keyspy` and the unpacked-modules copy logic assume a flat `node_modules` layout. Switching to `isolated` will break PTT in packaged builds.
- **`allowBuilds`:** explicitly permits install scripts for `bufferutil`, `electron`, `electron-winstaller`, `esbuild`, `keyspy`, `lzma-native`, `node-pipewire`, `register-scheme`, and `utf-8-validate`. Adding a native dependency without approving its build usually breaks frozen installs or packaged behavior.
- **`blockExoticSubdeps: false`:** required for the Git dependency used by `discord-rpc`.
- **`patchedDependencies`:** `cross-zip@4.0.1: patches/cross-zip@4.0.1.patch` (see §7).
- **`overrides.yauzl: ^3.3.1`:** preserves upstream's Node 26 extraction compatibility fix.
- **`minimumReleaseAgeExclude`:** narrowly exempts exact `node-pipewire@1.1.0` (the `electron@43.4.0` entry was dropped with the upstream 1.5.4 Electron 44 bump); do not broaden the inherited seven-day cooldown policy.

### 6.5 `assets` submodule

`.gitmodules` points at `https://github.com/stoatchat/assets` (upstream's asset repo). The fork consumes these assets but does **not** host its own copy. CI pulls the submodule with:

```bash
git -c submodule."assets".update=checkout submodule update --init assets
```

The `update = checkout` setting in `.gitmodules` matters when the submodule branch diverges — preserve it.

The `mise assets` task initializes the pinned submodule without first deinitializing it. Do not restore an automatic `assets:fallback` dependency or another forced deinit step; routine asset setup must not discard local submodule work.

---

## 7. Cross-zip Patch — `KEEP ON MERGE`

`patches/cross-zip@4.0.1.patch` replaces two deprecated `fs.rmdir(..., { recursive: true })` / `fs.rmdirSync(..., { recursive: true })` calls in `cross-zip`'s `index.js` with `fs.rm(..., { recursive, force })` / `fs.rmSync(...)`. Under the newer Node version bundled with Electron 40, the deprecated `rmdir` recursive form throws.

This patch is applied automatically by pnpm via the `patchedDependencies` entry in `pnpm-workspace.yaml`. Don't delete the patch file unless upstream bumps `cross-zip` past 4.0.1 and the deprecation is gone upstream.

---

## 8. Config Schema Extensions — `KEEP ON MERGE`

`src/native/config.ts` carries the full `electron-store` schema and a `Config` class with getters/setters. The fork added these fields (with defaults):

| Field                    | Type                 | Default         | Side effects                                                       |
| ------------------------ | -------------------- | --------------- | ------------------------------------------------------------------ |
| `pushToTalk`             | boolean              | `false`         | setter calls `registerPushToTalkHotkey()` or `cleanupPushToTalk()` |
| `pushToTalkKeybind`      | string               | `"Shift+Space"` | setter re-registers hotkey (if enabled)                            |
| `pushToTalkMode`         | `"hold" \| "toggle"` | `"hold"`        | setter re-registers hotkey (if enabled)                            |
| `pushToTalkReleaseDelay` | number (0–5000)      | `0`             | no side effect                                                     |

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
- `.github/workflows/multiplatform_build.yml` — upstream validation does not bundle the paired web client, uses an incompatible packaging runtime, and omits fork native build dependencies

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
   - Upstream `.github/workflows/build.yml`, `release-please.yml`, `release-webhook.yml`, `git-town.yml`, `validate-pr-title.yml`, and `multiplatform_build.yml` (modify/delete or clean addition) → keep the fork's deletion. The fork uses `build-desktop.yml` instead.
   - `package.json`:
     - Keep the fork's `scripts.start:x11`, `install:flatpak`, `run:flatpak`, `run:nix`.
     - Keep `--no-sandbox` on `start` (added by upstream PR #193 — keep it).
     - Keep `electron-rebuild` in devDeps.
     - Keep `keyspy` in dependencies.
     - Adopt upstream's approved `electron: ^<latest>` version and preserve exact release-age exceptions when still needed.
     - Keep exact optional `node-pipewire`, auto-unpack-natives, and its Linux-only packaging when Wayland screen audio remains enabled.
     - Adopt upstream's pinned pnpm version and matching `.mise/config.toml` tool versions.
   - `pnpm-lock.yaml` → `git checkout --theirs pnpm-lock.yaml`, then `pnpm install --no-frozen-lockfile` to regenerate.
   - `src/native/window.ts`:
     - Keep `net` and `protocol` imports (fork).
     - Add upstream's new `desktopCapturer` and `session` imports (from the Electron 40 PR).
     - Keep `initBuildUrl()`, the privileged `stoat` scheme, `setupLocalProtocol()`, `localWebDir`, and `BUILD_URL` as `export let`.
     - Adopt upstream's `setDisplayMediaRequestHandler` + screen picker IPC inside `createMainWindow()`.
     - Update the fallback URL inside `initBuildUrl()` to `https://stoat.chat/app` (upstream) — _not_ `https://beta.revolt.chat`.
   - `forge.config.ts` — usually auto-merges, but verify:
   - `asar.unpack: "**/node_modules/keyspy/**/*"` preserved.
   - `extraResource: ["web-dist"]` preserved.
     - `prePackage` / `postPackage` hooks preserved.
     - Linux `packageAfterCopy` stages only the `node-pipewire` runtime files before auto-unpacking.
     - macOS icon selection is preserved without restoring unsafe blanket signing configuration.
   - New upstream flatpak/metainfo changes (e.g. `runtimeVersion`, zypak tag, screenshot URL) adopted.
   - Flatpak remains configuration-only in the fork release flow; do not restore upstream release publication steps.
   - `.mise/tasks/assets/_default` → initialize the assets submodule directly without a forced deinit or destructive fallback dependency.
   - `.gitmodules` → keep only the assets submodule with `update = checkout`; do not restore the retired `node-pipewire` submodule.
   - `src/main.ts`, `src/constants.ts`, `src/native/virtualMic.ts`, and `src/world/window.ts` → keep one virtual-mic lifecycle owner and a synchronous Boolean `window.native.isWayland()` bridge while preserving all PTT and `initBuildUrl()` calls.
5. **Review approved decisions:** before staging, summarize each material area, the user's selected approach, and how the implementation reflects it. Ask again if the implemented tradeoff differs materially from what was approved.
6. **After resolving:** `git add -A`, `git commit` (uses `.git/MERGE_MSG`).
7. **Sanity checks before pushing:**
   - `grep -r '<<<<<<<' .` returns nothing.
   - `npx tsc --noEmit` — expect pre-existing parser errors under `node_modules/type-fest` and `node_modules/@types/node`, but no errors in `src/`. The fork runs TypeScript 4.5.4 — don't try to "fix" dependency declarations in `node_modules`.
   - `pnpm package` succeeds locally (or at least `npx tsc --noEmit` + a `pnpm install`). Inspect Linux output for `node-pipewire` as well as keyspy and `web-dist`.
   - `pnpm lint` — pre-existing errors are expected; the merge must not **add** any.
8. **Commit message:** keep the auto-generated `Merge remote-tracking branch 'upstream/main'`. Edit only to add a one-line summary of conflict resolutions if helpful.
9. **Fetch immediately before pushing:** fetch `origin` and `upstream` again. Confirm both `git merge-base --is-ancestor origin/main main` and `git merge-base --is-ancestor upstream/main main` succeed, then `git push origin main`. The merge commit keeps the branch in sync with `upstream/main` (no "x commits behind" on the fork page).
10. **PR cleanup:** if the merge was triggered by a PR on the fork, GitHub usually auto-closes it once `main` advances past the head branch. Otherwise close manually.
11. **Verify GitHub's comparison:** local refs are not the final authority. Run `gh api repos/stoatchat/for-desktop/compare/main...Trifall:main --jq '{status: .status, ahead_by: .ahead_by, behind_by: .behind_by}'` and require `behind_by: 0`.

---

## 12. Known Issues / Gotchas

Things that look like bugs but are actually load-bearing:

- **`src/native/badges.ts` is never imported by `main.ts`.** The `ipcMain.on("setBadgeCount", ...)` listener it registers never fires; `window.native.setBadgeCount()` calls from the renderer are dropped silently. This is a **pre-existing fork condition**, _not_ a merge regression. Fixing it is a separate task — but do not be alarmed during merges if a "missing setBadgeCount handler" appears in logs.
- **`tsconfig.json#outDir: "dist"` is unused** — the real build output is `.vite/build/` per `package.json#main`. Pre-existing.
- **TypeScript 4.5.4 produces parser errors under `node_modules/type-fest` and `node_modules/@types/node`** — pre-existing dependency declarations use syntax this compiler cannot parse. These errors come from `node_modules`; there should still be no errors in `src/`. Don't edit `node_modules` to suppress them — pin compatible dependency types or handle a TypeScript upgrade as a separate migration.
- **Three pre-existing ESLint errors / one warning after upstream 1.5.1** — the errors are CommonJS `require()` calls in `src/native/window.ts`; the warning is the unused `version` import in `src/native/tray.ts`. The merge must not introduce additional problems, but it is fine for `pnpm lint` to exit non-zero. Compare counts and paths against this baseline rather than treating a non-zero exit alone as a regression.
- **`start:x11` is required for Linux PTT** — under native Wayland, keyspy can't grab keys. `--ozone-platform=x11` forces XWayland on Linux. `SETUP_GUIDE.md` documents this.
- **NVIDIA native Wayland uses software video decoding** — Chromium's accelerated decoder can render remote WebRTC video as persistent green macroblocks even though other receivers and the local capture preview are correct. `src/main.ts` detects the proprietary NVIDIA driver through `/proc/driver/nvidia/version` and appends `--disable-accelerated-video-decode` before Electron becomes ready when running native Wayland with Hardware Acceleration enabled. Preserve the narrower decode-only workaround so GPU compositing and encoding remain enabled; explicit `--ozone-platform=x11` launches do not need it.
- **`web-dist/` is intentionally git-ignored** — don't commit it. The CI workflow populates it from the web client build.
- **`--no-sandbox` is required** — it's in `start` and `start:x11` for a reason; the app can't run on Linux as a regular user otherwise.
- **PTT keybind parser duplication** — `parseAccelerators()` exists in both `src/native/pushToTalk.ts` and `src/world/pushToTalk.ts`. They must parse identically. If you change one, change the other.
- **Preload's `setManualState` updates `currentPttState` itself** before telling the main process — this means UI toggles feel instant but the canonical state still lives in the main process; if the two get out of sync the user will see a flicker. Don't "fix" by removing the optimistic update.
- **Circular imports** between `config.ts ↔ discordRpc.ts`, `config.ts ↔ pushToTalk.ts`, `window.ts ↔ tray.ts` — work fine under CommonJS because the exports are functions/objects resolved lazily. Don't refactor to ESM without testing.
- **Auto-launch IPC registration is explicit** — `src/main.ts` calls `initAutoLaunch()` once after Electron is ready. Do not restore import-time `ipcMain.handle()` registration.

---

## 13. Wayland Virtual Microphone — `KEEP ON MERGE`

Upstream 1.5.1 introduced PipeWire-based screen audio for Linux Wayland. The fork integrates the feature with corrected npm packaging and the synchronous bridge required by the paired web client.

### 13.1 Runtime ownership

- `src/constants.ts` owns the shared `stoat-virtual-sink`, `stoat-virtual-source`, and host-session Wayland constants.
- `src/main.ts` calls `initVirtualMic()` once after creating the window and initializing tray/Discord/PTT contexts. It clears the routing poller before process termination.
- `src/native/virtualMic.ts` starts `node-pipewire`, creates non-permanent stereo sink/source nodes when absent, waits for their ports, and polls for new non-Stoat output streams. Each poll verifies links and recreates missing virtual nodes after recoverable PipeWire graph resets. The native name-based linker is used only when the node name is unique across the current graph; duplicate names are skipped so a same-named Stoat stream cannot be routed accidentally, while the native thread resolves live ports without stale-ID races.
- The approved behavior is always-on for the desktop process on a Wayland host session. It routes all non-Stoat application audio, not only the selected screen/window, and excludes Electron/Stoat clients to avoid call-audio feedback.
- `src/world/window.ts` exposes `window.native.isWayland()` as a synchronous Boolean. Do not replace it with `ipcRenderer.invoke()`; the paired client intentionally rejects Promise/truthy values so the patch cannot activate on every platform.

### 13.2 Paired web contract

The paired `Trifall/stoat-for-web` client wraps `getDisplayMedia()` only when the synchronous bridge returns `true`. For audio-enabled shares it acquires `stoat-virtual-source`, stops/replaces Electron's original display-audio track, and falls back safely when the source is unavailable. The source is hidden from normal microphone settings and rejected as a persisted voice input so PTT, gain, RNNoise, and noise-gate processing never consume screen audio.

### 13.3 Dependency and packaging

- `node-pipewire` is exact optional npm dependency `1.1.0`; the upstream SSH git submodule and root `mise build:deps` task are intentionally removed.
- `vite.main.config.ts` keeps it external.
- `@electron-forge/plugin-auto-unpack-natives` unpacks its native binding.
- Forge `packageAfterCopy` stages only `dist`, `LICENSE`, and `package.json` in Linux packages before asar/signing. Copying the complete npm package adds roughly 60 MB.
- Linux CI installs `libpipewire-0.3-dev` before the frozen desktop install. Windows treats the dependency as optional and does not package it.
- The Linux ZIP and derived AppImage must both retain the unpacked binding and runtime package files.

### 13.4 Platform limits and validation

Virtual screen audio does not make keyspy work on native Wayland. `start:x11` remains required for global PTT through XWayland. Because host environment variables may still report Wayland under XWayland, the virtual source can remain active in that mode by design.

Test native Wayland screen/window sharing with and without audio, multiple applications, source failure, repeated shares, PipeWire restart, and feedback exclusion. Also test X11/XWayland display audio, packaged PTT, Windows/macOS Electron 43 loopback behavior, and package contents. The feature's all-application routing scope is intentional and must not be silently described as selected-window-only audio.

---

_Last updated: after integrating upstream 1.5.4 (Electron 44, Flatpak icon fix, nix flake) while preserving the fork release and AppImage pipeline._
