# Agent Guidelines for Stoat for Desktop

This file contains practical rules for agents implementing features, fixing bugs, refactoring, packaging, or merging upstream changes in this repository.

This is a behaviorally significant fork of upstream Stoat for Desktop. Read `fork-changes.md` before changing window creation, display capture, push-to-talk, configuration, preload bridges, IPC, the local web protocol, Forge packaging, native dependencies, CI, or release behavior. `fork-changes.md` is the detailed source of truth; this file is the day-to-day implementation checklist.

## Start With Context

### Do

- Inspect the relevant main-process, preload, config, packaging, and paired-web code before editing.
- Trace state and lifecycle ownership across main, preload, renderer, native helpers, and configuration setters.
- Check `git status --short --branch` before and after work, including submodule state.
- Review recent commits and `fork-changes.md` when code appears redundant or unusually defensive.
- Keep unrelated user changes, generated output, local `web-dist`, and dirty submodules untouched.
- Prefer the smallest behaviorally complete change that fits existing ownership boundaries.
- Identify platform-specific implications for Windows, Linux/X11, Wayland, macOS, and packaged Electron before changing native behavior.

### Do Not

- Do not infer ownership from the renderer UI when the main process owns the authoritative state.
- Do not reset, stash, clean, revert, replace, or update unrelated worktree content.
- Do not introduce a second lifecycle owner for registration, IPC, native processes, configuration, or window listeners.
- Do not remove defensive lifecycle code merely because a happy-path test does not exercise it.
- Do not assume a development-mode success proves packaged native behavior works.

## Process Boundaries and Source of Truth

### Do

- Keep security-sensitive and OS-level behavior in the Electron main process.
- Keep preload APIs narrow, typed, and backed by explicit IPC channels.
- Treat the main process as authoritative for PTT key handling, active state, hold/toggle semantics, release delay, native process recovery, and registration lifecycle.
- Treat the preload's cached state as a renderer-facing mirror that must be refreshed from main after reload.
- Keep the paired web client responsible for applying resolved PTT active/inactive state to the LiveKit microphone and rendering the voice UI.
- Coordinate changes to IPC payloads across `src/native`, `src/world`, `src/config.d.ts`, and the paired `Trifall/stoat-for-web` client.
- Preserve `contextIsolation: true` and `nodeIntegration: false` unless an explicitly approved security redesign replaces the current bridge model.

### Do Not

- Do not duplicate hold/toggle/release-delay logic in preload or the web client.
- Do not expose unrestricted Electron or Node APIs through `contextBridge`.
- Do not treat optimistic preload state as canonical.
- Do not rename IPC channels or change payload shapes on only one side.
- Do not make a type-only bridge change and assume runtime senders and consumers changed with it.

## Push-to-Talk Ownership

Relevant files include:

- `src/native/pushToTalk.ts`
- `src/world/pushToTalk.ts`
- `src/native/config.ts`
- `src/config.d.ts`
- `src/main.ts`
- `src/preload.ts`
- `forge.config.ts`
- `vite.main.config.ts`
- `pnpm-workspace.yaml`

### Do

- Call `initPushToTalk()` only once per application lifetime; it installs persistent IPC listeners.
- Let `Config` setters own PTT registration side effects.
- Update PTT settings IPC handlers by assigning through config setters, then send the resulting config back to the renderer.
- Re-register PTT after macOS recreates the main window in `app.on("activate")` when PTT is enabled.
- Clean up PTT on `window-all-closed` and `before-quit`.
- Request both retained config and retained native active state when preload starts or the renderer reloads.
- Keep `push-to-talk-request-state` so toggle state survives renderer/preload lifecycle restarts.
- Guard sends against missing or destroyed windows and web contents.
- Preserve the optimistic `setManualState()` preload update for responsive UI while keeping main authoritative.

### Do Not

- Do not register or unregister PTT in both config setters and the IPC settings handler.
- Do not call `initPushToTalk()` when recreating a window; attach the new window by calling `registerPushToTalkHotkey()` instead.
- Do not assume preload variables survive reloads.
- Do not reset retained toggle state merely because a renderer, preload, key listener, or window restarted.
- Do not remove request/response IPC because state-change listeners appear to cover normal startup.
- Do not send to a stale `mainWindow` after macOS window recreation.

