/* eslint-disable @typescript-eslint/no-explicit-any */
import * as path from "node:path";

import { app, ipcMain } from "electron";

import { config } from "./config";
import { mainWindow } from "./window";

let GlobalKeyboardListener: any = null;
let keyboardListenerInstance: any = null;
let keyspyListener:
  | ((event: any, isDown: Record<string, boolean>) => boolean | void)
  | null = null;

function loadKeyspy() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const keyspy = require("keyspy");
    GlobalKeyboardListener = keyspy.GlobalKeyboardListener;
  } catch {
    const unpackedPath = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "keyspy",
      "dist",
      "index.js",
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const keyspy = require(unpackedPath);
    GlobalKeyboardListener = keyspy.GlobalKeyboardListener;
  }
}

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;
function pttLog(...args: unknown[]) {
  if (isDev) {
    console.log("[PTT]", ...args);
  }
}

let isPttActive = false;
let isKeyspyRunning = false;
let isKeyspyIntentionallyStopped = false;
let isWindowFocused = false;
let keyspyRestartAttempts = 0;
let keyspyRestartTimeout: NodeJS.Timeout | null = null;
const MAX_KEYSPY_RESTART_ATTEMPTS = 5;
const KEYSPY_RESTART_DELAY_MS = 2000;

let currentKeybind = "";
let keybindModifiers = { ctrl: false, shift: false, alt: false, meta: false };

let releaseDelayTimeout: NodeJS.Timeout | null = null;

const heldKeys = new Set<string>();
let pttActivationKey: string | null = null;

function getReleaseDelay(): number {
  return config.pushToTalkReleaseDelay || 0;
}

pttLog("Module loaded (using keyspy)");

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
  pttLog(`deactivatePtt: reason="${reason}", isPttActive=${isPttActive}`);

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
}

function activatePtt(reason: string) {
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
  const parts = accelerator.split("+").map((p) => p.trim());
  let key = parts.pop() || "";

  if (key === "" && accelerator.endsWith("+")) {
    key = "+";
  }

  const modifiers = parts.map((p) => p.toLowerCase());

  return {
    key: key.toLowerCase(),
    ctrl: modifiers.includes("ctrl") || modifiers.includes("control"),
    shift: modifiers.includes("shift"),
    alt: modifiers.includes("alt"),
    meta:
      modifiers.includes("meta") ||
      modifiers.includes("cmd") ||
      modifiers.includes("command"),
  };
}

function hasKeybindModifiers(): boolean {
  return (
    keybindModifiers.ctrl ||
    keybindModifiers.shift ||
    keybindModifiers.alt ||
    keybindModifiers.meta
  );
}

function matchesKeybind(input: Electron.Input, checkModifiers = true): boolean {
  const keyMatches = input.key.toLowerCase() === currentKeybind.toLowerCase();
  if (!keyMatches) return false;

  if (!checkModifiers) return true;

  if (!hasKeybindModifiers()) {
    return true;
  }

  const ctrlMatch = keybindModifiers.ctrl === input.control;
  const shiftMatch = keybindModifiers.shift === input.shift;
  const altMatch = keybindModifiers.alt === input.alt;
  const metaMatch = keybindModifiers.meta === input.meta;

  return ctrlMatch && shiftMatch && altMatch && metaMatch;
}

function normalizeKeyName(name: string | undefined): string {
  if (!name) return "";
  return name.toLowerCase();
}

function keyspyKeyToAccelerator(keyspyName: string): string {
  const key = normalizeKeyName(keyspyName);

  const keyMapping: Record<string, string> = {
    oem_1: ";",
    oem_2: "/",
    oem_3: "`",
    oem_4: "[",
    oem_5: "\\",
    oem_6: "]",
    oem_7: "'",
    oem_comma: ",",
    oem_period: ".",
    oem_minus: "-",
    oem_plus: "=",
    semicolon: ";",
    slash: "/",
    backquote: "`",
    bracketleft: "[",
    backslash: "\\",
    bracketright: "]",
    quote: "'",
    apostrophe: "'",
    grave: "`",
    leftbrace: "[",
    rightbrace: "]",
    comma: ",",
    period: ".",
    dot: ".",
    minus: "-",
    equal: "=",
    equals: "=",
    space: " ",
  };

  return keyMapping[key] || key;
}

