# KNOWLEDGE — Deskapp  (更新: 2026-08-13)

> 长期共识，索引向。一行一条，不展开——详细内容在 README.md 里，这里只放指路牌。

## 约束

- **被装载 webapp 用起来必须像桌面 app，不像在操作浏览器** —— 这是整个工具存在的根本需求，任何改动不得违反。
- **显存有上限，越线通常直接崩溃重启**；显存记账服务于"离死线还有多远"的判断。
- **不能为了外观牺牲基本操作** —— 曾用 `titleBarStyle:'hiddenInset'` 换 Mac 观感，导致窗口拖不动。拖拽区必须由 Deskapp 自绘的标题栏自己声明 `-webkit-app-region: drag`，不得指望被装载页面提供。
- **透明窗口绝不用于应用窗口**（强制走慢速合成路径）；只有一次性的图标栅格化窗口可以透明。
- **改 `.app` 包内资源前必须检查签名是否封了资源**，正式签名的包一律放过——arm64 上签名坏了会拒绝启动。
- **不杀不是自己启动的进程** —— sidecar 启动前先探 readyUrl，已在运行则沿用、退出时不动它。
- 记账/统计口径一旦定下就写进注释与 README，改口径等于改结论。
- **导出应用与本地项目必须同构**：`deskapp.json` 一种格式三个位置，不允许出现"打包版专属逻辑"。
- **清单里的命令是磁盘数据，执行前必须经用户确认**；放行范围（含 CORS）只覆盖项目自己声明过的东西。

## 架构技术

- Electron 43.4.0（自带 Chromium 150）+ TypeScript 5.9.3 + electron-vite 5.0.0 + vite 7.3.6；electron-builder 26.15.3。
- **零运行时依赖**（除 electron 本身），shell UI 是原生 DOM 无框架。
- 窗口结构：`BaseWindow` +（自绘标题栏 `WebContentsView`）+（webapp `WebContentsView`，可整体销毁重建做 purge）；Inspector 是独立 `BrowserWindow`。
- 被装载页面用 `contextIsolation:false` + `nodeIntegration:false` —— 显存记账必须挂到页面主世界的 WebGL 原型上。
- 本地 webapp 经自定义 `app://` 标准安全协议加载，不用 `file://`。
- 三个 preload 目标：`preload/index.ts`（探针 + `window.deskapp`）、`preload/shell.ts`（Inspector/启动器/标题栏）。
- 构建产物：`build/main` `build/preload` `build/shell`；`pnpm typecheck` 是双 tsconfig（node + web）。

## 关键知识索引

- **一切细节的权威文档** → `README.md`（选型理由、记账口径与边界、CLI、API、打包、已知限制）
- 显存记账实现与格式表 → `src/preload/probe.ts`、`src/preload/gl-format-size.ts`
- 记账正确性的唯一硬证据 → `fixtures/stress/main.js`（独立算一份期望值逐字节对比）
- 宿主编排（窗口/视图/生命周期/告警/标题栏）→ `src/main/host.ts`
- 托管后端进程（PATH / 进程树 / 沿用现有实例）→ `src/main/sidecar.ts`
- 页面图标缓存与 `.icns` 手写编码 → `src/main/icon-cache.ts`
- 项目清单协议（entry/window/runtime/command/hooks）→ `src/main/project.ts`
- 四槽位协议的可运行例子 → `fixtures/project-demo/`
- 执行同意 → `src/main/consent.ts`；导出独立应用 → `src/main/export-app.ts`
- Chromium 开关档位 → `src/main/gpu-profiles.ts`
- webapp 侧对接面 → `README.md#windowdeskapp--webapp-对接面`
