import { app, ipcMain } from "electron";
import * as path from "node:path";

import { config } from "./config";
import { mainWindow } from "./window";

// dynamically load iohook with path resolution for production
function loadIohook() {
  try {
    // try standard import first (development)
    return require("@tkomde/iohook");
  } catch {
    // in production, module is in app.asar.unpacked
    const unpackedPath = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "@tkomde",
      "iohook"
    );
    return require(unpackedPath);
  }
}

const iohook = loadIohook();

// Debug logging - check NODE_ENV since app.isPackaged may not work in dev mode
const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
function pttLog(...args: unknown[]) {
  if (isDev) {
    console.log("[PTT]", ...args);
  }
}

let isPttActive = false;
let isIohookRunning = false;
let isWindowFocused = false;

let currentKeybind = "";
let keybindModifiers = { ctrl: false, shift: false, alt: false, meta: false };

let releaseDelayTimeout: NodeJS.Timeout | null = null;

// track which keys are currently held down
const heldKeys = new Set<string>();
let pttActivationKey: string | null = null; // track which key activated PTT

function getReleaseDelay(): number {
  return config.pushToTalkReleaseDelay || 0;
}

pttLog("Module loaded (using before-input-event)");

function sendPttState(active: boolean) {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    pttLog("Sending PTT state:", active ? "ON" : "OFF");
    mainWindow.webContents.send("push-to-talk", { active });
  }
}

function sendPttConfig() {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed()
  ) {
    const pttConfig = {
      enabled: config.pushToTalk,
      keybind: config.pushToTalkKeybind,
      mode: config.pushToTalkMode,
      releaseDelay: config.pushToTalkReleaseDelay,
    };
    pttLog("Sending PTT config to renderer:", pttConfig);
    mainWindow.webContents.send("push-to-talk-config", pttConfig);
  }
}

function deactivatePtt(reason: string, useDelay = true) {
  pttLog(`[DEBUG] deactivatePtt called: reason="${reason}", isPttActive=${isPttActive}, useDelay=${useDelay}`);
  
  // clear any existing release delay timeout
  if (releaseDelayTimeout) {
    clearTimeout(releaseDelayTimeout);
    releaseDelayTimeout = null;
  }

  const delay = useDelay ? getReleaseDelay() : 0;

  if (delay > 0 && isPttActive) {
    pttLog("PTT release delayed by", delay, "ms");
    releaseDelayTimeout = setTimeout(() => {
      if (isPttActive) {
        isPttActive = false;
        pttLog("PTT deactivated (after delay):", reason);
        sendPttState(false);
      }
    }, delay);
  } else {
    if (isPttActive) {
      isPttActive = false;
      pttLog("PTT deactivated:", reason);
      sendPttState(false);
    } else {
      pttLog(`[DEBUG] Skipping deactivation - PTT already inactive`);
    }
  }
}

function activatePtt(reason: string) {
  // cancel any pending release delay when re-activating
  if (releaseDelayTimeout) {
    clearTimeout(releaseDelayTimeout);
    releaseDelayTimeout = null;
    pttLog("Cancelled pending release delay (key pressed again)");
  }

  if (!isPttActive) {
    isPttActive = true;
    pttLog("PTT activated:", reason);
    sendPttState(true);
  }
}