## PTT Input Paths and Keybinds

### Do

- Preserve both input paths:
  - Focused window: Electron `before-input-event`.
  - Unfocused window: global `keyspy` events.
- Ignore global keyspy events while the window is focused to prevent duplicate activation.
- Allow the PTT key to be typed in text inputs while preventing unrelated web keybind handlers from firing.
- Keep capture-phase DOM key interception in `src/world/pushToTalk.ts` synchronized with native key matching.
- Keep `parseAccelerators()` behavior compatible in native and preload code.
- Preserve the persisted keybind string format:
  - Legacy single accelerator, such as `Shift+V`.
  - JSON-array string for multiple bindings, such as `["Shift+V","F8"]`.
- Preserve special-key normalization on all input paths, including Windows OEM punctuation mappings.
- Relax modifier matching on key-up because modifiers may be released before the main key.
- Track multiple held PTT bindings and deactivate hold mode only after the final held binding is released.
- Clear held-key bookkeeping during focus transitions to prevent stuck state.
- Deactivate immediately on focus/blur transitions in hold mode, but preserve latched state in toggle mode.

### Do Not

- Do not collapse focused and unfocused input handling into one mechanism without proving equivalent cross-platform behavior.
- Do not call `preventDefault()` on focused PTT input if it prevents users from typing the key in chat.
- Do not update only one parser, key map, modifier rule, or special-key path.
- Do not change `pushToTalkKeybind` from a string without a persisted-data migration and paired-web update.
- Do not deactivate toggle mode on window blur or focus transitions.
- Do not let releasing one of several active PTT bindings mute while another binding remains held.

## Keyspy Lifecycle and Recovery

### Do

- Keep `keyspy` external to Vite and load it from normal or unpacked packaged paths as appropriate.
- Preserve stream, process, watchdog, and uncaught `EPIPE` handling around the keyspy child process.
- Mark intentional shutdown before killing keyspy so exit/error/watchdog handlers do not start recovery.
- Deduplicate simultaneous crash signals with the existing crash/restart guards.
- Clear held-key bookkeeping after a crash.
- Fail closed in hold mode by sending inactive state after listener failure.
- Preserve the current latched active state in toggle mode during listener failure and restart.
- Keep bounded restart attempts and backoff rather than spawning unbounded child processes.
- Cancel watchdogs, restart timers, release-delay timers, listeners, and process handles during cleanup.
- Verify recovery with a real keyspy process, not only mocked function calls.

### Do Not

- Do not treat every keyspy exit as a user-requested stop.
- Do not reset toggle state as part of generic crash cleanup.
- Do not leave multiple watchdogs, listeners, child processes, or restart timers active.
- Do not remove the unpacked-path fallback because development loading succeeds.
- Do not silently turn packaging warnings into proof that native PTT was included; inspect the packaged files.

## Local Web Client and `stoat://`

### Do

- Keep the packaged paired web client in `web-dist/` and ship it through Forge `extraResource`.
- Keep `web-dist/` git-ignored; CI and local setup populate it from a web build.
- Register the privileged `stoat` scheme at module load before Electron becomes ready.
- Call `initBuildUrl()` before `createMainWindow()`.
- Keep `BUILD_URL` mutable because startup selects local assets, `--force-server`, or the remote fallback.
- Preserve all supported local asset lookup locations.
- Preserve the path-traversal guard in the protocol handler.
- Preserve SPA fallback to `index.html` for client-side routes that are not physical files.
- Keep `stoat:` navigation allowed while blocking unapproved navigation and opening external links through `shell.openExternal`.
- Evaluate `webSecurity` for both local `stoat://` loading and remote HTTPS loading before changing it.
- Keep `--force-server` working for paired web-client development.

### Do Not

- Do not replace `src/native/window.ts` wholesale with upstream window code.
- Do not move privileged scheme registration after `app.ready`.
- Do not make `BUILD_URL` a fixed constant unless local, forced, and remote modes are redesigned together.
- Do not remove traversal protection or turn every missing asset into an arbitrary file response.
- Do not remove SPA fallback because the root route works.
- Do not enable or disable `webSecurity` unconditionally without testing both loading modes and API access.
- Do not commit `web-dist/` or treat its absence in Git as a packaging bug.

