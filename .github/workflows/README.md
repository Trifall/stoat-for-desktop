# GitHub Actions - Desktop Build Workflow

This GitHub Actions workflow automatically builds the Stoat Desktop application for Linux and Windows and creates releases.

**Location**: `stoat-for-desktop/.github/workflows/build-desktop.yml`

## How It Works

Since the desktop app (`stoat-for-desktop`) and web client (`client`) are in separate repositories, the workflow:

1. Checks out the `stoat-for-desktop` repo (current repo)
2. Checks out the `stoat-for-web` repo (web client) into the `client/` subdirectory
3. Builds the web client from the `client/` directory
4. Copies the built assets to `web-dist/` in the desktop repo
5. Builds the Electron app
6. Creates distributable ZIP files

## Triggering Builds

### Automatic (Recommended)
Push a tag starting with `v`:
```bash
git tag v1.2.0
git push origin v1.2.0
```

The workflow will automatically:
1. Build for Linux and Windows
2. Create a GitHub Release
3. Attach the ZIP files to the release

### Manual
Go to **Actions** → **Build Desktop Release** → **Run workflow**
Enter a version tag (e.g., `v1.2.0`) and run.

## What Gets Built

The workflow replicates `build-standalone.sh`:
1. Installs dependencies with mise (in client/)
2. Builds the web client
3. Copies audio assets
4. Processes translations
5. Builds the Electron app
6. Creates distributable ZIP files

## Platform Support

### Linux
- **Target**: `linux-x64`
- **Output**: `Stoat-linux-x64-*.zip`
- **Requirements**: X11 or XWayland, libx11, libxtst, libxt, libxinerama
- **Runner**: `ubuntu-latest`

### Windows
- **Target**: `win32-x64`
- **Output**: `Stoat-win32-x64-*.zip`
- **Runner**: `windows-latest`

### macOS (Not Implemented)
Currently not supported due to iohook keyboard issues on macOS.

## Workflow Details

### Repository Structure During Build

```
/workspace/
├── client/           # Checked out from anomalyco/stoat
│   ├── packages/
│   │   └── client/
│   │       └── dist/    # Built web assets
│   └── .mise/
├── web-dist/         # Copied from client/packages/client/dist
├── src/
├── package.json
└── forge.config.ts
```

### Jobs

#### `build-linux`
Runs on Ubuntu and builds the Linux version:
- Uses mise for task management
- Builds with Electron Forge
- Creates ZIP via `@electron-forge/maker-zip`
- Uploads artifact
- Creates release if triggered by tag

#### `build-windows`
Runs on Windows and builds the Windows version:
- Downloads Windows iohook binaries automatically (via forge.config.ts)
- Same build process as Linux
- Creates Windows ZIP

### Caching

The workflow caches:
- pnpm store (dependencies)
- mise tools

This speeds up subsequent builds significantly.

### Artifacts

Each build produces artifacts that are:
1. Uploaded as workflow artifacts (30-day retention)
2. Attached to GitHub Releases (permanent)

## Configuration

### Required Secrets
- `GITHUB_TOKEN` - Automatically provided by GitHub Actions

### Required Files
Make sure these files exist:

**In stoat-for-desktop repo:**
- `package.json` - Desktop dependencies
- `forge.config.ts` - Electron Forge config
- `.github/workflows/build-desktop.yml` - This workflow

**In stoat-for-web repo (checked out to client/):**
- `.mise/config.toml` - Mise configuration
- `.mise/tasks/*` - Build tasks

### Repository Configuration

The workflow uses the web client at `Trifall/stoat-for-web`. If you fork the client repo, update this line in the workflow:

```yaml
- name: Checkout client repo
  uses: actions/checkout@v4
  with:
    repository: YOUR_USERNAME/YOUR_FORK  # Change this if you forked
    path: client
    fetch-depth: 0
```

## Troubleshooting

### Build Fails: "mise not found"
The `jdx/mise-action` should install mise automatically. If it fails, check that your mise config is valid in `client/.mise/config.toml`.

### Build Fails: "pnpm not found"
The `pnpm/action-setup` installs pnpm. Make sure your `packageManager` field in `package.json` is set correctly.

### ZIP Not Found
Check the `forge.config.ts` to ensure the maker-zip output path matches what the workflow expects:
- Linux: `out/make/zip/linux/x64/*.zip`
- Windows: `out/make/zip/win32/x64/*.zip`

### Audio Assets Missing
Ensure `client/packages/client/scripts/assets_fallback/audio/` exists with all 7 .wav files in the stoat-for-web repo.

### Client Repo Not Found
Make sure the `repository` field in the checkout step matches your actual GitHub username/repo name for the web client.

## Customization

### Add macOS Support
If macOS support is added in the future:

```yaml
  build-macos:
    runs-on: macos-latest
    steps:
      # Similar to Linux build
      - name: Build desktop app
        run: pnpm make --platform=darwin
```

### Change Node.js Version
Edit the `node-version` in the workflow:
```yaml
- uses: actions/setup-node@v4
  with:
    node-version: '21'  # or '18', '22', etc.
```

### Add More Makers
To build other formats (deb, rpm, etc.), modify the maker command:
```yaml
run: |
  pnpm make --platform=linux --targets=@electron-forge/maker-zip,@electron-forge/maker-deb
```

Then update the find-zip step to handle multiple outputs.

## Local Testing

Before pushing, you can test the workflow locally with [act](https://github.com/nektos/act):

```bash
# Install act
brew install act

# Run the workflow locally (Linux only)
cd stoat-for-desktop
act -j build-linux
```

Note: `act` doesn't support Windows runners, so the Windows job must be tested on GitHub.

## Related Files

- `stoat-for-desktop/.github/workflows/build-desktop.yml` - This workflow
- `build-standalone.sh` - Local build script (same process)
- `stoat-for-desktop/forge.config.ts` - Build configuration
- `NotificationSounds.md` - Technical documentation

## Questions?

See the main project README or open an issue on GitHub.
