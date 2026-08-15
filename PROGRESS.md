# PROGRESS — Deskapp v0.1.0 · alpha  (更新: 2026-08-13)

> 易失的当前工作状态。每条都能脱离对话独立看懂。
> 长期为真的东西在 KNOWLEDGE.md，细节在 `docs/`（PROTOCOL / ARCHITECTURE）。

## 换设备前先读这段

1. `pnpm install`。**若 `node_modules/electron/path.txt` 缺失**（pnpm 会拦 electron 的 postinstall，
   即使 package.json 里已有 `pnpm.onlyBuiltDependencies`），补跑：
   `node node_modules/electron/install.js`
   —— 实测这个坑在 Windows 上照样会踩到，`node_modules/electron/dist/` 整个不存在。
   另：**不要把仓库放在 exFAT 分区**，pnpm 建不了符号链接会直接 `ERR_PNPM_EISDIR`；
   非要放就 `pnpm install --node-linker=hoisted`。
   还有：**`node_modules` 不能跨平台拷贝**（POSIX 装的只有无扩展名 shim，Windows 上认不了），
   换设备要删掉重装。
2. `pnpm build` → `pnpm selftest`（跑自带压测台并断言帧率，全绿说明环境正常）
3. 仓库已在 GitHub（`Inlispwrad/Deskapp`，MIT）。构建产物不进库。
4. 构建产物统一在 `apps/<设备>/`（见 `apps/README.md`），已不再有绝对路径依赖。
5. 早期测试目标引用过外部 demo 的绝对路径，换设备后按实际位置替换。

## 已完成事项

- **【alpha 收尾】项目协议抽象化 + 导出独立应用** —— 两件事完成，产品作为 alpha 齐活：
  - `deskapp.json` 统一为项目清单：**一种格式三个位置**（项目目录 / 导出物 Resources / `--config`），
    导出应用与本地项目走同一条代码路径。最小协议只要一个 `index.html`。
    四槽位：`entry` · `hooks.startup` · `command`（常驻命令行）· `hooks.shutdown`。
  - 执行同意机制：清单里的命令是磁盘数据，首次执行前弹原生确认框列出确切命令，
    按「项目路径 + 命令哈希」记住；`--trust-project` 供无人值守跳过。
  - 启动器改造成项目选择器（项目名/图标取自各自清单），每行悬停出「导出」。
  - 导出**不依赖 electron-builder**：拷 Electron 骨架 + 注入代码/项目/清单 + 改 Info.plist
    与可执行名与 icns。macOS 实测导出物独立跑通完整四槽位协议，276MB。
  - `contentRoot` 概念（entry 所在目录）让命令与钩子的 cwd 在本地/导出两态天然一致。
  - `app://` 页面访问自己的服务是跨源的 —— 自动给清单声明的那个源补 CORS 头。
  - **启动器两种入口模式**：本地项目（index.html）/ 网址。差别只在 entry，其余协议一致。
    网址模式只填地址=临时装载不落盘；填了名称或脚本就在 userData/projects 下生成正常项目
    （能进最近列表、能导出）。按钮文案随之变化，行为可见不靠猜。
  - sidecar 就绪判据改成**先探地址、后判进程存活** —— 支持"启动脚本把服务丢后台自己退出"
    （`docker compose up -d` 这类）；这种情况会明确提示宿主收不了尾，需自写关闭脚本。
    回归 fixture：`fixtures/url-detach/`。
