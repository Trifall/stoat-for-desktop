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

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") {
    pttLog("Caught EPIPE uncaught exception from keyspy");
    if (!crashHandled && isKeyspyRunning && !isKeyspyIntentionallyStopped) {
      crashHandled = true;
      handleKeyspyCrash("epipe-uncaught", -1, err.message);
    }
    return;
  }
  throw err;
});

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
let isRestarting = false;
let isWindowFocused = false;
let keyspyRestartAttempts = 0;
let keyspyRestartTimeout: NodeJS.Timeout | null = null;
let crashHandled = false;
let focusHandler: (() => void) | null = null;
let blurHandler: (() => void) | null = null;
const MAX_KEYSPY_RESTART_ATTEMPTS = 5;
const KEYSPY_RESTART_DELAY_MS = 2000;
const KEYSPY_WATCHDOG_MS = 3000;

let keyspyWatchdogInterval: NodeJS.Timeout | null = null;

function startKeyspyWatchdog() {
  stopKeyspyWatchdog();
  keyspyWatchdogInterval = setInterval(() => {
    if (!isKeyspyRunning || isKeyspyIntentionallyStopped || crashHandled)
      return;

    const proc = keyboardListenerInstance?.proc;
    if (!proc?.pid) return;

    try {
      process.kill(proc.pid, 0);
    } catch {
      if (!crashHandled) {
        crashHandled = true;
        pttLog("Watchdog detected dead keyspy process");
        handleKeyspyCrash("watchdog", -1, "process not found");
      }
    }
  }, KEYSPY_WATCHDOG_MS);
}

function stopKeyspyWatchdog() {
  if (keyspyWatchdogInterval) {
    clearInterval(keyspyWatchdogInterval);
    keyspyWatchdogInterval = null;
  }
}

interface ParsedKeybind {
  id: string;
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

let currentKeybinds: ParsedKeybind[] = [];

let releaseDelayTimeout: NodeJS.Timeout | null = null;

const heldKeys = new Set<string>();
const heldPttBindings = new Set<string>();
const heldPttBindingsByKey = new Map<string, string>();

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

function parseAccelerator(accelerator: string): ParsedKeybind {
  const parts = accelerator.split("+").map((p) => p.trim());
  let key = parts.pop() || "";

  if (key === "" && accelerator.endsWith("+")) {
    key = "+";
  }

  const modifiers = parts.map((p) => p.toLowerCase());

  const parsed = {
    key: key.toLowerCase(),
    ctrl: modifiers.includes("ctrl") || modifiers.includes("control"),
    shift: modifiers.includes("shift"),
    alt: modifiers.includes("alt"),
    meta:
      modifiers.includes("meta") ||
      modifiers.includes("cmd") ||
      modifiers.includes("command"),
  };

  return {
    ...parsed,
    id: `${parsed.ctrl ? "Ctrl+" : ""}${parsed.alt ? "Alt+" : ""}${parsed.shift ? "Shift+" : ""}${parsed.meta ? "Meta+" : ""}${parsed.key}`,
  };
}

function parseAccelerators(accelerators: string): ParsedKeybind[] {
  try {
    const parsed = JSON.parse(accelerators);
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (accelerator): accelerator is string =>
            typeof accelerator === "string",
        )
        .filter(Boolean)
        .map(parseAccelerator);
    }
  } catch {
    // Legacy configs stored a single accelerator string.
  }

  return accelerators.trim() ? [parseAccelerator(accelerators.trim())] : [];
}

function hasKeybindModifiers(keybind: ParsedKeybind): boolean {
  return keybind.ctrl || keybind.shift || keybind.alt || keybind.meta;
}

/**
 * Map Electron input.code to the character it produces (US layout).
 * Used as fallback when input.key doesn't match on Windows OEM keys.
 */
const codeToCharMap: Record<string, string> = {
  Semicolon: ";",
  Slash: "/",
  Backquote: "`",
  BracketLeft: "[",
  Backslash: "\\",
  BracketRight: "]",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Minus: "-",
  Equal: "=",
  Space: " ",
};

