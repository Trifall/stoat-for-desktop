import { contextBridge, ipcRenderer } from "electron";

const stateChangeCallbacks = new Set<(state: { active: boolean }) => void>();
let currentPttState = false;

let pttKeybind = "V";
let pttEnabled = false;
let pttMode: "hold" | "toggle" = "hold";

function pttLog(...args: unknown[]) {
  console.log("[PTT-Renderer]", ...args);
}

function matchesPttKeybind(e: KeyboardEvent): boolean {
  // simple matching - can be rewritten for modifiers
  return e.key.toLowerCase() === pttKeybind.toLowerCase();
}

// Runs at capture phase to intercept before the app's keybind handler
function handleKeyDown(e: KeyboardEvent) {
  if (!pttEnabled || !matchesPttKeybind(e)) {
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
    // Don't stop propagation - let the key be typed
  } else {
    pttLog("PTT key pressed, stopping propagation");
    e.stopPropagation();
  }
}

function handleKeyUp(e: KeyboardEvent) {
  if (!pttEnabled || !matchesPttKeybind(e)) {
    return;
  }

  // Always stop propagation on keyup to match keydown behavior
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

// Listen for PTT state changes from main process
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

// Listen for PTT config updates
ipcRenderer.on(
  "push-to-talk-config",
  (
    _event,
    config: { enabled: boolean; keybind: string; mode: "hold" | "toggle" },
  ) => {
    pttLog("Received PTT config:", config);
    pttEnabled = config.enabled;
    pttKeybind = config.keybind;
    pttMode = config.mode;
  },
);

// Add DOM event listeners at capture phase to intercept before app handlers
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
});

pttLog("Preload script loaded with DOM interception for PTT");