- **页面图标采用**（`adoptPageIcon`）：favicon → 隐藏 Chromium 窗口栅格化（覆盖 SVG/ICO）→ 合成到圆角底板 → 缓存 userData → 运行中 Dock 图标 + macOS 改 `.app/Contents/Resources/icon.icns`。手写 `.icns` 编码，用 `iconutil -c iconset` 反解验证过合法。
- **托管后端进程**（sidecar）：装载前拉起、就绪轮询、退出收整棵进程树；经登录 shell 解决 Finder 极简 PATH；已在运行则沿用不杀。`fixtures/sidecar/` 是它的回归（含孙子进程占端口）。
- **自绘标题栏**：`titleBarStyle:'hidden'` + 保留原生红绿灯 + 系统级 vibrancy 毛玻璃；Swiss Style 排版；右侧 FPS/MS/CPU/MEM 实时指标（约 2Hz），点击开 Inspector；全屏时收成 0 高。
- **内嵌应用配置**（`deskapp.json`）：把 Deskapp 打成某个 webapp 的专属应用；命令行优先级高于内嵌配置。
- 显存/帧/drawcall 探针、Inspector 面板、启动器、`app://` 协议、GPU 档位、崩溃与 OOM 恢复、`--smoke` 压测与 CI 断言、manifest 驱动窗口身份、消除浏览器痕迹（13 项）、三平台打包配置、README。
- **构建产物统一到 `apps/<设备>/`**：`pnpm dist:*` 与 `--export` 落同一地方，
  按 `${os}-${arch}` 分设备目录；`scripts/flatten-apps.mjs` 压掉 electron-builder 多套的那层。
  早期绝对输出路径的历史遗留随之消除。
- 全量回归 8/8 通过；显存记账逐字节一致（期望 25,864,912 B = 实测）；压测台稳态 60.0fps / p95 17.75ms / 0 长帧。

## 关键决策

- **`deskapp.json` 一种格式三个位置** —— 理由：导出应用若走"打包版专属逻辑"就会与本地项目
  行为漂移；同构才能一套测试覆盖两态（实测确实靠它抓到了 cwd 与 hasTarget 两个 bug）。
- **导出不依赖 electron-builder** —— 理由：打包后的 Deskapp 里没有 builder，
  也不该在用户机器上现下载 Electron 运行时。拷骨架 + 注入是纯文件操作，离线秒级。
- **命令与钩子的 cwd 用 contentRoot（entry 所在目录）而不是清单所在目录** —— 理由：
  导出后清单在 `Resources/`、项目在 `Resources/project/`，用内容根两态天然一致，
  不需要在导出时改写任何 cwd（第一版改写了，正是 bug 来源）。
- **清单声明的命令必须先确认** —— 理由：打开一个目录就执行其中任意 shell 是真实攻击面。
  记住的是"这些命令"（含哈希）而非"这个目录"；只记住"运行"，选"不跑"下次仍问。
- **CORS 只放行清单里 readyUrl 的那个源** —— 理由：放行"所有 localhost"等于把宿主
  变成绕过同源策略的通道。范围收窄到项目自己声明过的东西。
- **选 Electron 不选 Tauri** —— 理由：需求要求"webapp 功能都要正确且稳定展示"，Tauri 在 Linux 用 WebKitGTK，WebGL 差、无 WebGPU，跨平台一致性守不住。代价（体积/内存）落在"工具自身内存可以大"的既定前提内。
- **Inspector 做成独立窗口，不做覆盖层** —— 理由：覆盖层会挤压/遮挡 webapp、画布尺寸随面板开合抖动、输入被顶层视图吃掉，那就又变回"在操作浏览器"。
- **webapp 装在可替换的 `WebContentsView`，不用窗口自带 webContents** —— 理由：purge（彻底销毁渲染进程释放显存）需要能扔掉重建，窗口自带的无法替换。
- **macOS 用原生标题栏方案被否，改自绘** —— 理由：原生标题栏放不了图标（平台惯例无 API）；自绘同时解决拖拽区归属问题。
- **`max-perf` 在 macOS 不加 `--disable-frame-rate-limit`** —— 理由：实测（M3 + macOS 26.5）稳定让 GPU 进程 SIGSEGV；它确实能到 615fps 但崩溃换来的帧率无意义。逃生门 `--unsafe-uncap`。
- **标题栏 FPS 用中位数而非均值** —— 理由：事件驱动的 DOM 应用静止时不请求 rAF，均值被空闲拖到十几帧（实测 DSH 均值 19fps 而 p50=16.75ms）。
- **"页面有没有渲染"用 Paint Timing 判，不用 rAF** —— 理由：完全静态的页面从不调 rAF，只看 rAF 会把"画好了但不动"误判成白屏。
- **静止时标题栏显示刷新率上限 + MS 0，不显示 `—`** —— 理由：`—` 被读成"坏了"，均值被读成"很卡"，都不是事实。但接了 `unresponsive` 事件兜底：主线程被堵时强制显示 FPS 0（红），避免最该看见的故障被优化掉。
- **`adoptPageIcon` 默认关闭** —— 理由：通用 Deskapp 会切换不同应用，跟着改自己的图标是错的；只有专属打包该开。
- **图标要合成到圆角底板** —— 理由：大量 favicon 是给深色 UI 画的纯白字形，直接当 macOS 图标在 Finder 浅色背景上隐形。
- **smoke 必须显示真实窗口** —— 理由：隐藏窗口不参与合成，Chromium 把 rAF 掐到接近 0，帧数据是假的。Linux CI 用 xvfb。