## Window, Tray, and Display Capture

### Do

- Preserve saved position, size, maximized state, tray-minimize behavior, and the `shouldQuit` distinction.
- Update the tray menu when the main window is shown or hidden.
- Keep the tray Reload action for local packaged web assets.
- Preserve macOS native traffic-light positioning and window recreation behavior.
- Keep screen-picker main/preload IPC synchronized.
- Use Electron display capture with `audio: "loopback"` when audio is requested.
- Omit the audio field when audio is not requested rather than sending `undefined`.
- Preserve `{ useSystemPicker: true }` and the Linux single-source shortcut unless deliberately redesigning capture.
- Test screen, window, audio-enabled, audio-disabled, system-picker, and cancellation paths.

### Do Not

- Do not change capture back to `loopbackWithMute`; it removes local audio availability during screen sharing.
- Do not assume display capture behavior is equivalent across Windows, Linux/X11, Wayland, and macOS.
- Do not let screen-picker listeners accumulate across repeated requests.
- Do not remove the tray Reload item because normal remote/HMR development does not need it.
- Do not conflate closing to tray with quitting the application.

## Configuration and Persistence

### Do

- Update config fields in lockstep across:
  - `electron-store` schema and defaults.
  - `Config` getters and setters.
  - `Config.sync()` payload.
  - `DesktopConfig` declarations in `src/config.d.ts`.
  - Any preload or paired-web APIs that consume the field.
- Put registration and runtime side effects in the config setter that owns the setting.
- Keep the `config.sync()` guard for a missing `mainWindow`; first-launch writes occur before a window exists.
- Validate persisted values in the schema, including PTT mode and release-delay bounds.
- Preserve window-state persistence and first-launch behavior.
- Plan explicit migration behavior before changing a persisted field's type, representation, or authority.

### Do Not

- Do not duplicate config side effects in IPC handlers, UI code, and setters.
- Do not call `mainWindow.webContents` from config synchronization without a window guard.
- Do not add a schema field without defaults, getters/setters, sync, and types.
- Do not claim `notificationSounds` is desktop-authoritative until desktop schema, IPC, preload API, types, and paired-web mapping all implement it.
- Do not refactor the existing circular imports to ESM casually; current CommonJS output resolves them lazily and requires lifecycle testing if changed.

## Native Packaging and Dependencies

### Do

- Keep `keyspy`, `electron`, `bufferutil`, and `utf-8-validate` external in `vite.main.config.ts`.
- Keep `keyspy` unpacked from asar.
- Keep `nodeLinker: hoisted`; native copy paths and keyspy packaging rely on the flat layout.
- Add native dependencies to `onlyBuiltDependencies` when their install scripts must run.
- Preserve Forge `prePackage` compilation of `WinKeyServer.exe` and `X11KeyServer`.
- Preserve Forge `postPackage` copies of `keyspy` and `@expo/sudo-prompt` into `app.asar.unpacked/node_modules`.
- Keep Linux X11/XInput development packages and Windows MinGW available in packaging environments.
- Keep `electron-rebuild` available when native modules must target a new Electron ABI.
- Preserve the `cross-zip@4.0.1` patch until the dependency is upgraded to a version that no longer uses unsupported recursive `rmdir` calls.
- Inspect packaged output for native servers and unpacked module files.
- Regenerate `pnpm-lock.yaml` with `pnpm install --no-frozen-lockfile` after approved dependency conflict resolution, then verify with a frozen install.

### Do Not

- Do not switch pnpm to an isolated linker.
- Do not bundle keyspy into Vite or leave it inside `app.asar`.
- Do not assume a Forge package succeeded with working PTT; native compilation failures currently warn and continue.
- Do not remove the cross-zip patch solely because dependency installation succeeds on one Node version.
- Do not update Electron without checking native ABI rebuilds, Forge compatibility, Flatpak settings, and packaged PTT.
- Do not edit generated dependencies or `node_modules` to suppress compiler errors.

## Linux, macOS, and Windows Behavior

### Do

