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
import * as https from "node:https";
import * as path from "node:path";
import * as tar from "tar";

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
        runtimeVersion: "24.08",
        icon: `${ASSET_DIR}/icon.png`,
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
          "--socket=x11",
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
      unpack: "**/node_modules/@tkomde/iohook/**/*",
    },
    name: STRINGS.name,
    executableName: STRINGS.execName,
    icon: `${ASSET_DIR}/icon`,
    extraResource: [
      // Include web-dist for bundled web client
      "web-dist",
    ],
  },
  rebuildConfig: {},
  makers,
  hooks: {
    prePackage: async (_forgeConfig, platform) => {
      // download Windows iohook binaries when building for Windows
      if (platform !== "win32") {
        console.log(`[prePackage] Building for ${platform}, skipping Windows iohook download`);
        return;
      }
      
      console.log("[prePackage] Building for Windows, downloading iohook binaries...");
      
      const iohookVersion = "1.1.7";
      const electronAbi = "139"; // electron 38.x
      const arch = "x64";
      
      const url = `https://registry.npmjs.org/@tkomde/iohook/-/iohook-${iohookVersion}-electron-v${electronAbi}-win32-${arch}.tar.gz`;
      const downloadPath = path.join(__dirname, ".vite", "iohook-win32.tar.gz");
      const extractPath = path.join(__dirname, "node_modules", "@tkomde", "iohook", "builds", `electron-v${electronAbi}-win32-${arch}`);
      
      fs.mkdirSync(path.dirname(downloadPath), { recursive: true });
      
      console.log(`[prePackage] Downloading from: ${url}`);
      await new Promise<void>((resolve, reject) => {
        const file = fs.createWriteStream(downloadPath);
        https.get(url, (response) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            const redirectUrl = response.headers.location;
            if (!redirectUrl) {
              reject(new Error("Redirect location not found"));
              return;
            }
            https.get(redirectUrl, (redirectResponse) => {
              redirectResponse.pipe(file);
              file.on("finish", () => {
                file.close();
                console.log("[prePackage] Download complete");
                resolve();
              });
            }).on("error", reject);
          } else {
            response.pipe(file);
            file.on("finish", () => {
              file.close();
              console.log("[prePackage] Download complete");
              resolve();
            });
          }
        }).on("error", (err) => {
          fs.unlink(downloadPath, () => { /* ignore unlink errors */ });
          reject(err);
        });
      });
      
      console.log("[prePackage] Extracting binaries...");
      fs.mkdirSync(extractPath, { recursive: true });
      await tar.x({
        file: downloadPath,
        cwd: extractPath,
        strip: 1,
      });
      
      console.log(`[prePackage] Windows iohook binaries extracted to: ${extractPath}`);
      
      fs.unlinkSync(downloadPath);
    },
    postPackage: async (_forgeConfig, options) => {
      // copy native iohook module to the packaged app
      const sourceDir = path.join(__dirname, "node_modules", "@tkomde", "iohook");
      const targetDir = path.join(
        options.outputPaths[0],
        "resources",
        "app.asar.unpacked",
        "node_modules",
        "@tkomde",
        "iohook"
      );
      
      if (fs.existsSync(sourceDir)) {
        console.log("Copying iohook native module to:", targetDir);
        fs.mkdirSync(targetDir, { recursive: true });
        
        // copy the entire module
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
        
        copyRecursive(sourceDir, targetDir);
        console.log("✓ iohook native module copied successfully");
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