## Windows 实测结论（2026-08-15，Win11 26200 + RTX 4070 Laptop）

全部在实机跑过，不是推断：

- **压测台通过**：打包产物与源码两条路径都 PASS，稳态 165fps / p95 6.25ms / 长帧 0，
  显存记账逐字节一致（`vramDeltaBytes=0`）。GPU 走 ANGLE + D3D11，没有静默退化到软渲染。
- **进程树回收干净（含孙子进程）**：`taskkill /T` 有效。三个夹具都跑完：
  - `fixtures/sidecar` —— 后端再 spawn 一个孙子占 3100 端口，且只处理 SIGTERM
    （Windows 根本不投递该信号）。退出后 3099 与 3100 双双释放，说明收的是整棵树。
  - `fixtures/project-demo` / `fixtures/url-detach` —— node 进程归零、端口全部释放；
    脱离式服务（启动命令自身退出、由孙子提供服务）也被正确识别并提示由关闭脚本收尾。
- **启动/关闭钩子、常驻命令行、readyUrl 轮询**全部生效。
- **`--export` 导出独立应用可用**：导出物自我识别内嵌清单，四槽位协议完整跑通。
- **`WIN_OVERLAY_INSET` 从 146 修正为 138**：用 `navigator.windowControlsOverlay
  .getTitlebarAreaRect()` 实测为 137 CSS px，且在 dpr 1 / 1.25 / 1.5 / 2 四档下恒定
  （137/138/137/137），取上界 138。原值多留 9px 死区。
  注：该 API 只对窗口顶层 webContents 可见，标题栏是子 `WebContentsView`，
  在它里面取不到真值，所以只能写常量。

### 标题栏指标区的焦点环（已修）

点过指标区后会留一圈红色描边，是 `.tb-data:focus-visible` 的焦点环（`--swiss-red`，
与装饰线同色），不是告警。成因：点击开/关 Inspector 这个独立窗口，焦点离开再回来时
Chromium 判为「非指针发起」，于是 `:focus-visible` 命中。

修法在 `src/shell/titlebar.ts` 的 click 处理：`if (e.detail > 0) data.blur()`。
**不能无条件 `blur()`** —— 键盘按 Enter 也会发 click，那样会把 Tab 的落点弄丢，
正好毁掉焦点环存在的意义；`detail` 恰好能区分（鼠标 ≥1，键盘恒 0）。

验证：鼠标路径在 Windows 实机复现过（改前有框、改后无框，同一操作序列）；
键盘路径用 `sendInputEvent` 发真实按键验证（Tab 后 `:focus-visible` 为 true，
Enter 的 click `detail === 0` 且焦点保留）。

### 顺手清掉的两处历史遗留

- **删掉 `src/main/bundled-config.ts`（141 行死代码）**。它是早期的「内嵌配置」实现
  （`target` / `server` / `productName` 那套 schema），后来被 `project.ts` 的
  `loadEmbeddedProject`（`entry` / `command` schema）取代，但文件没删。
  全仓已无 importer，删掉后 `pnpm typecheck` 照过。
  注意：**「内嵌应用配置」这个功能本身还在**，只是实现挪到了 `project.ts`。