- Keep `--no-sandbox` in the normal development start command.
- Keep `start:x11` with `--ozone-platform=x11` for Linux PTT through XWayland.
- Test true packaged PTT on Windows and Linux, including special keys and multiple bindings.
- Test macOS close/reopen behavior so a replacement window receives PTT listeners and retained state.
- Preserve current Flatpak runtime, zypak, sockets, devices, PipeWire, and environment settings when accepting unrelated upstream packaging improvements.
- Treat platform capability differences as explicit behavior rather than forcing one implementation everywhere.

### Do Not

- Do not remove `--no-sandbox` or `start:x11` as redundant flags.
- Do not claim native Wayland supports the same keyspy behavior as X11/XWayland.
- Do not assume prebuilt macOS keyspy behavior proves Windows/Linux package hooks work.
- Do not make platform-specific capture or PTT changes without checking the other platform paths for shared assumptions.

## Paired Web Build and CI/Release

### Do

- Keep release CI pointed at `Trifall/stoat-for-web` unless the fork owner explicitly changes the paired client.
- Build the paired client and copy its output into `web-dist/` before packaging desktop.
- Set `VITE_CFG_ENABLE_VIDEO: "true"` in both Linux and Windows web-build jobs so camera and screen-share controls ship enabled.
- Keep Linux and Windows client build steps behaviorally synchronized even though Windows currently expands mise tasks into direct pnpm commands.
- Preserve the Windows direct-command workaround for mise's nested task PATH loss.
- Keep GitHub Actions on Node 24-capable major versions or newer.
- Preserve action-runtime versions, artifact names, ZIP naming, changelog generation, and the two-platform release flow together.
- Keep desktop and paired-web lockfiles frozen in CI after intentional regeneration.
- Update `.github/workflows/README.md` when workflow inputs, artifacts, prerequisites, or release behavior change.

### Do Not

- Do not reconstruct Windows PATH from machine/user environment variables; that can discard paths added through `GITHUB_PATH`.
- Do not remove the video feature environment variable because a local ignored `.env` makes development work.
- Do not blindly restore deleted upstream release-please, webhook, git-town, build, or PR-title workflows.
- Do not change ZIP names without updating discovery, upload, release, and documentation steps.
- Do not assume Linux-only CI edits are sufficient for paired client or native dependency changes.

## Forked Assets and Generated Output

### Do

- Preserve the `assets` submodule URL and its intended checkout/update behavior.
- Initialize the assets submodule when packaging requires icons or metadata.
- Inspect `.gitmodules`, gitlink state, and generated output before staging.
- Keep `.vite`, `out`, and `web-dist` build products out of commits unless repository policy explicitly changes.

### Do Not

- Do not run destructive submodule cleanup or broad remote updates in a dirty worktree.
- Do not commit generated package output or a locally copied paired web build.
- Do not interpret a lowercase `m` submodule status as permission to reset it.

## Upstream Changes and Material Conflicts

### Do

- Use a real `git merge upstream/main --no-ff --no-commit` to synchronize upstream and preserve ancestry.
- Distinguish a real upstream merge from rebasing unpublished local fork commits onto an `origin/main` that already contains upstream.
- Classify conflicts as routine or material before editing them.
- Stop and ask when a decision changes functionality, architecture, security, persistence, IPC, capture semantics, platform support, packaging, or release strategy.
- Investigate both sides before asking: identify exact files, fork behavior, upstream behavior, compatibility risks, a recommendation, alternatives, and validation.
- Ask separately for materially different areas such as PTT, window/protocol, capture, config, packaging, and CI.
- Prefer adapting fork features to a sound new upstream architecture when both can coexist.
- Keep the repository and merge state intact while waiting for a material decision.
- Audit KEEP ON MERGE areas even when Git reports a clean automatic merge.

### Do Not

- Do not import upstream with cherry-picks, squash merges, or rebases.
- Do not resolve material conflicts by blindly choosing `ours`, choosing `theirs`, or mechanically combining lines.
- Do not interpret general permission to merge upstream as permission to remove documented fork behavior.
- Do not bundle unrelated product choices into one approval question.
- Do not abort, reset, clean, commit, push, or update submodules while a material decision is pending unless explicitly requested.
- Do not force-push local branch reconciliation.

## Verification

### Do

- Install dependencies with the pinned package manager and frozen lockfile:

  ```sh
  pnpm install --frozen-lockfile
  ```

