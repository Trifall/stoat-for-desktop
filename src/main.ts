import { updateElectronApp } from "update-electron-app";

import { BrowserWindow, app, shell } from "electron";
import started from "electron-squirrel-startup";

import { autoLaunch } from "./native/autoLaunch";
import { config } from "./native/config";
import { initDiscordRpc } from "./native/discordRpc";
import { cleanupPushToTalk, initPushToTalk } from "./native/pushToTalk";
import { initTray } from "./native/tray";
import {
  BUILD_URL,
  createMainWindow,
  initBuildUrl,
  mainWindow,
} from "./native/window";

// Squirrel-specific logic
// create/remove shortcuts on Windows when installing / uninstalling
// we just need to close out of the app immediately
if (started) {
  app.quit();
}

// disable hw-accel if so requested
if (!config.hardwareAcceleration) {
  app.disableHardwareAcceleration();
}

// ensure only one copy of the application can run
const acquiredLock = app.requestSingleInstanceLock();

if (acquiredLock) {
  // start auto update logic
  updateElectronApp();

  app.on("ready", () => {
    // initialise build URL from command line
    initBuildUrl();

    // enable auto start on Windows and MacOS
    if (config.firstLaunch) {
      if (process.platform === "win32" || process.platform === "darwin") {
        autoLaunch.enable();
      }
    }

    // create window and application contexts
    createMainWindow();
    initTray();
    initDiscordRpc();
    initPushToTalk();

    // Windows specific fix for notifications
    if (process.platform === "win32") {
      app.setAppUserModelId("chat.stoat.notifications");
    }
  });

  // focus the window if we try to launch again
  app.on("second-instance", () => {
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
  });

  // macOS specific behaviour to keep app active in dock:
  // (irrespective of the minimise-to-tray option)

  app.on("window-all-closed", () => {
    cleanupPushToTalk();
    if (process.platform !== "darwin") {
      // Only way I found was to SIGKILL the process since process.exit() and app.exit() didn't work
      process.kill(process.pid, "SIGKILL");
    }
  });

  // Clean up PTT on quit
  app.on("before-quit", () => {
    cleanupPushToTalk();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // ensure URLs launch in external context
  app.on("web-contents-created", (_, contents) => {
    // Allow navigation to Stoat/Revolt API and CDN domains
    const allowedOrigins = [
      "https://stoat.chat",
      "https://beta.revolt.chat",
      "https://revolt.chat",
      "https://api.revolt.chat",
      "https://cdn.stoatusercontent.com",
      "https://autumn.stoatusercontent.com",
      "https://cdn.revolt.chat",
    ];

    // prevent navigation out of build URL origin (but allow API/CDN)
    contents.on("will-navigate", (event, navigationUrl) => {
      const url = new URL(navigationUrl);

      // Allow stoat:// protocol (local electron-serve)
      if (url.protocol === "stoat:") {
        return;
      }

      // Allow same origin (for local dev)
      if (url.origin === BUILD_URL.origin) {
        return;
      }

      // Allow known API/CDN origins
      if (allowedOrigins.some(origin => url.origin === origin || url.href.startsWith(origin))) {
        return;
      }

      // Block everything else
      console.log("[Window] Blocking navigation to:", navigationUrl);
      event.preventDefault();
    });

    // handle links externally
    contents.setWindowOpenHandler(({ url }) => {
      if (
        url.startsWith("http:") ||
        url.startsWith("https:") ||
        url.startsWith("mailto:")
      ) {
        setImmediate(() => {
          shell.openExternal(url);
        });
      }

      return { action: "deny" };
    });
  });
} else {
  app.quit();
}