function findMatchingKeybind(
  input: Electron.Input,
  checkModifiers = true,
): ParsedKeybind | undefined {
  const inputKey = input.key.toLowerCase();
  const inputCodeKey = input.code ? codeToCharMap[input.code] : undefined;

  return currentKeybinds.find((keybind) => {
    const keyMatches = inputKey === keybind.key || inputCodeKey === keybind.key;
    if (!keyMatches) return false;

    if (!checkModifiers) return true;

    if (!hasKeybindModifiers(keybind)) {
      return true;
    }

    const ctrlMatch = keybind.ctrl === input.control;
    const shiftMatch = keybind.shift === input.shift;
    const altMatch = keybind.alt === input.alt;
    const metaMatch = keybind.meta === input.meta;

    return ctrlMatch && shiftMatch && altMatch && metaMatch;
  });
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

    // Windows keyspy standardName values (have spaces)
    "square bracket open": "[",
    "square bracket close": "]",
    "forward slash": "/",
    section: "`",
    backtick: "`",
  };

  return keyMapping[key] || key;
}

function findMatchingKeyspyBinding(
  event: any,
  isDown: Record<string, boolean>,
  checkModifiers = true,
): ParsedKeybind | undefined {
  const keyspyKeyName = normalizeKeyName(event.name);
  const mappedKeyspyKey = keyspyKeyToAccelerator(keyspyKeyName);

  return currentKeybinds.find((keybind) => {
    const keyMatches = mappedKeyspyKey === keybind.key;
    if (!keyMatches) return false;

    if (!checkModifiers) return true;

    if (!hasKeybindModifiers(keybind)) {
      return true;
    }

    const ctrlMatch =
      keybind.ctrl === (isDown["LEFT CTRL"] || isDown["RIGHT CTRL"] || false);
    const shiftMatch =
      keybind.shift ===
      (isDown["LEFT SHIFT"] || isDown["RIGHT SHIFT"] || false);
    const altMatch =
      keybind.alt === (isDown["LEFT ALT"] || isDown["RIGHT ALT"] || false);
    const metaMatch =
      keybind.meta === (isDown["LEFT META"] || isDown["RIGHT META"] || false);

    return ctrlMatch && shiftMatch && altMatch && metaMatch;
  });
}

function handleBeforeInputEvent(event: Electron.Event, input: Electron.Input) {
  const keyIdentifier = input.code;
  const keyStateId = `input:${keyIdentifier}`;
  const matchingKeybind =
    input.type === "keyUp"
      ? currentKeybinds.find(
          (keybind) => keybind.id === heldPttBindingsByKey.get(keyStateId),
        )
      : findMatchingKeybind(input);
  const focused = mainWindow?.isFocused() ?? false;

  pttLog(
    `Input event: type=${input.type}, key=${input.key}, code=${input.code}, ` +
      `isPttKey=${Boolean(matchingKeybind)}, pttActive=${isPttActive}, focused=${focused}`,
  );

  if (!matchingKeybind) {
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

      heldPttBindings.add(matchingKeybind.id);
      heldPttBindingsByKey.set(keyStateId, matchingKeybind.id);
      activatePtt(
        "before-input-event keyDown" +
          (focused ? " (focused)" : " (unfocused)"),
      );
    } else if (input.type === "keyUp") {
      heldKeys.delete(keyIdentifier);

      heldPttBindings.delete(matchingKeybind.id);
      heldPttBindingsByKey.delete(keyStateId);
      if (heldPttBindings.size === 0) {
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
      heldPttBindingsByKey.set(keyStateId, matchingKeybind.id);

      isPttActive = !isPttActive;
      sendPttState(isPttActive);
      pttLog("PTT toggled:", isPttActive ? "ON" : "OFF");
    } else if (input.type === "keyUp") {
      heldKeys.delete(keyIdentifier);
      heldPttBindingsByKey.delete(keyStateId);
    }
  }
}

