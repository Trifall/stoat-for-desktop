import { MakerAppX } from "@electron-forge/maker-appx";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerFlatpak } from "@electron-forge/maker-flatpak";
import { MakerFlatpakOptionsConfig } from "@electron-forge/maker-flatpak/dist/Config";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { PublisherGithub } from "@electron-forge/publisher-github";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import * as fs from "node:fs";
import * as path from "node:path";

// import { globSync } from "node:fs";

const STRINGS = {
  author: "Revolt Platforms LTD",
  name: "Stoat",
  execName: "stoat-desktop",
  description: "Open source user-first chat platform.",
};

const ASSET_DIR = "assets/desktop";

/**
 * Build targets for the desktop app
 */
const makers: ForgeConfig["makers"] = [
  new MakerSquirrel({
    name: STRINGS.name,
    authors: STRINGS.author,
    // todo: hoist this
    iconUrl: `https://stoat.chat/app/assets/icon-DUSNE-Pb.ico`,
    // todo: loadingGif
    setupIcon: `${ASSET_DIR}/icon.ico`,
    description: STRINGS.description,
    exe: `${STRINGS.execName}.exe`,
    setupExe: `${STRINGS.execName}-setup.exe`,
    copyright: "Copyright (C) 2025 Revolt Platforms LTD",
  }),
  new MakerZIP({}),
];

