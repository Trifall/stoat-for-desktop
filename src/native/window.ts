import { join } from "node:path";

import {
  BrowserWindow,
  Menu,
  MenuItem,
  app,
  ipcMain,
  nativeImage,
  net,
  protocol,
} from "electron";

import windowIconAsset from "../../assets/desktop/icon.png?asset";

import { config } from "./config";
import { updateTrayMenu } from "./tray";

// global reference to main window
export let mainWindow: BrowserWindow;

// currently in-use build
export let BUILD_URL: URL;

// Local web assets directory
let localWebDir: string | null = null;

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

export function initBuildUrl() {
  const forceServer = app.commandLine.getSwitchValue("force-server");

  // Try to find local web assets in multiple locations
  const fs = require("fs");
  const path = require("path");

  // Possible locations for web-dist
  const possiblePaths = [
    // In resources directory (packaged app)
    path.join(process.resourcesPath, "web-dist"),
    // Relative to app path (development)
    path.join(app.getAppPath(), "..", "web-dist"),
    // Next to the executable
    path.join(path.dirname(process.execPath), "web-dist"),
  ];

  for (const testPath of possiblePaths) {
    const indexPath = path.join(testPath, "index.html");
    if (fs.existsSync(indexPath)) {
      localWebDir = testPath;
      console.log("[Window] Found local web assets at:", testPath);
      break;
    }
  }

  if (!forceServer && localWebDir) {
    // Setup protocol handler for local files
    setupLocalProtocol();
    BUILD_URL = new URL("stoat://-/index.html");
    console.log(
      "[Window] Loading from local web assets via custom protocol:",
      localWebDir,
    );
  } else {
    BUILD_URL = new URL(
      forceServer ||
        /*MAIN_WINDOW_VITE_DEV_SERVER_URL ??*/ "https://beta.revolt.chat",
    );
    console.log("[Window] Loading from remote URL:", BUILD_URL.toString());
    if (forceServer) {
      console.log("[Window] (forced server via --force-server flag)");
    } else if (!localWebDir) {
      console.log("[Window] (local web assets not found)");
    }
  }
}

function setupLocalProtocol() {
  const fs = require("fs");

  // Handle stoat:// protocol
  protocol.handle("stoat", (request) => {
    const url = new URL(request.url);
    let pathname = url.pathname;

    // Default to index.html for root
    if (!pathname || pathname === "/" || pathname === "-/") {
      pathname = "/index.html";
    }

    // Remove leading dash if present (stoat://-/path -> /path)
    if (pathname.startsWith("/-/")) {
      pathname = pathname.slice(2);
    }

    if (!localWebDir) {
      throw new Error("Local web assets not found");
    }

    // Construct full file path
    const filePath = join(localWebDir, pathname);

    // Security check: ensure path is within localWebDir
    if (!filePath.startsWith(localWebDir)) {
      console.error("[Protocol] Blocked access outside web-dist:", pathname);
      return new Response("Forbidden", { status: 403 });
    }

    // SPA fallback: if the file doesn't exist, serve index.html so
    // client-side routing can handle the path (e.g. /server/.../channel/...)
    if (!fs.existsSync(filePath)) {
      return net.fetch("file://" + join(localWebDir, "index.html"));
    }

    // Serve the file
    return net.fetch("file://" + filePath);
  });
}

// internal window state
let shouldQuit = false;

// load the window icon
const windowIcon = nativeImage.createFromDataURL(windowIconAsset);

// windowIcon.setTemplateImage(true);

/**
 * Create the main application window
 */