- **`fixtures/sidecar/deskapp.json` 迁到当前 schema**。它此前还写着废弃的
  `target` / `server` 字段，loader 读不懂 → 静默退化成「宿主自检」→ **仍然返回 0**，
  是个会假装通过的坏测试，sidecar 回归实际上很久没跑过了。
  迁移时保留 `command` + `args` 形式（不经 shell 直接 exec）——
  project-demo 与 url-detach 都用 `run`（走登录 shell），只有这个夹具覆盖另一条分支。

### 环境坑（Windows 特有）

- **exFAT 分区上装不了也打不了包**（本次开发机 D: 就是 exFAT，两个坑都踩了）：
  - `pnpm install` → `ERR_PNPM_EISDIR`，pnpm 默认布局依赖符号链接，exFAT 不支持。
    绕过：`pnpm install --node-linker=hoisted`。
  - `pnpm dist:win` → `EPERM: rename 'win-unpacked.tmp' -> 'win-unpacked'`。
    **只有首次构建能过**——那次 Electron zip 是现下载的，builder 直接解压进 `win-unpacked`；
    zip 一进缓存就改走「解压到 `.tmp` 再 rename」，而这个 rename 在 exFAT 上必失败。
    已做对照实验确认：同源码、同缓存，仅把 `directories.output` 指到 NTFS 就成功，
    exFAT 上连续 3 次同样失败。**结论是文件系统限制，不是项目缺陷，不要去改构建脚本。**
    正解是把仓库放 NTFS。
- **`CI=true` 会让 electron-builder 触发隐式发布**，没有 `GH_TOKEN` 时整条 `dist:*` 以 1 退出
  （产物其实已经全部生成）。
- **打包后的 `Deskapp.exe` 是 GUI subsystem 二进制**：从终端直接调用拿不到 stdout 与退出码，
  需 `Start-Process -Wait`。CI 用 `pnpm selftest`（走 electron 包的 Node 包装器）不受影响。

## 未完成待办事项

1. **应用图标还是占位符**（`packaging/gen-icon.mjs` 生成的 Swiss 几何图形，不是任何品牌标识）。
   放一个 `resources/icon.png`（≥512²）electron-builder 会自动采用。
   注意这只影响安装包与 App Bundle 本身。
2. **Linux 从未实机验证过**（Windows 已实测，见下方「Windows 实测结论」）。
   Linux 侧待查：进程组信号的进程树回收是否干净；`--export` 导出物能否跑起来；
   `Vulkan` feature 开关在各发行版上的表现。
4. **Linux 的自绘标题栏没做**（`titleBarStyle` 在 Linux 不生效，会叠成双层，故恒用原生边框）。
   要做需自绘窗口控件（最小化/最大化/关闭），无实机不建议动。
5. **未做 CI 配置**。`--smoke` + `--assert-*` 已就绪，缺 GitHub Actions 工作流；
   Linux runner 需 `xvfb-run`。
6. **`--coi`（跨源隔离）只验证过开关生效**（`crossOriginIsolated=1` + SharedArrayBuffer 可用），
   没验证过真实使用 SharedArrayBuffer 的 wasm 多线程负载。
7. **`src/main/host.ts` 已约 1700 行**，是否拆分（窗口/视图/标题栏/项目生命周期/命令五块）待定——
   现在还读得懂，不为拆而拆。
8. **导出的 Linux 路径未实机验证**（`src/main/export-app.ts` 的 `brandGeneric`）。
   Windows 已实测通过。已知局限：Windows 改不了 exe 的图标与产品名；Linux 需自行写 `.desktop`。
9. **CORS 自动放行不覆盖预检**：需要 OPTIONS 的请求仍要服务端自己应答。
9.5 ~~点过标题栏指标区后会留一圈红色焦点环~~ **已修**（见「已完成事项」）。
10. **项目清单没有 JSON Schema**，编辑器里没有补全与校验。字段拼错只会被静默忽略
    （`sanitize()` 只保留认识的字段）。