- Format changed files with Prettier and run targeted ESLint on changed source.
- Run `pnpm lint`, but compare any failures with the documented baseline because the repository already has known errors and warnings.
- Run TypeScript checking and distinguish existing dependency parser errors from new errors under `src/`:

  ```sh
  pnpm exec tsc --noEmit
  ```

- Run `pnpm package` after Electron main, preload, native dependency, Forge, protocol, or packaging changes.
- Run the relevant `pnpm make --platform=... --targets=@electron-forge/maker-zip` path for release or platform-specific changes.
- Run `git diff --check` and inspect the complete final diff.
- Check for unresolved conflicts and inspect status after build commands.
- Verify package contents, not only command exit status, for native modules, keyspy binaries, unpacked files, and `web-dist`.
- State exact pre-existing limitations when a repository-wide check exits non-zero.

### Do Not

- Do not report the repository's known TypeScript dependency parser errors as new source failures.
- Do not report lint as clean if it only matches a known non-zero baseline; report the comparison accurately.
- Do not treat successful source compilation as proof that native packaging works.
- Do not treat successful packaging as proof that keyspy compiled or PTT works.
- Do not stage generated `.vite`, `out`, `web-dist`, or unrelated lockfile/submodule changes.

### Known Baseline Conditions

- `src/native/badges.ts` is currently not imported by `main.ts`; missing badge IPC behavior is pre-existing and should be fixed as a separate task.
- `tsconfig.json` references the transitively hoisted `electron-vite/node` type and has an unused `dist` outDir; do not rewrite build configuration during unrelated work.
- TypeScript 4.5.4 reports parser errors in newer `node_modules` declarations; new errors under `src/` are still regressions.
- Repository-wide ESLint currently has documented pre-existing errors and warnings; compare counts and paths instead of treating any non-zero exit as newly introduced.
- Circular imports among config, PTT, Discord RPC, window, and tray modules currently rely on CommonJS lazy resolution.
- Root `strings.ts` is intentionally empty and harmless.

### Manual Smoke Checks

Test the relevant subset after desktop lifecycle, PTT, capture, config, or packaging changes:

- Start normally and with `pnpm start:x11` on Linux.
- Test PTT while the window is focused and unfocused.
- Type the PTT key in chat and confirm it both types and activates without duplicate web keybind behavior.
- Test hold mode, toggle mode, release delay, multiple bindings, modifiers, punctuation/special keys, and autorepeat.
- Blur/focus during hold and toggle modes; verify hold fails closed and toggle remains latched.
- Kill or disrupt keyspy; verify bounded restart, no duplicate child processes, hold deactivation, and toggle retention.
- Reload the renderer or use tray Reload; verify retained native PTT state and config are restored.
- Close all windows and recreate one on macOS; verify PTT listeners are attached to the replacement window.
- Change PTT enabled/keybind/mode settings repeatedly; verify one registration lifecycle and no duplicate listeners.
- Launch on first run and update config before window creation; verify `config.sync()` does not crash.
- Load a packaged `stoat://` build, navigate directly to a deep SPA route, reload it, and verify traversal attempts remain blocked.
- Test `--force-server` and remote fallback separately from local `web-dist` loading.
- Share a screen/window with and without audio; verify local audio remains available with `loopback`.
- Inspect the packaged app for `web-dist`, unpacked keyspy, `@expo/sudo-prompt`, and the expected platform key server.
- Verify tray Show/Hide text, Reload, close-to-tray, real Quit, and saved window state.

## Feature Completion

### Do

- Record architectural ownership, lifecycle assumptions, IPC contracts, persistence formats, platform differences, packaging requirements, and paired-web dependencies discovered during implementation.
- Explain manual and platform checks that remain after automated verification.
- Review whether the feature adds or changes fork behavior that an upstream merge could accidentally remove.
- After finishing a feature or system redesign, consider adding its behavior, ownership, edge cases, packaging requirements, and conflict risks to `fork-changes.md` so future upstream merges preserve it.
- Update setup, workflow, or release documentation when user/developer instructions change.

### Do Not

- Do not leave important lifecycle or packaging constraints only in chat history or a pull request description.
- Do not describe temporary implementation details as stable architecture without verifying all callers and platform paths.
- Do not claim cross-platform support based on one development environment.