function matchesKeyspyEvent(
  event: any,
  isDown: Record<string, boolean>,
  checkModifiers = true,
): boolean {
  const keyspyKeyName = normalizeKeyName(event.name);
  const normalizedAccelerator = currentKeybind.toLowerCase();
  const mappedKeyspyKey = keyspyKeyToAccelerator(keyspyKeyName);
  const keyMatches = mappedKeyspyKey === normalizedAccelerator;
  if (!keyMatches) return false;

  if (!checkModifiers) return true;

  if (!hasKeybindModifiers()) {
    return true;
  }

  const ctrlMatch =
    keybindModifiers.ctrl ===
    (isDown["LEFT CTRL"] || isDown["RIGHT CTRL"] || false);
  const shiftMatch =
    keybindModifiers.shift ===
    (isDown["LEFT SHIFT"] || isDown["RIGHT SHIFT"] || false);
  const altMatch =
    keybindModifiers.alt ===
    (isDown["LEFT ALT"] || isDown["RIGHT ALT"] || false);
  const metaMatch =
    keybindModifiers.meta ===
    (isDown["LEFT META"] || isDown["RIGHT META"] || false);

  return ctrlMatch && shiftMatch && altMatch && metaMatch;
}

function handleBeforeInputEvent(event: Electron.Event, input: Electron.Input) {
  const keyIdentifier = input.code;
  const isKeyUpForActivePtt =
    input.type === "keyUp" && pttActivationKey === keyIdentifier;
  const isPttKey = isKeyUpForActivePtt
    ? matchesKeybind(input, false)
    : matchesKeybind(input);
  const focused = mainWindow?.isFocused() ?? false;

  pttLog(
    `Input event: type=${input.type}, key=${input.key}, code=${input.code}, ` +
      `isPttKey=${isPttKey}, pttActive=${isPttActive}, focused=${focused}`,
  );

  if (!isPttKey) {
    if (input.type === "keyDown") {
      heldKeys.add(keyIdentifier);
    } else if (input.type === "keyUp") {
      heldKeys.delete(keyIdentifier);
    }
    return;
  }

  if (config.pushToTalkMode === "hold") {
    if (input.type === "keyDown") {
      if (heldKeys.has(keyIdentifier)) {
        pttLog(`Ignoring auto-repeat keyDown for: ${keyIdentifier}`);
        return;
      }

      heldKeys.add(keyIdentifier);

      if (!isPttActive || pttActivationKey === null) {
        pttActivationKey = keyIdentifier;
        activatePtt(
          "before-input-event keyDown" +
            (focused ? " (focused)" : " (unfocused)"),
        );
      }
    } else if (input.type === "keyUp") {
      heldKeys.delete(keyIdentifier);

      if (pttActivationKey === keyIdentifier) {
        pttActivationKey = null;
        deactivatePtt(
          "before-input-event keyUp" +
            (focused ? " (focused)" : " (unfocused)"),
        );
      }
    }
  } else {
    if (input.type === "keyDown") {
      if (heldKeys.has(keyIdentifier)) {
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

async function startKeyspy(): Promise<void> {
  if (isKeyspyRunning) {
    pttLog("Keyspy already running");
    return;
  }

  if (!GlobalKeyboardListener) {
    loadKeyspy();
  }

  if (!GlobalKeyboardListener) {
    pttLog("✗ Failed to load keyspy");
    return;
  }

  pttLog("Starting keyspy...");

  try {
    keyboardListenerInstance = new GlobalKeyboardListener();

    if (keyboardListenerInstance.proc) {
      keyboardListenerInstance.proc.on(
        "exit",
        (code: number, signal: string) => {
          pttLog(`Keyspy process exited with code ${code}, signal: ${signal}`);
          handleKeyspyCrash("process-exit", code, signal);
        },
      );

      keyboardListenerInstance.proc.on("error", (err: Error) => {
        pttLog(`Keyspy process error: ${err.message}`);
        handleKeyspyCrash("process-error", -1, err.message);
      });
    }

    keyspyListener = (event: any, isDown: Record<string, boolean>) => {
      if (isWindowFocused) {
        return false;
      }

      const keyName = normalizeKeyName(event.name);
      const isKeyUpForActivePtt =
        event.state === "UP" && normalizeKeyName(pttActivationKey) === keyName;
      const isPttKey = isKeyUpForActivePtt
        ? matchesKeyspyEvent(event, isDown, false)
        : matchesKeyspyEvent(event, isDown);

      pttLog(
        `Keyspy event: name=${event.name}, state=${event.state}, ` +
          `isPttKey=${isPttKey}, pttActive=${isPttActive}`,
      );

      if (!isPttKey) {
        return false;
      }

      if (config.pushToTalkMode === "hold") {
        if (event.state === "DOWN") {
          const keyIdentifier = event.name;

          if (heldKeys.has(keyIdentifier)) {
            pttLog(`Ignoring auto-repeat for: ${keyIdentifier}`);
            return false;
          }

          heldKeys.add(keyIdentifier);

          if (!isPttActive || pttActivationKey === null) {
            pttActivationKey = keyIdentifier;
            activatePtt("keyspy global keydown");
          }
        } else if (event.state === "UP") {
          const keyIdentifier = event.name;
          heldKeys.delete(keyIdentifier);

          if (pttActivationKey === keyIdentifier) {
            pttActivationKey = null;
            deactivatePtt("keyspy global keyup");
          }
        }
      } else {
        if (event.state === "DOWN") {
          const keyIdentifier = event.name;
          if (heldKeys.has(keyIdentifier)) {
            return false;
          }
          heldKeys.add(keyIdentifier);

          isPttActive = !isPttActive;
          sendPttState(isPttActive);
          pttLog("Keyspy PTT toggled:", isPttActive ? "ON" : "OFF");
        } else if (event.state === "UP") {
          heldKeys.delete(event.name);
        }
      }

      return false;
    };

    await keyboardListenerInstance.addListener(keyspyListener);
    isKeyspyRunning = true;
    isKeyspyIntentionallyStopped = false;
    keyspyRestartAttempts = 0;
    pttLog("✓ Keyspy started successfully");
  } catch (err: any) {
    pttLog("✗ Failed to start keyspy:", err?.message || err);
    handleKeyspyCrash("start-error", -1, err?.message || String(err));
  }
}

function handleKeyspyCrash(
  reason: string,
  exitCode: number,
  signalOrError: string,
): void {
  if (!isKeyspyRunning) {
    return;
  }

  if (isKeyspyIntentionallyStopped) {
    pttLog("Keyspy stopped intentionally, not restarting");
    return;
  }

  pttLog(
    `Keyspy crashed: ${reason}, code: ${exitCode}, detail: ${signalOrError}`,
  );

  keyboardListenerInstance = null;
  isKeyspyRunning = false;
  keyspyListener = null;
  keyspyRestartAttempts++;

  if (keyspyRestartAttempts > MAX_KEYSPY_RESTART_ATTEMPTS) {
    pttLog(
      `✗ Max restart attempts (${MAX_KEYSPY_RESTART_ATTEMPTS}) reached. Giving up.`,
    );
    return;
  }

  if (keyspyRestartTimeout) {
    clearTimeout(keyspyRestartTimeout);
  }

  const delay = KEYSPY_RESTART_DELAY_MS * keyspyRestartAttempts;
  pttLog(
    `Attempting to restart keyspy in ${delay}ms (attempt ${keyspyRestartAttempts}/${MAX_KEYSPY_RESTART_ATTEMPTS})...`,
  );

  keyspyRestartTimeout = setTimeout(() => {
    if (config.pushToTalk && mainWindow && !mainWindow.isDestroyed()) {
      startKeyspy();
    }
  }, delay);
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

  sendPttConfig();

  if (mainWindow && !mainWindow.isDestroyed()) {
    pttLog("Setting up before-input-event listener...");

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

  if (mainWindow && !mainWindow.isDestroyed()) {
    isWindowFocused = mainWindow.isFocused();
    pttLog("Window initially focused:", isWindowFocused);

    await startKeyspy();

    // track focus state for ignoring keyspy events when focused
    mainWindow.on("focus", () => {
      if (!isWindowFocused) {
        pttLog("Window focused - keyspy events will be ignored");
        isWindowFocused = true;
        heldKeys.clear();
        pttActivationKey = null;
      }
    });

    mainWindow.on("blur", () => {
      if (isWindowFocused) {
        pttLog("Window blurred - keyspy events will now be processed");
        isWindowFocused = false;
        heldKeys.clear();
        pttActivationKey = null;
      }
    });
  }

  isPttActive = false;
  sendPttState(false);
  pttLog("✓ PTT initialized with keyspy");
}

export function unregisterPushToTalkHotkey(): void {
  pttLog("Unregistering PTT hotkey...");

  deactivatePtt("unregister");

  if (keyspyRestartTimeout) {
    clearTimeout(keyspyRestartTimeout);
    keyspyRestartTimeout = null;
  }
  keyspyRestartAttempts = 0;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.off("before-input-event", handleBeforeInputEvent);
    pttLog("Removed before-input-event listener");
  }

  if (isKeyspyRunning && keyboardListenerInstance) {
    isKeyspyIntentionallyStopped = true;
    try {
      keyboardListenerInstance.kill();
      pttLog("Keyspy killed");
    } catch (err) {
      pttLog("Error killing keyspy:", err);
    }
    keyboardListenerInstance = null;
    isKeyspyRunning = false;
    keyspyListener = null;
  }

  heldKeys.clear();
  pttActivationKey = null;
}

export function getPushToTalkState(): boolean {
  return isPttActive;
}

export function initPushToTalk(): void {
  pttLog("Initializing PTT (keyspy method)...");
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

      const wasEnabled = config.pushToTalk;

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

      if (typeof settings.enabled === "boolean") {
        if (settings.enabled && !wasEnabled) {
          pttLog("PTT enabled, registering hotkey...");
          registerPushToTalkHotkey();
        } else if (!settings.enabled && wasEnabled) {
          pttLog("PTT disabled, unregistering hotkey...");
          unregisterPushToTalkHotkey();
        }
      }

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
