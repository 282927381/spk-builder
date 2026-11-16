# SPK Builder

**English** | [简体中文](README_zh_cn.md)

A **visual web console** for packaging / building Synology package installers (`.spk`).
It supports multiple languages and multiple architectures — a few clicks and you have a package — and works directly with an [tbc0309/sspks-imnks](https://github.com/tbc0309/sspks-imnks) package server for distribution.

## What it can do

| Capability | Description |
| --- | --- |
| Package `.spk` | Generates a complete `INFO` + `package.tgz` + `scripts/` + icons, in the standard layout |
| Multi-architecture | Tick `x86_64 / armv7 / arm64 / noarch` once and get one `.spk` per architecture |
| Multi-language builds | Go (native cross-compile), Docker (C/C++ etc.), local command (any language), prebuilt packaging |
| Visual UI | Web form for parameters + live build logs + artifact download |
| Zero dependencies to start | Packaging only uses the bundled Python standard library — nothing to install |

## Quick start

Double-click `run.bat`; it opens the browser at `http://127.0.0.1:8800`.

Manual start (any environment with Python 3):

```bash
python server.py
```

## Usage

1. Open `http://127.0.0.1:8800`.
2. The top navigation has five tabs:
   - **🚀 Build**: fill in package info, architectures and build method, then build;
   - **📥 Unpack**: import an existing `.spk`, inspect it, and auto-fill the build form for repackaging;
   - **📦 Batch**: import several `.spk` files at once, edit each independently, repackage them all;
   - **📖 Help**: built-in usage guide and FAQ;
   - **📜 Changelog**: version history (read automatically from `更新日志.txt`).
3. Fill in the **package info** (name, version, description, maintainer, …).
4. Tick the **target architectures** (multi-select).
5. Choose a **build method** and fill in its parameters (see below).
6. Click **🚀 Start packaging / building**, watch the live log, then download the `.spk`.

All artifacts are written to `output/<name>-<version>/`.

## Five build methods

### ① Prebuilt / plain scripts (default, no toolchain required)

Put the files you want to install into a directory whose layout matches the installed `target/`:

```
mypkg/
├── bin/
│   └── myapp          # executable (packed with mode 0755)
├── ui/                # optional: DSM UI files
├── conf/              # optional: configuration files
├── scripts/           # optional: custom lifecycle scripts (auto-generated if missing)
├── PACKAGE_ICON.PNG       # optional: icon; a placeholder is generated if missing
└── PACKAGE_ICON_256.PNG
```

- **Single architecture**: point "source directory" at the directory itself.
- **Multiple architectures**: add per-architecture subdirectories with their own binaries:
  ```
  mypkg/
  ├── x86_64/bin/myapp
  ├── armv7/bin/myapp
  └── arm64/bin/myapp
  ```

### ② Go (native cross-compilation)

Requires [Go](https://go.dev/dl/) installed locally (Windows installer, or unzip the portable build and add it to `PATH`).
Builds with `CGO_ENABLED=0`, producing **static binaries** — the friendliest option for Synology.

- Source directory = the root of your Go module
- Main package path = e.g. `./cmd/server` or `.`
- Each architecture is compiled with `GOOS=linux GOARCH=...`

### ③ Docker (any compilation: C/C++, …)

Requires [Docker Desktop](https://www.docker.com/products/docker-desktop/) with Linux containers enabled.
The source is mounted at `/src` and the output directory at `/out`; your command must write the final executable to **`$OUT_BIN`** (i.e. `/out/bin/<binary_name>`).

Example (compiling a static C program):

- Docker image: `debian:bookworm-slim`
- Build command: `apt-get update && apt-get install -y gcc && gcc -static -o $OUT_BIN main.c`

> For the native Synology toolchain you can use the official `synocommunity/spksrc` image (heavyweight; meant for cases that really need Synology's libc).

### ④ Local command (any language)

Runs one command on this machine; it must write the final executable to `%OUT_BIN%` (Windows) / `$OUT_BIN` (Linux).
The `ARCH` environment variable tells you which architecture is being built. Good when you already have a build script.

### ⑤ spksrc (SynoCommunity cross-compilation)

Uses the official [spksrc](https://github.com/SynoCommunity/spksrc) framework to build native packages (C/C++, Rust, Go, …) for Synology, with toolchains for every model / DSM version.
**Prerequisite**: a Linux distribution installed in WSL2 with the spksrc repository cloned.

1. In an elevated PowerShell install WSL2: `wsl --install -d Ubuntu` (a reboot may be required the first time);
2. In Ubuntu, clone the repository: `git clone https://github.com/SynoCommunity/spksrc`;
3. On the page choose build method **spksrc** and fill in:
   - WSL distribution: `Ubuntu` by default
   - DSM version: e.g. `7.2`
   - spksrc directory: e.g. `~/spksrc`
   - Package name: the directory under `spk/`, e.g. `transmission`, `ffmpeg`
4. Tick the target architectures (mapped automatically: x86_64→x64, arm64→aarch64, armv7→armv7) and build.

spksrc produces the artifacts itself and copies them back to `output/` on Windows, ready to download.

> The official spksrc Docker setup does not work on Windows (symlink/permission issues), which is why this uses a native WSL2 build instead.

## Batch unpack / batch edit / batch build

The **📦 Batch** tab handles **many `.spk` files at once**:

1. **Batch unpack**: select several local `.spk` files, or paste one local path per line, then click "Batch unpack";
2. **Independent configuration**: each package gets its own editable card — package ID, version, display name, description, maintainer, architectures, run identity, source directory, and so on;
3. **Batch edit a single field**: the "⚡ Batch edit" toolbar above the cards lets you pick one field (version / maintainer / description / architecture / run identity, …), enter a value once and apply it to every package;
4. **Batch build**: tick the packages to build (or select all) and click "🚀 Batch build" — they are packaged one by one, and a single failure does not affect the others;
5. When finished, a summary shows success/failure and download links for every package, with **multi-select batch download**; each `.spk` is pre-ticked according to the architectures the mirror supports, while unsupported ones (e.g. `armv7`) stay unticked unless you change them;
6. Batch download zips the selected packages into folders named `<app>-dsm7/`, so after extracting you can drop them straight into an sspks repository.

> The batch flow repackages with "Prebuilt / plain scripts" by default (reusing the unpacked directory), which is ideal for bumping version, description or maintainer across a set of existing `.spk` files.

## Import a `.spk`, unpack it, repackage it

The **📥 Unpack .spk** entry at the top supports two ways:

- upload a local `.spk` file; or
- enter a local path (e.g. `C:\path\to\foo.spk`).

After clicking "Unpack" it automatically:

1. extracts the package into `output/_imported/<package>/`:
   - outer files (`INFO`, `package.tgz`, `scripts/`, icons, `conf/`, …) at the root of that directory;
   - the inner `package.tgz` into the `target/` subdirectory;
2. **fills the parsed `INFO` metadata (name / version / description / maintainer, …) into the "package info" form**;
3. switches the build method to "Prebuilt" and points "source directory" at the unpacked directory.

Just adjust the form (version, description, …) and click "Build" to **repackage** a new `.spk`; outer resources such as `scripts/`, icons, `conf/` and `WIZARD_UIFILES` are preserved as-is.

> For packages with a web UI, the `adminport` / `adminprotocol` / `adminurl` / `dsmuidir` / `dsmappname` fields are written back into `INFO` when repackaging, so the "Open" button still appears in Synology Package Center.

## Working with an sspks package server

Drop the generated `.spk` into the `packages` directory of your [sspks](https://github.com/tbc0309/sspks-imnks) server, then add the server URL under **Package Center → Package Sources** on the NAS to install it.

> When manually installing an unsigned third-party package on DSM 7, set the trust level in Package Center settings to **Any publisher**.

### Architecture naming and distribution

Every `.spk` lists **all model codes of the architecture family** in the `INFO` `arch` field (family code first, then specific model codes), so Package Center matches the package to the exact model:

| Architecture | `arch` field content (excerpt) |
| --- | --- |
| `x86_64` | `x86_64 bromolow cedarview avoton braswell broadwell ... geminilake denverton v1000 v1000nk r1000 r1000nk epyc7002 epyc7003 icelaked grantley purley kvmx64 dockerx64` |
| `arm64` | `armv8 arm64 aarch64 rtd1296 rtd1619b armada37xx armada8040 rtd1293 rtd1619` |
| `armv7` | `armv7 armada370 armada375 armada38x armadaxp alpine alpine4k monaco comcerto2k hi3535` |
| `noarch` | `noarch` (works on every model) |

> Note that `arm64` writes `armv8` / `arm64` / `aarch64` at the same time: the sspks-imnks model family is called `armv8`, and writing only `arm64` makes Synology fail to match ARM models. File names still follow `<name>_<arch>-<version>.spk`.

## Directory layout

```
spk-builder/
├── server.py      # backend service (HTTP + build jobs + artifact downloads)
├── spkpack.py     # packaging core (generates INFO / scripts / package.tgz / .spk)
├── builders.py    # build providers and toolchain detection
├── web/           # frontend (index.html / app.js / style.css)
├── run.bat        # one-click start (Windows)
├── 更新日志.txt    # changelog, read by the "Changelog" tab
├── output/        # build artifacts (created at runtime)
├── release/       # ready-to-run release packages
└── tools/         # (optional) portable toolchains, e.g. Go
```

## FAQ

- **Go is not installed**: a red badge shows at the top of the UI. Install Go and restart the tool.
- **Docker is not installed**: only the "Docker" build method is affected; packaging and the Go / local-command methods still work.
- **Run identity root / non-root**: chosen under "④ Run configuration" on the build page. "Non-root" generates `conf/privilege` (recommended for DSM 7); "root" runs with the highest privileges.
- **Download paths**: links point to relative paths under `output/`, and file names follow `<name>_<arch>-<version>.spk` (e.g. `myapp_x86_64-1.0.0.spk`, `myapp_noarch-1.0.0.spk`).
