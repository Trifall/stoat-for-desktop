import { type JSONSchema } from "json-schema-typed";

import { ipcMain } from "electron";
import Store from "electron-store";

import { destroyDiscordRpc, initDiscordRpc } from "./discordRpc";
import { cleanupPushToTalk, registerPushToTalkHotkey } from "./pushToTalk";
import { mainWindow } from "./window";

const schema = {
  firstLaunch: {
    type: "boolean",
  } as JSONSchema.Boolean,
  customFrame: {
    type: "boolean",
  } as JSONSchema.Boolean,
  minimiseToTray: {
    type: "boolean",
  } as JSONSchema.Boolean,
  spellchecker: {
    type: "boolean",
  } as JSONSchema.Boolean,
  hardwareAcceleration: {
    type: "boolean",
  } as JSONSchema.Boolean,
  discordRpc: {
    type: "boolean",
  } as JSONSchema.Boolean,
  pushToTalk: {
    type: "boolean",
  } as JSONSchema.Boolean,
  pushToTalkKeybind: {
    type: "string",
  } as JSONSchema.String,
  pushToTalkMode: {
    type: "string",
    enum: ["hold", "toggle"],
  } as JSONSchema.String,
  pushToTalkReleaseDelay: {
    type: "number",
    minimum: 0,
    maximum: 5000,
  } as JSONSchema.Number,
  windowState: {
    type: "object",
    properties: {
      x: {
        type: "number",
      } as JSONSchema.Number,
      y: {
        type: "number",
      } as JSONSchema.Number,
      width: {
        type: "number",
      } as JSONSchema.Number,
      height: {
        type: "number",
      } as JSONSchema.Number,
      isMaximised: {
        type: "boolean",
      } as JSONSchema.Boolean,
    },
  } as JSONSchema.Object,
};

const store = new Store({
  schema,
  defaults: {
    firstLaunch: true,
    customFrame: true,
    minimiseToTray: true,
    spellchecker: true,
    hardwareAcceleration: true,
    discordRpc: true,
    pushToTalk: false,
    pushToTalkKeybind: "Shift+Space",
    pushToTalkMode: "hold",
    pushToTalkReleaseDelay: 0,
    windowState: {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      isMaximised: false,
    },
  } as DesktopConfig,
});

/**
 * Shim for `electron-store` because typings are broken
 */
class Config {
  sync() {
    mainWindow.webContents.send("config", {
      firstLaunch: this.firstLaunch,
      customFrame: this.customFrame,
      minimiseToTray: this.minimiseToTray,
      spellchecker: this.spellchecker,
      hardwareAcceleration: this.hardwareAcceleration,
      discordRpc: this.discordRpc,
      pushToTalk: this.pushToTalk,
      pushToTalkKeybind: this.pushToTalkKeybind,
      pushToTalkMode: this.pushToTalkMode,
      pushToTalkReleaseDelay: this.pushToTalkReleaseDelay,
      windowState: this.windowState,
    });
  }

  get firstLaunch() {
    return (store as never as { get(k: string): boolean }).get("firstLaunch");
  }

  set firstLaunch(value: boolean) {
    (store as never as { set(k: string, value: boolean): void }).set(
      "firstLaunch",
      value,
    );

    this.sync();
  }

  get customFrame() {
    return (store as never as { get(k: string): boolean }).get("customFrame");
  }

  set customFrame(value: boolean) {
    (store as never as { set(k: string, value: boolean): void }).set(
      "customFrame",
      value,
    );

    this.sync();
  }

  get minimiseToTray() {
    return (store as never as { get(k: string): boolean }).get(
      "minimiseToTray",
    );
  }

  set minimiseToTray(value: boolean) {
    (store as never as { set(k: string, value: boolean): void }).set(
      "minimiseToTray",
      value,
    );

    this.sync();
  }

  get spellchecker() {
    return (store as never as { get(k: string): boolean }).get("spellchecker");
  }

  set spellchecker(value: boolean) {
    mainWindow.webContents.session.setSpellCheckerEnabled(value);

    (store as never as { set(k: string, value: boolean): void }).set(
      "spellchecker",
      value,
    );

    this.sync();
  }

  get hardwareAcceleration() {
    return (store as never as { get(k: string): boolean }).get(
      "hardwareAcceleration",
    );
  }

  set hardwareAcceleration(value: boolean) {
    (store as never as { set(k: string, value: boolean): void }).set(
      "hardwareAcceleration",
      value,
    );

    this.sync();
  }

  get discordRpc() {
    return (store as never as { get(k: string): boolean }).get("discordRpc");
  }

  set discordRpc(value: boolean) {
    if (value) {
      initDiscordRpc();
    } else {
      destroyDiscordRpc();
    }

    (store as never as { set(k: string, value: boolean): void }).set(
      "discordRpc",
      value,
    );

    this.sync();
  }

  get pushToTalk() {
    return (store as never as { get(k: string): boolean }).get("pushToTalk");
  }

  set pushToTalk(value: boolean) {
    (store as never as { set(k: string, value: boolean): void }).set(
      "pushToTalk",
      value,
    );

    if (value) {
      registerPushToTalkHotkey().catch((err) => {
        console.error("[Config] Failed to register PTT hotkey:", err);
      });
    } else {
      cleanupPushToTalk();
    }

    this.sync();
  }

  get pushToTalkKeybind() {
    return (store as never as { get(k: string): string }).get(
      "pushToTalkKeybind",
    );
  }

  set pushToTalkKeybind(value: string) {
    (store as never as { set(k: string, value: string): void }).set(
      "pushToTalkKeybind",
      value,
    );

    if (this.pushToTalk) {
      registerPushToTalkHotkey().catch((err) => {
        console.error("[Config] Failed to re-register PTT hotkey:", err);
      });
    }

    this.sync();
  }

  get pushToTalkMode() {
    return (store as never as { get(k: string): "hold" | "toggle" }).get(
      "pushToTalkMode",
    );
  }

  set pushToTalkMode(value: "hold" | "toggle") {
    (store as never as { set(k: string, value: "hold" | "toggle"): void }).set(
      "pushToTalkMode",
      value,
    );

    if (this.pushToTalk) {
      registerPushToTalkHotkey().catch((err) => {
        console.error("[Config] Failed to re-register PTT hotkey:", err);
      });
    }

    this.sync();
  }

  get pushToTalkReleaseDelay() {
    return (store as never as { get(k: string): number }).get(
      "pushToTalkReleaseDelay",
    );
  }

  set pushToTalkReleaseDelay(value: number) {
    (store as never as { set(k: string, value: number): void }).set(
      "pushToTalkReleaseDelay",
      value,
    );

    this.sync();
  }

  get windowState() {
    return (
      store as never as { get(k: string): DesktopConfig["windowState"] }
    ).get("windowState");
  }

  set windowState(value: DesktopConfig["windowState"]) {
    (
      store as never as {
        set(k: string, value: DesktopConfig["windowState"]): void;
      }
    ).set("windowState", value);

    this.sync();
  }
}

export const config = new Config();

ipcMain.on("config", (_, newConfig: Partial<DesktopConfig>) => {
  console.info("Received new configuration", newConfig);
  Object.entries(newConfig).forEach(
    ([key, value]) => (config[key as keyof DesktopConfig] = value as never),
  );
});