export function createMainWindow() {
  // (CLI arg --hidden or config)
  const startHidden =
    app.commandLine.hasSwitch("hidden") || config.startMinimisedToTray;

  // create the window
  mainWindow = new BrowserWindow({
    minWidth: 300,
    minHeight: 300,
    width: 1280,
    height: 720,
    backgroundColor: "#191919",
    frame: !config.customFrame,
    icon: windowIcon,
    show: !startHidden,
    webPreferences: {
      // relative to `.vite/build`
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      // Disable webSecurity when loading from localhost (dev server) to avoid CSP/CORS issues
      // Keep it enabled for production (remote URLs)
      webSecurity: BUILD_URL.protocol === "https:",
    },
  });

  // hide the options
  mainWindow.setMenu(null);

  // restore last position if it was moved previously
  if (config.windowState.x > 0 || config.windowState.y > 0) {
    mainWindow.setPosition(
      config.windowState.x ?? 0,
      config.windowState.y ?? 0,
    );
  }

  // restore last size if it was resized previously
  if (config.windowState.width > 0 && config.windowState.height > 0) {
    mainWindow.setSize(
      config.windowState.width ?? 1280,
      config.windowState.height ?? 720,
    );
  }

  // maximise the window if it was maximised before
  if (config.windowState.isMaximised) {
    mainWindow.maximize();
  }

  // load the entrypoint
  mainWindow.loadURL(BUILD_URL.toString());

  // minimise window to tray
  mainWindow.on("close", (event) => {
    if (!shouldQuit && config.minimiseToTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // update tray menu when window is shown/hidden
  mainWindow.on("show", updateTrayMenu);
  mainWindow.on("hide", updateTrayMenu);

  // keep track of window state
  function generateState() {
    config.windowState = {
      x: mainWindow.getPosition()[0],
      y: mainWindow.getPosition()[1],
      width: mainWindow.getSize()[0],
      height: mainWindow.getSize()[1],
      isMaximised: mainWindow.isMaximized(),
    };
  }

  mainWindow.on("maximize", generateState);
  mainWindow.on("unmaximize", generateState);
  mainWindow.on("moved", generateState);
  mainWindow.on("resized", generateState);

  // Handle keyboard shortcuts (zoom + DevTools)
  mainWindow.webContents.on("before-input-event", (event, input) => {
    // Zoom in with Ctrl+= or Ctrl++
    if (input.control && (input.key === "=" || input.key === "+")) {
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(
        mainWindow.webContents.getZoomLevel() + 1,
      );
      return;
    }

    // Zoom out with Ctrl+-
    if (input.control && input.key === "-") {
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(
        mainWindow.webContents.getZoomLevel() - 1,
      );
      return;
    }

    // Reset zoom with Ctrl+0
    if (input.control && input.key === "0") {
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(0);
      return;
    }

    // Reload with F5 or Ctrl+R
    if (
      input.key === "F5" ||
      ((input.control || input.meta) && input.key.toLowerCase() === "r")
    ) {
      event.preventDefault();
      mainWindow.webContents.reload();
      return;
    }

    // Toggle DevTools with F12
    if (input.key === "F12" && !input.control && !input.shift && !input.alt) {
      event.preventDefault();
      mainWindow.webContents.toggleDevTools();
    }
  });

  // send the config
  mainWindow.webContents.on("did-finish-load", () => config.sync());

  // configure spellchecker context menu
  mainWindow.webContents.on("context-menu", (_, params) => {
    const menu = new Menu();

    // add all suggestions
    for (const suggestion of params.dictionarySuggestions) {
      menu.append(
        new MenuItem({
          label: suggestion,
          click: () => mainWindow.webContents.replaceMisspelling(suggestion),
        }),
      );
    }

    // allow users to add the misspelled word to the dictionary
    if (params.misspelledWord) {
      menu.append(
        new MenuItem({
          label: "Add to dictionary",
          click: () =>
            mainWindow.webContents.session.addWordToSpellCheckerDictionary(
              params.misspelledWord,
            ),
        }),
      );
    }

    // add an option to toggle spellchecker
    menu.append(
      new MenuItem({
        label: "Toggle spellcheck",
        click() {
          config.spellchecker = !config.spellchecker;
        },
      }),
    );

    // show menu if we've generated enough entries
    if (menu.items.length > 0) {
      menu.popup();
    }
  });

  // push world events to the window
  ipcMain.on("minimise", () => mainWindow.minimize());
  ipcMain.on("maximise", () =>
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(),
  );
  ipcMain.on("close", () => mainWindow.close());

  // let i = 0;
  // setInterval(() => setBadgeCount((++i % 30) + 1), 1000);
}

/**
 * Quit the entire app
 */
export function quitApp() {
  shouldQuit = true;
  mainWindow.close();
}

// Ensure global app quit works properly
app.on("before-quit", () => {
  shouldQuit = true;
});
