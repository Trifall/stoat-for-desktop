import { contextBridge, ipcRenderer } from "electron";

const stateChangeCallbacks = new Set<(state: { active: boolean }) => void>();
const configCallbacks = new Set<(config: PttConfig) => void>();
let currentPttState = false;

interface PttConfig {
  enabled: boolean;
  keybind: string;
  mode: "hold" | "toggle";
  releaseDelay: number;
}

interface ParsedKeybind {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

let pttConfig: PttConfig = {
  enabled: false,
  keybind: "V",
  mode: "hold",
  releaseDelay: 0,
};

let parsedKeybinds: ParsedKeybind[] = [
  { key: "v", ctrl: false, shift: false, alt: false, meta: false },
];

function pttLog(...args: unknown[]) {
  console.log("[PTT-Renderer]", ...args);
}

function parseAccelerator(accelerator: string): ParsedKeybind {
  // split on "+" only (not "-") to allow keys like "-" and ";"
  const parts = accelerator.split("+").map((p) => p.trim());
  let key = parts.pop() || "";

  // if key is empty and accelerator ends with "+", the key is "+"
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
    // legacy configs stored a single accelerator string.
  }

  return accelerators.trim() ? [parseAccelerator(accelerators.trim())] : [];
}

function matchesPttKeybind(e: KeyboardEvent, checkModifiers = true): boolean {
  const matchingKeybind = parsedKeybinds.find(
    (keybind) => e.key.toLowerCase() === keybind.key,
  );
  if (!matchingKeybind) {
    pttLog(
      `[DEBUG] matchesPttKeybind: e.key="${e.key}", keybind="${pttConfig.keybind}", key mismatch`,
    );
    return false;
  }

  if (!checkModifiers) return true;

  const ctrlMatch = matchingKeybind.ctrl === e.ctrlKey;
  const shiftMatch = matchingKeybind.shift === e.shiftKey;
  const altMatch = matchingKeybind.alt === e.altKey;
  const metaMatch = matchingKeybind.meta === e.metaKey;
  const matches = ctrlMatch && shiftMatch && altMatch && metaMatch;

  pttLog(
    `[DEBUG] matchesPttKeybind: e.key="${e.key}", keybind="${pttConfig.keybind}", modifiers=${JSON.stringify({ ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey })}, matches=${matches}`,
  );
  return matches;
}

// runs at capture phase to intercept before the app's keybind handler
function handleKeyDown(e: KeyboardEvent) {
  pttLog(
    `[DEBUG] DOM keydown: key="${e.key}", code="${e.code}", modifiers=${JSON.stringify({ ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey })}, enabled=${pttConfig.enabled}`,
  );

  if (!pttConfig.enabled || !matchesPttKeybind(e)) {
    pttLog(`[DEBUG] DOM keydown ignored - not PTT key or disabled`);
    return;
  }

  const target = e.target as HTMLElement;
  const isInput =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    target.closest("mdui-text-field") !== null;

  if (isInput) {
    pttLog("PTT key pressed in input field, allowing typing + activating PTT");
    // don't stop propagation - let the key be typed
  } else {
    pttLog("PTT key pressed, stopping propagation");
    e.stopPropagation();
  }
}

function handleKeyUp(e: KeyboardEvent) {
  pttLog(
    `[DEBUG] DOM keyup: key="${e.key}", code="${e.code}", modifiers=${JSON.stringify({ ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey })}, enabled=${pttConfig.enabled}`,
  );

  // for keyUp, relax modifier checks - the modifier may have been released
  // before the main key in combos like Shift+Space
  if (!pttConfig.enabled || !matchesPttKeybind(e, false)) {
    pttLog(`[DEBUG] DOM keyup ignored - not PTT key or disabled`);
    return;
  }

  pttLog(`[DEBUG] DOM keyup matched PTT keybind`);

  // always stop propagation on keyup to match keydown behavior
  const target = e.target as HTMLElement;
  const isInput =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable ||
    target.closest("mdui-text-field") !== null;

  if (!isInput) {
    e.stopPropagation();
  }
}

// listen for PTT state changes from main process
ipcRenderer.on("push-to-talk", (_event, state: { active: boolean }) => {
  pttLog("Received PTT state from main:", state.active ? "ON" : "OFF");

  if (currentPttState !== state.active) {
    currentPttState = state.active;
    stateChangeCallbacks.forEach((cb) => {
      try {
        cb(state);
      } catch (err) {
        console.error("[PTT] Error in callback:", err);
      }
    });
  }
});

// listen for PTT config updates
ipcRenderer.on("push-to-talk-config", (_event, config: PttConfig) => {
  pttLog("Received PTT config from main:", config);
  pttConfig = { ...pttConfig, ...config };
  parsedKeybinds = parseAccelerators(pttConfig.keybind);
  // notify all config listeners
  configCallbacks.forEach((cb) => {
    try {
      cb(pttConfig);
    } catch (err) {
      console.error("[PTT] Error in config callback:", err);
    }
  });
});

// add DOM event listeners at capture phase to intercept before app handlers
document.addEventListener("keydown", handleKeyDown, true);
document.addEventListener("keyup", handleKeyUp, true);

contextBridge.exposeInMainWorld("pushToTalk", {
  /**
   * Subscribe to PTT state changes
   */
  onStateChange: (callback: (state: { active: boolean }) => void) => {
    stateChangeCallbacks.add(callback);
    pttLog("Listener added. Current state:", currentPttState ? "ON" : "OFF");
    callback({ active: currentPttState });
  },

  /**
   * Unsubscribe from PTT state changes
   */
  offStateChange: (callback: (state: { active: boolean }) => void) => {
    stateChangeCallbacks.delete(callback);
    pttLog("Listener removed");
  },

  /**
   * Manually set PTT state (for UI buttons, etc.)
   */
  setManualState: (active: boolean) => {
    pttLog("Manual state set:", active);
    ipcRenderer.send("push-to-talk-manual", { active });
    currentPttState = active;
    stateChangeCallbacks.forEach((cb) => {
      try {
        cb({ active });
      } catch (err) {
        console.error("[PTT] Error in callback:", err);
      }
    });
  },

  getCurrentState: () => {
    return { active: currentPttState };
  },

  isAvailable: () => true,

  /**
   * Update PTT settings from renderer to main process
   */
  updateSettings: (settings: {
    enabled?: boolean;
    keybind?: string;
    mode?: "hold" | "toggle";
    releaseDelay?: number;
  }) => {
    pttLog("Sending PTT settings update to main:", settings);
    ipcRenderer.send("push-to-talk-update-settings", settings);
  },

  /**
   * Get current PTT config
   */
  getConfig: () => {
    return pttConfig;
  },

  /**
   * Subscribe to PTT config changes
   */
  onConfigChange: (callback: (config: PttConfig) => void) => {
    configCallbacks.add(callback);
    pttLog("Config listener added. Current config:", pttConfig);
    // Immediately call with current config
    callback(pttConfig);
  },

  /**
   * Unsubscribe from PTT config changes
   */
  offConfigChange: (callback: (config: PttConfig) => void) => {
    configCallbacks.delete(callback);
    pttLog("Config listener removed");
  },
});

// Request initial config from main process
pttLog("Requesting initial PTT config from main...");
ipcRenderer.send("push-to-talk-request-config");

pttLog("Preload script loaded with DOM interception for PTT");