function parseAccelerator(accelerator: string) {
  const parts = accelerator
    .toLowerCase()
    .split(/[+-]/)
    .map((p) => p.trim());
  const key = parts.pop() || "";

  return {
    key,
    ctrl: parts.includes("ctrl") || parts.includes("control"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    meta:
      parts.includes("meta") ||
      parts.includes("cmd") ||
      parts.includes("command"),
  };
}

function matchesKeybind(input: Electron.Input): boolean {
  // only check the key, not modifiers, to allow PTT to work
  // even when modifiers are held (e.g., Shift+V, Ctrl+V)
  return input.key.toLowerCase() === currentKeybind.toLowerCase();
}

/**
 * Handle before-input-event from webContents
 * This fires for ALL keyboard input, even when window appears unfocused on XWayland
 *
 * IMPORTANT: We do NOT call preventDefault(), so the key still gets typed in inputs.
 * This allows PTT to work AND the key to be typed (like Discord).
 */
function handleBeforeInputEvent(event: Electron.Event, input: Electron.Input) {
  // Use a stable key identifier based on physical key (code) only, not modifiers
  // This prevents stuck keys when modifiers change between keydown and keyup
  const keyIdentifier = input.code;
  const isPttKey = matchesKeybind(input);
  const focused = mainWindow?.isFocused() ?? false;

  // DEBUG: Log ALL keyboard events
  pttLog(
    `[DEBUG] Input event: type=${input.type}, key=${input.key}, code=${input.code}, ` +
    `modifiers=${JSON.stringify({ctrl: input.control, shift: input.shift, alt: input.alt, meta: input.meta})}, ` +
    `isPttKey=${isPttKey}, heldKeys=[${Array.from(heldKeys).join(', ')}], ` +
    `pttActive=${isPttActive}, pttActivationKey=${pttActivationKey}, focused=${focused}`
  );

  if (!isPttKey) {
    // Track held keys for non-PTT keys too (for complete state tracking)
    if (input.type === "keyDown") {
      heldKeys.add(keyIdentifier);
    } else if (input.type === "keyUp") {
      heldKeys.delete(keyIdentifier);
    }
    pttLog(`[DEBUG] Ignoring non-PTT key: ${input.key}`);
    return;
  }

  if (config.pushToTalkMode === "hold") {
    if (input.type === "keyDown") {
      // check for auto-repeat BEFORE adding to heldKeys
      if (heldKeys.has(keyIdentifier)) {
        pttLog(`[DEBUG] Ignoring auto-repeat keyDown for: ${keyIdentifier}`);
        return;
      }
      
      heldKeys.add(keyIdentifier);
      
      // activate if:
      // 1. PTT is not active, OR
      // 2. PTT is active but waiting for delay (pttActivationKey was cleared on keyUp)
      //    - This handles the case where user releases and immediately re-presses
      if (!isPttActive || pttActivationKey === null) {
        pttActivationKey = keyIdentifier;
        pttLog(`[DEBUG] PTT activated by key: ${keyIdentifier}`);
        activatePtt(
          "before-input-event keyDown" +
            (focused ? " (focused)" : " (unfocused)"),
        );
      } else {
        pttLog(`[DEBUG] PTT already active with key ${pttActivationKey}, ignoring ${keyIdentifier}`);
      }
    } else if (input.type === "keyUp") {
      heldKeys.delete(keyIdentifier);
      
      // deactivate if this is the same key that activated PTT
      if (pttActivationKey === keyIdentifier) {
        pttLog(`[DEBUG] PTT deactivating - matching keyUp: ${keyIdentifier}`);
        pttActivationKey = null;
        deactivatePtt(
          "before-input-event keyUp" + (focused ? " (focused)" : " (unfocused)"),
        );
      } else {
        pttLog(`[DEBUG] Ignoring keyUp - key ${keyIdentifier} != activationKey ${pttActivationKey}`);
      }
    }
  } else {
    // toggle mode - only respond to keyDown
    if (input.type === "keyDown") {
      // check for auto-repeat
      if (heldKeys.has(keyIdentifier)) {
        pttLog(`[DEBUG] Ignoring auto-repeat keyDown for toggle: ${keyIdentifier}`);
        return;
      }
      heldKeys.add(keyIdentifier);
      
      isPttActive = !isPttActive;
      sendPttState(isPttActive);
      pttLog("PTT toggled:", isPttActive ? "ON" : "OFF");
    } else if (input.type === "keyUp") {
      heldKeys.delete(keyIdentifier);
    }
  }
}

function matchesIohookEvent(event: any): boolean {
  // iohook event structure: { keycode, rawcode, type, ... }
  // convert to key name and check if it matches the keybind
  // note: we only check the key, not modifiers, to allow PTT to work
  // even when modifiers are held (e.g., Shift+V, Ctrl+V)
  const key = iohookKeycodeToString(event.keycode);
  return key.toLowerCase() === currentKeybind.toLowerCase();
}

// iohook uses libuiohook keycodes which are different per platform
// These are the main keycodes for Linux/X11 (most common for development)
const IOHOOK_KEYCODES: Record<number, string> = {
  // Letters
  30: "a", 48: "b", 46: "c", 32: "d", 18: "e", 33: "f", 34: "g", 35: "h",
  23: "i", 36: "j", 37: "k", 38: "l", 50: "m", 49: "n", 24: "o", 25: "p",
  16: "q", 19: "r", 31: "s", 20: "t", 22: "u", 47: "v", 17: "w", 45: "x",
  21: "y", 44: "z",
  // Numbers
  11: "0", 2: "1", 3: "2", 4: "3", 5: "4", 6: "5", 7: "6", 8: "7", 9: "8", 10: "9",
  // Special keys
  1: "escape", 14: "backspace", 15: "tab", 28: "return", 57: "space",
  42: "shift", 54: "shift", 29: "control", 97: "control",
  56: "alt", 100: "alt", 125: "meta", 126: "meta",
  58: "capslock", 59: "f1", 60: "f2", 61: "f3", 62: "f4",
  63: "f5", 64: "f6", 65: "f7", 66: "f8", 67: "f9",
  68: "f10", 87: "f11", 88: "f12",
  // Numpad
  82: "0", 79: "1", 80: "2", 81: "3", 75: "4", 76: "5",
  77: "6", 71: "7", 72: "8", 73: "9",
};

function iohookKeycodeToString(keycode: number): string {
  return IOHOOK_KEYCODES[keycode] || String(keycode);
}

let areIohookListenersSetup = false;

function setupIohookListeners(): void {
  if (areIohookListenersSetup) {
    pttLog("IOHook listeners already setup");
    return;
  }

  pttLog("Setting up iohook listeners...");

  // Handle keydown events
  iohook.on("keydown", (event: any) => {
    pttLog(`[DEBUG] IOHook keydown: keycode=${event.keycode}, rawcode=${event.rawcode}`);
    
    if (!matchesIohookEvent(event)) {
      return;
    }

    // Use keycode only (physical key position) for stable tracking
    // rawcode changes with modifiers (e.g., v=118, V=86 with Shift)
    const keyIdentifier = String(event.keycode);
    
    // Ignore if already held (auto-repeat)
    if (heldKeys.has(keyIdentifier)) {
      pttLog(`[DEBUG] IOHook ignoring auto-repeat for: ${keyIdentifier}`);
      return;
    }

    heldKeys.add(keyIdentifier);

    if (config.pushToTalkMode === "hold") {
      // activate if:
      // 1. PTT is not active, OR
      // 2. PTT is active but in release delay (pttActivationKey === null)
      //    - This handles the case where user releases and re-presses during delay
      if (!isPttActive || pttActivationKey === null) {
        pttActivationKey = keyIdentifier;
        pttLog(`[DEBUG] IOHook PTT activated by key: ${keyIdentifier}`);
        activatePtt("iohook global keydown");
      } else {
        pttLog(`[DEBUG] IOHook PTT already active with key ${pttActivationKey}, ignoring ${keyIdentifier}`);
      }
    } else {
      // toggle mode
      isPttActive = !isPttActive;
      sendPttState(isPttActive);
      pttLog("IOHook PTT toggled:", isPttActive ? "ON" : "OFF");
    }
  });

  // Handle keyup events
  iohook.on("keyup", (event: any) => {
    pttLog(`[DEBUG] IOHook keyup: keycode=${event.keycode}, rawcode=${event.rawcode}`);
    
    if (!matchesIohookEvent(event)) {
      return;
    }

    // use keycode only for stable tracking
    const keyIdentifier = String(event.keycode);
    heldKeys.delete(keyIdentifier);

    if (config.pushToTalkMode === "hold") {
      // deactivate if this is the same key that activated PTT
      if (pttActivationKey === keyIdentifier) {
        pttLog(`[DEBUG] IOHook PTT deactivating - matching keyUp: ${keyIdentifier}`);
        pttActivationKey = null;
        deactivatePtt("iohook global keyup");
      } else {
        pttLog(`[DEBUG] IOHook ignoring keyUp - key ${keyIdentifier} != activationKey ${pttActivationKey}`);
      }
    }
  });

  areIohookListenersSetup = true;
  pttLog("✓ IOHook listeners setup");
}

function startIohook(): void {
  if (isIohookRunning) {
    pttLog("IOHook already running");
    return;
  }

  if (!areIohookListenersSetup) {
    setupIohookListeners();
  }

  try {
    iohook.start();
    isIohookRunning = true;
    pttLog("✓ IOHook started successfully");
  } catch (err) {
    pttLog("✗ Failed to start iohook:", err);
  }
}

function stopIohook(): void {
  if (!isIohookRunning) {
    return;
  }

  pttLog("Stopping iohook...");
  try {
    iohook.stop();
    isIohookRunning = false;
    heldKeys.clear();
    pttActivationKey = null;
    pttLog("✓ IOHook stopped");
  } catch (err) {
    pttLog("✗ Error stopping iohook:", err);
  }
}

export async function registerPushToTalkHotkey(): Promise<void> {
  pttLog("Registering PTT hotkey...");

  if (!config.pushToTalk) {
    pttLog("PTT disabled in config");
    unregisterPushToTalkHotkey();
    return;
  }

  const accelerator = config.pushToTalkKeybind || "Shift+Space";
  pttLog("Keybind:", accelerator, "Mode:", config.pushToTalkMode);

  unregisterPushToTalkHotkey();

  const parsed = parseAccelerator(accelerator);
  currentKeybind = parsed.key;
  keybindModifiers = {
    ctrl: parsed.ctrl,
    shift: parsed.shift,
    alt: parsed.alt,
    meta: parsed.meta,
  };

  pttLog("Parsed keybind:", currentKeybind, "modifiers:", keybindModifiers);

  // send PTT config to renderer for DOM interception
  sendPttConfig();

  // set up before-input-event listener (primary method for focused window)
  // this works on XWayland even when window appears unfocused
  if (mainWindow && !mainWindow.isDestroyed()) {
    pttLog("Setting up before-input-event listener...");

    // remove any existing listener first to avoid duplicates
    mainWindow.webContents.off("before-input-event", handleBeforeInputEvent);
    mainWindow.webContents.on("before-input-event", handleBeforeInputEvent);
    pttLog(
      "✓ before-input-event listener attached. Window focused:",
      mainWindow.isFocused(),
      "| Visible:",
      mainWindow.isVisible(),
    );
  } else {
    pttLog("✗ Cannot attach before-input-event listener - window not ready");
  }

  // Set up iohook for global key capture when window is blurred
  setupIohookListeners();

  // Set up focus/blur handlers to manage which input method to use
  // When focused: use before-input-event
  // When blurred: iohook handles global keys (real keyup/keydown)
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Set initial focus state and start/stop iohook accordingly
    isWindowFocused = mainWindow.isFocused();
    
    if (isWindowFocused) {
      pttLog("Window initially focused - not starting iohook to allow typing");
      // Don't start iohook when focused - before-input-event will handle keys
    } else if (config.pushToTalk) {
      pttLog("Window initially blurred - starting iohook for global PTT");
      startIohook();
    } else {
      pttLog("Window initially blurred - PTT disabled, not starting iohook");
    }
    
    mainWindow.on("focus", () => {
      if (!isWindowFocused) {
        pttLog("Window focused - stopping iohook and clearing state");
        isWindowFocused = true;
        // Completely stop iohook when focused so it doesn't intercept keys
        stopIohook();
        // Clear all held keys to prevent memory leaks and stuck states
        heldKeys.clear();
        pttActivationKey = null;
        pttLog("[DEBUG] Cleared heldKeys and pttActivationKey on focus");
      }
    });

    mainWindow.on("blur", () => {
      if (isWindowFocused) {
        isWindowFocused = false;
        // only start iohook if PTT is enabled
        if (config.pushToTalk) {
          pttLog("Window blurred - restarting iohook for global PTT");
          // clear state before starting iohook to ensure clean slate
          heldKeys.clear();
          pttActivationKey = null;
          startIohook();
          pttLog("[DEBUG] Cleared heldKeys and pttActivationKey on blur");
        } else {
          pttLog("Window blurred - PTT disabled, not starting iohook");
        }
      }
    });
  }

  isPttActive = false;
  sendPttState(false);
  pttLog("✓ PTT initialized with iohook");
}

