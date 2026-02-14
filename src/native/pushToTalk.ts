import { globalShortcut, ipcMain } from "electron";

import { config } from "./config";
import { mainWindow } from "./window";

function pttLog(...args: unknown[]) {
  console.log("[PTT]", ...args);
}

let isPttActive = false;
let registeredAccelerator: string | null = null;

let currentKeybind = "";
let keybindModifiers = { ctrl: false, shift: false, alt: false, meta: false };

let holdModeTimeout: NodeJS.Timeout | null = null;
let releaseDelayTimeout: NodeJS.Timeout | null = null;
const GLOBAL_HOLD_TIMEOUT_MS = 400; // Longer timeout to avoid initial blip
let lastGlobalTriggerTime = 0;
let lastActivationTime = 0;
const MIN_HOLD_DURATION_MS = 600; // Don't allow deactivation for first 600ms

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

function deactivatePtt(reason: string, useDelay = true) {
  // Clear any existing release delay timeout
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
    }
  }

  if (holdModeTimeout) {
    clearTimeout(holdModeTimeout);
    holdModeTimeout = null;
  }
}

function activatePtt(reason: string) {
  // Cancel any pending release delay when re-activating
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
  const keyMatch = input.key.toLowerCase() === currentKeybind.toLowerCase();
  const ctrlMatch = input.control === keybindModifiers.ctrl;
  const shiftMatch = input.shift === keybindModifiers.shift;
  const altMatch = input.alt === keybindModifiers.alt;
  const metaMatch = input.meta === keybindModifiers.meta;

  return keyMatch && ctrlMatch && shiftMatch && altMatch && metaMatch;
}

/**
 * Handle before-input-event from webContents
 * This fires for ALL keyboard input, even when window appears unfocused on XWayland
 *
 * IMPORTANT: We do NOT call preventDefault(), so the key still gets typed in inputs.
 * This allows PTT to work AND the key to be typed (like Discord).
 */
function handleBeforeInputEvent(event: Electron.Event, input: Electron.Input) {
  if (!matchesKeybind(input)) {
    return;
  }

  const focused = mainWindow?.isFocused() ?? false;

  if (config.pushToTalkMode === "hold") {
    if (input.type === "keyDown") {
      activatePtt(
        "before-input-event keyDown" +
          (focused ? " (focused)" : " (unfocused)"),
      );
    } else if (input.type === "keyUp") {
      deactivatePtt(
        "before-input-event keyUp" + (focused ? " (focused)" : " (unfocused)"),
      );
    }
  } else {
    // Toggle mode - only respond to keyDown
    if (input.type === "keyDown") {
      isPttActive = !isPttActive;
      sendPttState(isPttActive);
      pttLog("PTT toggled:", isPttActive ? "ON" : "OFF");
    }
  }
}

function registerGlobalHotkey(accelerator: string): boolean {
  pttLog("Registering global hotkey (fallback):", accelerator);

  try {
    if (registeredAccelerator) {
      globalShortcut.unregister(registeredAccelerator);
    }

    const success = globalShortcut.register(accelerator, () => {
      const now = Date.now();
      const timeSinceLastTrigger = now - lastGlobalTriggerTime;
      lastGlobalTriggerTime = now;

      if (!isPttActive) {
        pttLog(
          "Global hotkey triggered (fallback), delta:",
          timeSinceLastTrigger,
          "ms",
        );
      }

      if (config.pushToTalkMode === "hold") {
        if (!isPttActive) {
          lastActivationTime = now;
          activatePtt("global hotkey");
        }

        if (holdModeTimeout) {
          clearTimeout(holdModeTimeout);
        }

        holdModeTimeout = setTimeout(() => {
          const holdDuration = Date.now() - lastActivationTime;
          if (holdDuration >= MIN_HOLD_DURATION_MS) {
            deactivatePtt("global timeout");
          } else {
            pttLog(
              "Extending timeout (held for",
              holdDuration,
              "ms, need",
              MIN_HOLD_DURATION_MS,
              "ms)",
            );
            if (holdModeTimeout) clearTimeout(holdModeTimeout);
            holdModeTimeout = setTimeout(
              () => {
                deactivatePtt("global timeout extended");
              },
              MIN_HOLD_DURATION_MS - holdDuration + 100,
            );
          }
        }, GLOBAL_HOLD_TIMEOUT_MS);
      } else {
        isPttActive = !isPttActive;
        sendPttState(isPttActive);
        pttLog("PTT toggled:", isPttActive ? "ON" : "OFF");
      }
    });

    if (success) {
      registeredAccelerator = accelerator;
      pttLog("✓ Registered global hotkey:", accelerator);
      return true;
    } else {
      pttLog("✗ Failed to register global hotkey");
      return false;
    }
  } catch (err) {
    pttLog("✗ Error registering hotkey:", err);
    return false;
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

  if (registeredAccelerator === accelerator) {
    return;
  }

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

  // Send PTT config to renderer for DOM interception
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("push-to-talk-config", {
      enabled: config.pushToTalk,
      keybind: config.pushToTalkKeybind,
      mode: config.pushToTalkMode,
    });
    pttLog("Sent PTT config to renderer");
  }

  // Set up before-input-event listener (PRIMARY method)
  // This works on XWayland even when window appears unfocused
  if (mainWindow && !mainWindow.isDestroyed()) {
    pttLog("Setting up before-input-event listener...");

    // Remove any existing listener first to avoid duplicates
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

  // Set up focus/blur handlers to toggle globalShortcut
  // When focused: unregister globalShortcut (allow typing)
  // When blurred: register globalShortcut (capture keys globally)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.on("focus", () => {
      pttLog("Window focused - unregistering global hotkey to allow typing");
      if (registeredAccelerator) {
        globalShortcut.unregister(registeredAccelerator);
        registeredAccelerator = null;
      }
    });

    mainWindow.on("blur", () => {
      pttLog("Window blurred - registering global hotkey for unfocused PTT");
      if (config.pushToTalk) {
        registerGlobalHotkey(accelerator);
      }
    });

    if (!mainWindow.isFocused()) {
      const globalSuccess = registerGlobalHotkey(accelerator);
      if (globalSuccess) {
        pttLog("✓ Global hotkey registered (window not focused)");
      }
    } else {
      pttLog(
        "Window is focused - global hotkey not registered (allowing typing)",
      );
    }
  }

  isPttActive = false;
  sendPttState(false);
  pttLog("✓ PTT initialized");
}

export function unregisterPushToTalkHotkey(): void {
  pttLog("Unregistering PTT hotkey...");

  deactivatePtt("unregister");

  // Remove before-input-event listener
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.off("before-input-event", handleBeforeInputEvent);
    pttLog("Removed before-input-event listener");
  }

  if (registeredAccelerator) {
    globalShortcut.unregister(registeredAccelerator);
    pttLog("Unregistered global:", registeredAccelerator);
    registeredAccelerator = null;
  }

  globalShortcut.unregisterAll();
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

  // Listen for manual PTT from renderer
  ipcMain.on("push-to-talk-manual", (_, data: { active: boolean }) => {
    pttLog("Manual PTT state:", data.active);
    isPttActive = data.active;
    sendPttState(data.active);
  });

  if (config.pushToTalk) {
    registerPushToTalkHotkey();
  }
}

export function cleanupPushToTalk(): void {
  pttLog("Cleaning up PTT...");
  unregisterPushToTalkHotkey();
}