async function startKeyspy(): Promise<void> {
  if (isKeyspyRunning) {
    pttLog("Keyspy already running");
    return;
  }

  isKeyspyIntentionallyStopped = false;
  isRestarting = false;
  crashHandled = false;

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
      const suppressError = (err: Error) => {
        pttLog(`Keyspy stream error (suppressed): ${err.message}`);
      };
      keyboardListenerInstance.proc.stdin?.on("error", (err: Error) => {
        pttLog(`Keyspy stdin error: ${err.message}`);
        if (!crashHandled && !isKeyspyIntentionallyStopped) {
          crashHandled = true;
          handleKeyspyCrash("stdin-error", -1, err.message);
        }
      });
      keyboardListenerInstance.proc.stdout?.on("error", suppressError);
      keyboardListenerInstance.proc.stderr?.on("error", suppressError);

      keyboardListenerInstance.proc.stdout?.once("close", () => {
        if (!crashHandled && !isKeyspyIntentionallyStopped) {
          crashHandled = true;
          pttLog("Keyspy stdout closed unexpectedly");
          handleKeyspyCrash("stdout-close", -1, "stdout closed");
        }
      });

      keyboardListenerInstance.proc.once(
        "exit",
        (code: number, signal: string) => {
          if (crashHandled) return;
          crashHandled = true;
          pttLog(`Keyspy process exited with code ${code}, signal: ${signal}`);
          handleKeyspyCrash("process-exit", code, signal);
        },
      );

      keyboardListenerInstance.proc.once("error", (err: Error) => {
        if (crashHandled) return;
        crashHandled = true;
        pttLog(`Keyspy process error: ${err.message}`);
        handleKeyspyCrash("process-error", -1, err.message);
      });
    }

    startKeyspyWatchdog();

    keyspyListener = (event: any, isDown: Record<string, boolean>) => {
      if (isWindowFocused) {
        return false;
      }

      const keyName = normalizeKeyName(event.name);
      const mappedKey = keyspyKeyToAccelerator(keyName);
      const keyStateId = `keyspy:${mappedKey}`;

      if (!keyName || keyName === "unknown") {
        return false;
      }

      const matchingKeybind =
        event.state === "UP"
          ? currentKeybinds.find(
              (keybind) => keybind.id === heldPttBindingsByKey.get(keyStateId),
            )
          : findMatchingKeyspyBinding(event, isDown);

      pttLog(
        `Keyspy event: name=${event.name}, mapped=${mappedKey}, state=${event.state}, ` +
          `isPttKey=${Boolean(matchingKeybind)}, pttActive=${isPttActive}`,
      );

      if (!matchingKeybind) {
        return false;
      }

      if (config.pushToTalkMode === "hold") {
        if (event.state === "DOWN") {
          if (heldKeys.has(keyName) || heldKeys.has(mappedKey)) {
            pttLog(`Ignoring auto-repeat for: ${keyName}`);
            return false;
          }

          heldKeys.add(keyName);
          heldKeys.add(mappedKey);

          heldPttBindings.add(matchingKeybind.id);
          heldPttBindingsByKey.set(keyStateId, matchingKeybind.id);
          activatePtt("keyspy global keydown");
        } else if (event.state === "UP") {
          heldKeys.delete(keyName);
          heldKeys.delete(mappedKey);

          heldPttBindings.delete(matchingKeybind.id);
          heldPttBindingsByKey.delete(keyStateId);
          if (heldPttBindings.size === 0) {
            deactivatePtt("keyspy global keyup");
          }
        }
      } else {
        if (event.state === "DOWN") {
          if (heldKeys.has(keyName) || heldKeys.has(mappedKey)) {
            return false;
          }
          heldKeys.add(keyName);
          heldKeys.add(mappedKey);
          heldPttBindingsByKey.set(keyStateId, matchingKeybind.id);

          isPttActive = !isPttActive;
          sendPttState(isPttActive);
          pttLog("Keyspy PTT toggled:", isPttActive ? "ON" : "OFF");
        } else if (event.state === "UP") {
          heldKeys.delete(keyName);
          heldKeys.delete(mappedKey);
          heldPttBindingsByKey.delete(keyStateId);
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
    isRestarting = false;
    handleKeyspyCrash("start-error", -1, err?.message || String(err));
  }
}

function handleKeyspyCrash(
  reason: string,
  exitCode: number,
  signalOrError: string,
): void {
  if (isKeyspyIntentionallyStopped) {
    pttLog("Keyspy stopped intentionally, not restarting");
    return;
  }

  if (isRestarting) {
    pttLog("Already restarting, ignoring duplicate crash event");
    return;
  }

  pttLog(
    `Keyspy crashed: ${reason}, code: ${exitCode}, detail: ${signalOrError}`,
  );

  heldKeys.clear();
  heldPttBindings.clear();
  heldPttBindingsByKey.clear();

  // hold mode should fail closed. toggle mode should be latched.
  // this handles if keyspy crashes, the user should retain the most likely intended state.
  if (config.pushToTalkMode === "hold" && isPttActive) {
    isPttActive = false;
    sendPttState(false);
  }

  keyboardListenerInstance = null;
  isKeyspyRunning = false;
  stopKeyspyWatchdog();
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

  isRestarting = true;
  const delay = KEYSPY_RESTART_DELAY_MS + (keyspyRestartAttempts - 1) * 1000;
  pttLog(
    `Attempting to restart keyspy in ${delay}ms (attempt ${keyspyRestartAttempts}/${MAX_KEYSPY_RESTART_ATTEMPTS})...`,
  );

  keyspyRestartTimeout = setTimeout(async () => {
    if (config.pushToTalk && mainWindow && !mainWindow.isDestroyed()) {
      try {
        await startKeyspy();
      } catch (err) {
        pttLog("Error during keyspy restart:", err);
        isRestarting = false;
      }
    } else {
      isRestarting = false;
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

  unregisterPushToTalkHotkey({ resetState: config.pushToTalkMode === "hold" });

  currentKeybinds = parseAccelerators(accelerator);

  pttLog("Parsed keybinds:", currentKeybinds);

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

    if (focusHandler) {
      mainWindow.off("focus", focusHandler);
    }
    if (blurHandler) {
      mainWindow.off("blur", blurHandler);
    }

    focusHandler = () => {
      if (!isWindowFocused) {
        pttLog("Window focused - keyspy events will be ignored");
        isWindowFocused = true;
        heldKeys.clear();
        heldPttBindings.clear();
        heldPttBindingsByKey.clear();
        if (config.pushToTalkMode === "hold") {
          deactivatePtt("window-focused", false);
        }
      }
    };

    blurHandler = () => {
      if (isWindowFocused) {
        pttLog("Window blurred - keyspy events will now be processed");
        isWindowFocused = false;
        heldKeys.clear();
        heldPttBindings.clear();
        heldPttBindingsByKey.clear();
        if (config.pushToTalkMode === "hold") {
          deactivatePtt("window-blurred", false);
        }
      }
    };

    mainWindow.on("focus", focusHandler);
    mainWindow.on("blur", blurHandler);
  }

  if (config.pushToTalkMode === "hold") {
    isPttActive = false;
    sendPttState(false);
  } else {
    pttLog("Toggle mode preserving PTT state:", isPttActive ? "ON" : "OFF");
  }
  pttLog("✓ PTT initialized with keyspy");
}

export function unregisterPushToTalkHotkey(
  options: { resetState?: boolean } = {},
): void {
  pttLog("Unregistering PTT hotkey...");

  const resetState = options.resetState ?? true;

  if (resetState) {
    deactivatePtt("unregister", false);
  } else if (releaseDelayTimeout) {
    clearTimeout(releaseDelayTimeout);
    releaseDelayTimeout = null;
  }

  stopKeyspyWatchdog();

  if (keyspyRestartTimeout) {
    clearTimeout(keyspyRestartTimeout);
    keyspyRestartTimeout = null;
  }
  keyspyRestartAttempts = 0;
  isRestarting = false;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.off("before-input-event", handleBeforeInputEvent);

    if (focusHandler) {
      mainWindow.off("focus", focusHandler);
      focusHandler = null;
    }
    if (blurHandler) {
      mainWindow.off("blur", blurHandler);
      blurHandler = null;
    }

    pttLog("Removed all window listeners");
  }

  if (keyboardListenerInstance) {
    isKeyspyIntentionallyStopped = true;
    isKeyspyRunning = false;

    if (keyspyListener) {
      try {
        keyboardListenerInstance.removeListener?.(keyspyListener);
      } catch {
        /* ignore */
      }
      keyspyListener = null;
    }

    if (keyboardListenerInstance.proc) {
      keyboardListenerInstance.proc.removeAllListeners();
    }

    try {
      keyboardListenerInstance.kill();
      pttLog("Keyspy killed");
    } catch (err) {
      pttLog("Error killing keyspy:", err);
    }
    keyboardListenerInstance = null;
  }

  heldKeys.clear();
  heldPttBindings.clear();
  heldPttBindingsByKey.clear();
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

      sendPttConfig();

      pttLog("Config updated and saved");
    },
  );

  ipcMain.on("push-to-talk-request-config", () => {
    pttLog("Renderer requested PTT config, sending...");
    sendPttConfig();
  });

  ipcMain.on("push-to-talk-request-state", () => {
    pttLog("Renderer requested PTT state, sending...");
    sendPttState(isPttActive);
  });

  if (config.pushToTalk) {
    registerPushToTalkHotkey();
  }
}

export function cleanupPushToTalk(): void {
  pttLog("Cleaning up PTT...");
  unregisterPushToTalkHotkey();
}