// skip these makers in CI/CD
if (!process.env.PLATFORM) {
  makers.push(
    // must be manually built (freezes CI process)
    // not much use in being published anyhow
    new MakerAppX({
      certPass: "",
      packageExecutable: `app\\${STRINGS.execName}.exe`,
      publisher: "CN=B040CC7E-0016-4AF5-957F-F8977A6CFA3B",
    }),
    // flatpak publishing should occur through flathub repos.
    // this is just for testing purposes
    new MakerFlatpak({
      options: {
        id: "chat.stoat.stoat-desktop",
        description: STRINGS.description,
        productName: STRINGS.name,
        productDescription: STRINGS.description,
        runtimeVersion: "25.08",
        icon: {
          "16x16": `${ASSET_DIR}/hicolor/16x16.png`,
          "32x32": `${ASSET_DIR}/hicolor/32x32.png`,
          "64x64": `${ASSET_DIR}/hicolor/64x64.png`,
          "128x128": `${ASSET_DIR}/hicolor/128x128.png`,
          "256x256": `${ASSET_DIR}/hicolor/256x256.png`,
          "512x512": `${ASSET_DIR}/hicolor/512x512.png`,
        } as unknown,
        categories: ["Network"],
        modules: [
          // use the latest zypak -- Electron sandboxing for Flatpak
          {
            name: "zypak",
            sources: [
              {
                type: "git",
                url: "https://github.com/refi64/zypak",
                tag: "v2025.09",
              },
            ],
          },
        ],
        finishArgs: [
          // default arguments found by running
          // DEBUG=electron-installer-flatpak* pnpm make
          "--socket=fallback-x11",
          "--share=ipc",
          "--device=dri",
          "--socket=pulseaudio",
          "--filesystem=home",
          "--env=TMPDIR=/var/tmp",
          "--share=network",
          "--talk-name=org.freedesktop.Notifications",
          // add Unity talk name for badges
          "--talk-name=com.canonical.Unity",
        ],
        // files: [
        //   // is this necessary?
        //   // https://stackoverflow.com/q/79745700
        //   ...[16, 32, 64, 128, 256, 512].map(
        //     (size) =>
        //       [
        //         `assets/desktop/hicolor/${size}x${size}.png`,
        //         `/app/share/icons/hicolor/${size}x${size}/apps/chat.stoat.stoat-desktop.png`,
        //       ] as [string, string],
        //   ),
        //   [
        //     `assets/desktop/icon.svg`,
        //     `/app/share/icons/hicolor/scalable/apps/chat.stoat.stoat-desktop.svg`,
        //   ] as [string, string],
        // ],
        files: [],
      } as MakerFlatpakOptionsConfig,
      /* as Omit<
        MakerFlatpakOptionsConfig,
        "files"
      > */
    }),
    // testing purposes
    new MakerDeb({
      options: {
        name: "stoat-desktop",
        productName: STRINGS.name,
        description: STRINGS.description,
        productDescription: STRINGS.description,
        categories: ["Network"],
        icon: `${ASSET_DIR}/icon.png`,
      },
    }),
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: "**/node_modules/keyspy/**/*",
    },
    name: STRINGS.name,
    executableName: STRINGS.execName,
    icon: `${ASSET_DIR}/icon`,
    extraResource: [
      "web-dist",
    ],
  },
  rebuildConfig: {},
  makers,
  hooks: {
    prePackage: async (_forgeConfig, platform) => {
      const keyspyPath = path.join(__dirname, "node_modules", "keyspy");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { execSync } = require("child_process");
      
      if (platform === "win32") {
        console.log("[prePackage] Building for Windows, compiling keyspy WinKeyServer...");
        
        const winServerSrc = path.join(keyspyPath, "native", "WinKeyServer", "main.cpp");
        const buildDir = path.join(keyspyPath, "build");
        const winServerBin = path.join(buildDir, "WinKeyServer.exe");
        
        fs.mkdirSync(buildDir, { recursive: true });
        
        try {
          // On Windows, compile natively. On Linux cross-compiling to Windows, use mingw.
          if (process.platform === "win32") {
            execSync(
              `c++ "${winServerSrc}" -o "${winServerBin}" -static`,
              { stdio: "inherit" }
            );
          } else {
            execSync(
              `x86_64-w64-mingw32-g++ -static -static-libgcc -static-libstdc++ -o "${winServerBin}" "${winServerSrc}" -luser32 -lkernel32`,
              { stdio: "inherit" }
            );
          }
          console.log("[prePackage] WinKeyServer.exe compiled successfully");
        } catch (err) {
          console.warn("[prePackage] Failed to compile WinKeyServer, Windows PTT may not work");
          console.warn("[prePackage] Error:", err);
        }
      } else if (platform === "linux") {
        console.log("[prePackage] Building for Linux, compiling keyspy X11KeyServer...");
        
        const x11ServerSrc = path.join(keyspyPath, "native", "X11KeyServer", "main.cpp");
        const buildDir = path.join(keyspyPath, "build");
        const x11ServerBin = path.join(buildDir, "X11KeyServer");
        
        fs.mkdirSync(buildDir, { recursive: true });
        
        try {
          execSync(
            `c++ "${x11ServerSrc}" -o "${x11ServerBin}" -lX11 -lXi -static-libgcc -static-libstdc++`,
            { stdio: "inherit" }
          );
          execSync(`strip "${x11ServerBin}"`);
          console.log("[prePackage] X11KeyServer compiled successfully");
        } catch (err) {
          console.warn("[prePackage] Failed to compile X11KeyServer, Linux PTT may not work");
          console.warn("[prePackage] Error:", err);
        }
      } else {
        console.log(`[prePackage] Building for ${platform}, keyspy uses prebuilt runtime binaries`);
      }
    },
    postPackage: async (_forgeConfig, options) => {
      const copyRecursive = (src: string, dest: string) => {
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
          const srcPath = path.join(src, entry.name);
          const destPath = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            fs.mkdirSync(destPath, { recursive: true });
            copyRecursive(srcPath, destPath);
          } else {
            fs.copyFileSync(srcPath, destPath);
          }
        }
      };

      const unpackedNodeModules = path.join(
        options.outputPaths[0],
        "resources",
        "app.asar.unpacked",
        "node_modules",
      );

      const keyspySource = path.join(__dirname, "node_modules", "keyspy");
      const keyspyTarget = path.join(unpackedNodeModules, "keyspy");

      if (fs.existsSync(keyspySource)) {
        console.log("Copying keyspy to:", keyspyTarget);
        fs.mkdirSync(keyspyTarget, { recursive: true });
        copyRecursive(keyspySource, keyspyTarget);
        console.log("✓ keyspy copied successfully");
      }

      const sudoPromptSource = path.join(__dirname, "node_modules", "@expo", "sudo-prompt");
      const sudoPromptTarget = path.join(unpackedNodeModules, "@expo", "sudo-prompt");
      
      if (fs.existsSync(sudoPromptSource) && !fs.existsSync(sudoPromptTarget)) {
        console.log("Copying @expo/sudo-prompt to:", sudoPromptTarget);
        fs.mkdirSync(sudoPromptTarget, { recursive: true });
        copyRecursive(sudoPromptSource, sudoPromptTarget);
        console.log("✓ @expo/sudo-prompt copied successfully");
      }
    },
  },
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  publishers: [
    new PublisherGithub({
      repository: {
        owner: "stoatchat",
        name: "for-desktop",
      },
    }),
  ],
};

export default config;
