<div align="center">
<h1>
  Forked Stoat for Desktop - View paired web client fork at [https://github.com/Trifall/stoat-for-web](https://github.com/Trifall/stoat-for-web)
  
  [![Stars](https://img.shields.io/github/stars/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/stargazers)
  [![Forks](https://img.shields.io/github/forks/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/network/members)
  [![Pull Requests](https://img.shields.io/github/issues-pr/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/pulls)
  [![Issues](https://img.shields.io/github/issues/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/issues)
  [![Contributors](https://img.shields.io/github/contributors/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/graphs/contributors)
  [![License](https://img.shields.io/github/license/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/blob/main/LICENSE)
</h1>
Application for Windows, macOS, and Linux.
</div>
<br/>

## Push-to-Talk Feature

Stoat Desktop now includes a full push-to-talk (PTT) implementation with support for both "hold" and "toggle" modes, designed to work reliably on Linux with XWayland.

### Features

- **Hold Mode**: Press and hold to talk, release to mute (configurable release delay)
- **Toggle Mode**: Press once to toggle mic on/off
- **Customizable Keybind**: Use any key or key combination (e.g., "V", "Shift+V", "F8")
- **Release Delay**: Configurable delay before muting after releasing the key (prevents audio cut-off)
- **Works When Focused**: Can type your PTT key in chat while still using it for PTT
- **Works When Unfocused**: Global hotkey detection via XWayland for use with other apps

### Configuration

PTT settings are stored in the config file:

**Linux:** `~/.config/stoat-desktop/config.json`

**macOS:** `~/Library/Application Support/stoat-desktop/config.json`

**Windows:** `%APPDATA%/stoat-desktop/config.json`

Example configuration:

```json
{
  "pushToTalk": true,
  "pushToTalkKeybind": "V",
  "pushToTalkMode": "hold",
  "pushToTalkReleaseDelay": 250
}
```

Settings can also be changed via DevTools console:

```javascript
window.desktopConfig.set({ pushToTalk: true });
window.desktopConfig.set({ pushToTalkKeybind: "V" });
window.desktopConfig.set({ pushToTalkMode: "hold" });
window.desktopConfig.set({ pushToTalkReleaseDelay: 250 });
```

### Technical Implementation

The PTT system uses a hybrid approach to handle both focused and unfocused window states:

**When Window is Focused:**

- Uses Electron's `before-input-event` API on the webContents
- Detects keys without calling `preventDefault()`, allowing the key to be typed in chat inputs
- No `globalShortcut` registration (prevents key capture issues)

**When Window is Unfocused:**

- Uses `before-input-event` for XWayland compatibility (XWayland forwards input events even when window appears unfocused)
- Uses `globalShortcut` as a backup for true global hotkey detection
- Both handlers work simultaneously for maximum reliability

**Keybind Detection:**

- Parses accelerator strings (e.g., "Shift+V") into key and modifier components
- Matches against incoming input events
- Supports modifiers: Control, Shift, Alt, Meta

**Hold Mode with Timeout:**

- On key press: Activates PTT immediately
- While holding: Autorepeat events reset a timeout (prevents premature deactivation)
- On release: Starts configurable release delay timer
- After delay: Deactivates PTT
- If key pressed again during delay: Cancels delay and continues PTT

**State Management:**

- Desktop app tracks PTT state in main process
- State changes sent to renderer via IPC (`push-to-talk` channel)
- Web client (Solid.js) receives state and controls LiveKit microphone
- Release delay handled entirely in main process for consistency

**XWayland Compatibility:**

- Linux with XWayland (`--ozone-platform=x11`) forwards input events to X11 apps even when not visually focused
- This allows PTT to work even when clicking on other windows
- `before-input-event` captures these forwarded events
- `globalShortcut` provides OS-level hotkey support for true global detection

### Running with PTT Support

For full PTT functionality on Linux, use XWayland:

```bash
npx electron-forge start -- --ozone-platform=x11 --force-server=http://localhost:5173
```

See [SETUP_GUIDE.md](./SETUP_GUIDE.md) for detailed setup instructions.

## Notification Sounds

Stoat Desktop includes a comprehensive notification sound system that provides audio feedback for voice channel events and message notifications.

### Features

- **Master Toggle**: Enable/disable all notification sounds globally
- **Volume Control**: Adjustable volume level (0-100%)
- **Individual Sound Toggles**: Enable/disable specific sounds independently
- **7 Different Sounds**:
  - **Join Call**: When you join a voice channel
  - **Leave Call**: When you leave a voice channel
  - **Someone Joined**: When another user joins your voice channel
  - **Someone Left**: When another user leaves your voice channel
  - **Mute**: When your microphone is muted
  - **Unmute**: When your microphone is unmuted
  - **Receive Message**: When you receive a direct message or mention

### Configuration

Access notification sound settings in the app:
**Settings → User Settings → Notification Sounds**

Or configure via the config file:

**Linux:** `~/.config/stoat-desktop/config.json`

**macOS:** `~/Library/Application Support/stoat-for-desktop/config.json`

**Windows:** `%APPDATA%/stoat-for-desktop/config.json`

Example configuration:

```json
{
  "notificationSounds": {
    "enabled": true,
    "volume": 0.3,
    "join_call": true,
    "leave_call": true,
    "someone_joined": true,
    "someone_left": true,
    "mute": true,
    "unmute": true,
    "receive_message": true
  }
}
```

### Push-to-Talk Integration

PTT has its own independent notification sound setting (disabled by default to prevent spam):

- **PTT Sounds**: Enable/disable notification sounds specifically for PTT mute/unmute events
- Access in: **Settings → User Settings → Voice & Video → Push-to-Talk Settings**

### Technical Details

- Uses Web Audio API with preloaded .wav files
- Sounds respect both master toggle and individual settings
- Volume applied at playback time
- PTT sounds are separate to avoid excessive notifications during rapid toggling
- All settings are persisted to the config file automatically

## Development Guide

_Contribution guidelines for Desktop app TBA!_

<!-- Before contributing, make yourself familiar with [our contribution guidelines](https://developers.revolt.chat/contrib.html), the [code style guidelines](./GUIDELINES.md), and the [technical documentation for this project](https://revoltchat.github.io/frontend/). -->

Before getting started, you'll want to install:

- Git
- Node.js
- pnpm (run `corepack enable`)

Then proceed to setup:

```bash
# clone the repository
git clone --recursive https://github.com/Trifall/stoat-for-desktop stoat-for-desktop
cd stoat-for-desktop

# install all packages
pnpm i --frozen-lockfile

# start the application
pnpm start
# ... or build the bundle
pnpm package
# ... or build all distributables
pnpm make
```

Various useful commands for development testing:

```bash
# connect to the development server
pnpm start -- --force-server http://localhost:5173

# test the flatpak (after `make`)
pnpm install:flatpak
pnpm run:flatpak
# ... also connect to dev server like so:
pnpm run:flatpak --force-server http://localhost:5173

# Nix-specific instructions for testing
pnpm package
pnpm run:nix
# ... as before:
pnpm run:nix --force-server=http://localhost:5173
# a better solution would be telling
# Electron Forge where system Electron is
```

### Pulling in Stoat's assets

If you want to pull in Stoat brand assets after pulling, run the following:

```bash
# update the assets
git -c submodule."assets".update=checkout submodule update --init assets
```

Currently, this is required to build, any forks are expected to provide their own assets.

## Architecture

The desktop app is built with:

- **Electron**: Cross-platform desktop framework
- **Vite**: Build tool and dev server
- **TypeScript**: Type-safe JavaScript
- **electron-store**: Persistent configuration storage
- **electron-forge**: Packaging and distribution

Key directories:

- `src/native/`: Main process code (Node.js/Electron APIs)
- `src/world/`: Preload scripts (bridge between main and renderer)
- `src/native/pushToTalk.ts`: PTT implementation
- `src/native/config.ts`: Configuration management

The PTT implementation involves:

1. **Main Process** (`pushToTalk.ts`): Handles key detection, state management, IPC communication
2. **Preload Script** (`world/pushToTalk.ts`): Exposes API to renderer
3. **Web Client** (`client/packages/client/components/rtc/state.tsx`): Receives PTT events, controls LiveKit mic