export function unregisterPushToTalkHotkey(): void {
  pttLog("Unregistering PTT hotkey...");

  deactivatePtt("unregister");

  // remove before-input-event listener
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.off("before-input-event", handleBeforeInputEvent);
    pttLog("Removed before-input-event listener");
  }

  // stop iohook
  stopIohook();

  heldKeys.clear();
  pttActivationKey = null;
}

export function getPushToTalkState(): boolean {
  return isPttActive;
}

export function initPushToTalk(): void {
  pttLog("Initializing PTT (before-input-event method)...");
  pttLog("Config:", {
    enabled: config.pushToTalk,
    keybind: config.pushToTalkKeybind,
    mode: config.pushToTalkMode,
  });

  ipcMain.on("push-to-talk-manual", (_, data: { active: boolean }) => {
    pttLog("Manual PTT state:", data.active);
    isPttActive = data.active;
    sendPttState(data.active);
  });

  ipcMain.on(
    "push-to-talk-update-settings",
    (
      _,
      settings: {
        enabled?: boolean;
        keybind?: string;
        mode?: "hold" | "toggle";
        releaseDelay?: number;
      },
    ) => {
      pttLog("Received settings update from renderer:", settings);

      // track if enabled state changed
      const wasEnabled = config.pushToTalk;

      // update config (setters automatically save to store)
      if (typeof settings.enabled === "boolean") {
        config.pushToTalk = settings.enabled;
      }
      if (typeof settings.keybind === "string") {
        config.pushToTalkKeybind = settings.keybind;
      }
      if (settings.mode === "hold" || settings.mode === "toggle") {
        config.pushToTalkMode = settings.mode;
      }
      if (typeof settings.releaseDelay === "number") {
        config.pushToTalkReleaseDelay = settings.releaseDelay;
      }

      // handle enabling/disabling PTT
      if (typeof settings.enabled === "boolean") {
        if (settings.enabled && !wasEnabled) {
          // PTT was just enabled - register hotkey
          pttLog("PTT enabled, registering hotkey...");
          registerPushToTalkHotkey();
        } else if (!settings.enabled && wasEnabled) {
          // PTT was just disabled - unregister hotkey
          pttLog("PTT disabled, unregistering hotkey...");
          unregisterPushToTalkHotkey();
        }
      }

      // send updated config back to renderer
      sendPttConfig();

      pttLog("Config updated and saved");
    },
  );

  ipcMain.on("push-to-talk-request-config", () => {
    pttLog("Renderer requested PTT config, sending...");
    sendPttConfig();
  });

  if (config.pushToTalk) {
    registerPushToTalkHotkey();
  }
}

export function cleanupPushToTalk(): void {
  pttLog("Cleaning up PTT...");
  unregisterPushToTalkHotkey();
}
