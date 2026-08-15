# 🖥️ Deskapp

**English** · [简体中文](README.zh-CN.md)

> **A high-performance desktop shell for webapps — turn any webapp into a real desktop app.**

Once loaded, your webapp **feels like a desktop application, not a remote-controlled browser**:
every browser artifact is stripped away, while frame timing, VRAM usage and GPU state are
measured continuously and reported the moment they cross a threshold.

[![Electron](https://img.shields.io/badge/Electron-43.4.0-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v0.1.0-512BD4)]()

---

## ✨ Features

- **Feels like an app, not a browser** — no address bar, no tabs, no context menu. Window identity (title, icon, size, background) is declared by your webapp itself; no white flash, no URL in the title
- **Performance you can see** — a custom title bar shows live `FPS / MS / CPU / MEM`; `F12` opens a standalone Inspector with frame timing, VRAM accounting, draw calls, per-process resources and GPU state
- **Built for demanding apps** — GPU profiles (`balanced` / `max-perf` / `compat`), full frame rate even when unfocused, one-shot renderer teardown/rebuild (purge), and detection of silent fallback to software rendering
- **One protocol, three shapes** — a single `deskapp.json` manifest drives local projects, exported standalone apps, and purpose-built bundles through the same code path
- **Managed backend processes** — starts your dev server, polls until it's ready, and tears down the whole process tree on exit; an already-running service is reused, never killed
- **Secure by default** — local content is served over the `app://` scheme; manifest commands require native confirmation before their first run; CORS is opened only for origins the project declared
- **Built-in benchmark + CI gate** — `--smoke` quantifies frame rate, VRAM and long frames, then sets the exit code from your thresholds
- **Packaging for all three platforms** — macOS (`dmg`), Windows (`nsis`), Linux (`AppImage` / `deb`)

---

## 🖧 Platform support

All three platforms share one code path. The table below reflects **what has actually been
tested on real hardware**, not what is intended to work:

| | macOS | Windows | Linux |
|---|---|---|---|
| Loading · metrics · Inspector | ✅ verified | ✅ verified | ⚠️ not verified on hardware |
| Custom title bar (icon + live metrics + blur) | ✅ vibrancy | ✅ acrylic | ➖ always native title bar |
| Managed backend · process-tree teardown | ✅ process-group signals | ✅ `taskkill /T` | ⚠️ not verified on hardware |
| `--export` standalone app | ✅ verified | ✅ verified | ⚠️ not verified on hardware |
| Adopting the page icon as the app icon | ✅ rewrites `.icns` | ➖ runtime window icon only | ➖ runtime window icon only |
| Installers | dmg · zip | nsis · zip | AppImage · deb |

**Linux always uses the native title bar.** `titleBarStyle` has no effect there, so a custom bar
would stack underneath the native one and produce a double title bar. The cost is that
`FPS / MS / CPU / MEM` are not visible in the title bar — press `F12` and read them in the
Inspector instead. The metrics themselves are unaffected.

---

## 🚀 Quick start

```bash
pnpm install
pnpm build
```

> **Do not put the repository on an exFAT volume.** Two things break there:
> `pnpm install` fails with `ERR_PNPM_EISDIR` (the default layout needs symlinks, which exFAT
> does not support), and `pnpm dist:*` fails with
> `EPERM: rename 'win-unpacked.tmp' -> 'win-unpacked'`.
> Use NTFS / APFS / ext4. If you only need dependencies installed, `pnpm install --node-linker=hoisted`
> also works.

Load a local build output:

```bash
pnpm start -- /path/to/your/webapp/dist
```

Load a dev server:

```bash
pnpm start -- http://localhost:5173
```

Start with no argument to open the **project picker**:

```bash
pnpm start
```

---

## ⚙️ Configuring a project

Any directory containing an `index.html` just works. Add a `deskapp.json` to declare the window
and any services it needs:

```jsonc
{
    "version": 1,
    "name": "My Project",
    "entry": "index.html",
    "window": {
        "width": 1280, "height": 720,
        "minWidth": 720, "minHeight": 480,
        "background": "#0a0d12",
        "resizable": true
    },
    "runtime": {
        "profile": "balanced",
        "vramLimitMB": 400
    },
    "command": {
        "run": "npm run serve",                // long-running service, started for you
        "readyUrl": "http://127.0.0.1:5173/",  // page loads only once this responds
        "readyTimeoutMs": 90000
    },
    "hooks": {
        "startup": "pnpm install",             // runs before loading
        "shutdown": "./scripts/cleanup.sh"     // runs on exit
    }
}
```

Export a project as a double-clickable standalone app (without `--out` it lands in the project's
own `apps/<device>/`):

```bash
electron . --export <project-dir> --out <output-dir>
```

---

## 📚 Documentation

> The documents below are written in Chinese.

- [docs/PROTOCOL.md](docs/PROTOCOL.md) — the project protocol and API in full (complete manifest, the `window.deskapp` surface, CLI flags, packaging)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture and design decisions (accounting semantics, frame-rate statistics, performance profiles, security posture)

---

## 🧪 Development

```bash
pnpm typecheck   # type-check both tsconfigs
pnpm selftest    # build, then run the bundled benchmark and assert frame rate
```

Building installers: see [docs/PROTOCOL.md → 出安装包](docs/PROTOCOL.md#出安装包与---export-的分工)

---

## 🤝 Contributing

This is a personal project with a single maintainer and limited time, so external pull requests
aren't being accepted for now. That's not a lack of interest — I simply can't promise timely
reviews, or commit to maintaining someone else's code long-term.

If you want to build something on top of it, please do fork it. The MIT license lets you use it
however you need, including commercially and in closed-source work, with no need to ask.

---

## 📄 License

[MIT](LICENSE) © [InliSpwrad](https://github.com/Inlispwrad)
