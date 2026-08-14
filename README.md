# 🖥️ Deskapp

> **高性能 webapp 桌面宿主 —— 把任何 webapp 变成真正的桌面应用。**

装载 webapp 之后,**用起来就是一个桌面应用,不是一个被遥控的浏览器**:
浏览器痕迹全部抹掉,帧时序、显存占用、GPU 状态全部量化,并在越线时告警。

[![Electron](https://img.shields.io/badge/Electron-43.4.0-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v0.1.0-512BD4)]()

---

## ✨ 特性

- **像应用,不像浏览器** —— 没有地址栏 / 标签页 / 右键菜单,窗口身份(标题、图标、尺寸、底色)由你的 webapp 自己声明,没有白闪、没有 URL 标题
- **性能看得见** —— 自绘标题栏实时显示 `FPS / MS / CPU / MEM`;`F12` 打开独立 Inspector:帧时序、显存记账、drawcall、进程资源、GPU 状态
- **为高性能而生** —— GPU 档位(`balanced` / `max-perf` / `compat`)、失焦仍满帧、一键销毁重建渲染进程(purge)、软件渲染静默退化检测
- **一套协议,三种形态** —— `deskapp.json` 一份清单,本地项目 / 导出独立应用 / 内嵌专属应用同一条代码路径
- **托管后端进程** —— 自动拉起你的 dev server、就绪轮询、退出时整棵进程树一起收;已在运行的服务沿用不杀
- **安全** —— 本地走 `app://` 安全协议;清单命令首次执行前弹原生确认;CORS 只放行声明过的源
- **自带压测台 + CI 门禁** —— `--smoke` 模式量化帧率 / 显存 / 长帧,按阈值给退出码
- **三平台打包** —— macOS(`dmg`)、Windows(`nsis`)、Linux(`AppImage` / `deb`)

---

## 🚀 快速开始

```bash
pnpm install
pnpm build
```

装载一个本地构建产物:

```bash
pnpm start -- /path/to/your/webapp/dist
```

装载一个开发服务器:

```bash
pnpm start -- http://localhost:5173
```

不带参数启动进入**项目选择器**:

```bash
pnpm start
```

---

## ⚙️ 配置项目

一个目录里有个 `index.html` 就能跑;加一份 `deskapp.json` 声明窗口与服务:

```jsonc
{
    "version": 1,
    "name": "我的项目",
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
        "run": "npm run serve",              // 常驻服务,自动拉起
        "readyUrl": "http://127.0.0.1:5173/",  // 轮询到它响应才加载页面
        "readyTimeoutMs": 90000
    },
    "hooks": {
        "startup": "pnpm install",           // 装载前跑
        "shutdown": "./scripts/cleanup.sh"   // 退出时跑
    }
}
```

把项目导出成双击即用的独立应用:

```bash
electron . --export <项目目录> --out ~/Desktop
```

---

## 📚 文档

- [docs/PROTOCOL.md](docs/PROTOCOL.md) —— 项目协议与 API 详解(完整清单、`window.deskapp` 对接面、命令行、打包)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构与设计决策(记账口径、帧率统计口径、性能档位、安全姿态)

---

## 🧪 开发

```bash
pnpm typecheck   # 双 tsconfig 类型检查
pnpm selftest    # 编译 + 跑自带压测台并断言帧率
```

安装包构建:见 [docs/PROTOCOL.md → 出安装包](docs/PROTOCOL.md#出安装包与---export-的分工)

---

## 📄 License

[MIT](LICENSE) © [InliSpwrad](https://github.com/Inlispwrad)
