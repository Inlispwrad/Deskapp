# 🖥️ Deskapp

> **高性能 webapp 桌面宿主 —— 把任何 webapp 变成真正的桌面应用。**

装载 webapp 之后,**用起来就是一个桌面应用,不是一个被遥控的浏览器**:浏览器痕迹全部抹掉,
帧时序、显存占用、drawcall、进程资源、GPU 状态全部量化,并在越线时高声告警。

[![Electron](https://img.shields.io/badge/Electron-43.4.0-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-v0.1.0-512BD4)]()

---

## ✨ 产品亮点

### 🎯 像应用,不像浏览器
装载后 webapp 占满整个客户区:没有地址栏、没有标签页、没有右键菜单,缩放/刷新/外链跳转全部按应用语义处理。窗口身份(标题、图标、尺寸、底色)由 webapp 自己通过一份清单声明,第一次出现就是正确的样子,没有白闪、没有 URL 标题。

### 📊 性能看得见
- **自绘标题栏**实时显示 `FPS / MS / CPU / MEM`,配色分档(黄/红),点击即开 Inspector
- **Inspector 独立窗口**:帧时序图、显存记账、drawcall、进程资源、GPU 状态、应用自报指标
- **显存记账**:挂钩 WebGL/WebGPU 全部分配路径,维护影子账本——实测与独立期望值**逐字节一致**(25,864,912 B = 25,864,912 B)

### 🔋 为高性能而生
- 三档 GPU 档位:`balanced` / `max-perf` / `compat`,控制 Chromium 底层开关
- 关闭后台节流与遮挡检测,失焦/被盖住仍满帧
- **purge 销毁重建**:把整个渲染进程扔掉重建,显存与 V8 堆真正归零
- **软件渲染静默退化检测**:驱动异常时 Chromium 会悄悄换 SwiftShader,Deskapp 主动检测并告警

### 🧩 一套协议,三种形态
`deskapp.json` 一种格式,三个位置,同一条代码路径:
- **本地项目**:选一个目录,里面有个 `index.html` 就能跑
- **导出应用**:把项目连同运行时注入成双击即用的独立应用(不依赖 electron-builder,秒级、离线)
- **内嵌配置**:把 Deskapp 打成某个 webapp 的专属应用

### ⚙️ 托管后端进程(Sidecar)
- 装载前自动拉起服务、轮询 `readyUrl` 就绪、退出时**整棵进程树**一起收
- 服务已在运行时**沿用不杀**(adopted 模式)
- 启动脚本把服务丢后台自己退出?支持,但会明确提示你写关闭脚本

### 🛡️ 安全姿态
- 本地 webapp 走 **`app://` 安全协议**而非 `file://`(localStorage / ES module / SPA 路由全部正常)
- 页面拿不到 Node(`nodeIntegration: false`);需要沙箱强度时 `--no-probe` 开启 `contextIsolation`
- 清单里的命令是磁盘数据,首次执行前**弹原生确认框**,按「项目路径 + 命令哈希」记住——不是无脑执行
- CORS 只自动放行清单里声明过的那个源,不是"所有 localhost"

### 🧪 自带压测台 + CI 门禁
```bash
electron . --smoke <目标> --duration 15 --assert-fps 58 --assert-p95 20
```
加载 → 预热 → 采样 → 截图 → 报告 → 按阈值给退出码。启动期与稳态分开报,
帧率/显存/长帧/崩溃全量记录,换机器 / 升 Electron 后先跑一遍确认环境正常。

### 📦 三平台打包
macOS(`dmg`/`zip`)、Windows(`nsis`/`zip`)、Linux(`AppImage`/`deb`),产物按设备分目录互不覆盖。

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

不带参数启动会进入**项目选择器**(Deskapp 自己的启动器):

```bash
pnpm start
```

把项目导出成独立桌面应用:

```bash
electron . --export fixtures/project-demo --out ~/Desktop
```

自检(跑自带压测台并断言帧率):

```bash
pnpm selftest
```

---

## 🖥️ 界面速览

自绘标题栏(macOS / Windows,Swiss Style + 系统级毛玻璃):

```
[红绿灯]  ▣ 图标 │ MY WEBAPP — DESKAPP DEMO      FPS 60  MS 1.0  CPU 2%  MEM 144M  ▮
```

- **左**:页面自己的 favicon(没有才退回清单图标)+ 全大写紧字距标题
- **右**:被装载 app 自己的实时指标,约 2Hz,点击开 Inspector;窄窗口按优先级折叠
- 有未消解的告警(显存越线 / 崩溃过)时,底边 hairline 变红
- 全屏时标题栏收成 0 高,webapp 拿回整块客户区

Inspector(`F12`)是**独立窗口**,不是叠在应用上的覆盖层 —— 不挤压、不遮挡、不抖动。

---

## 📑 文档

- [为什么是 Electron](#为什么是-electron)
- [App 模式:抹掉的浏览器痕迹](#app-模式抹掉的浏览器痕迹)
- [Web App Manifest](#web-app-manifest次要来源)
- [项目协议 `deskapp.json`](#项目协议-deskappjson)
- [导出成独立桌面应用](#导出成独立桌面应用)
- [`window.deskapp` —— webapp 对接面](#windowdeskapp--webapp-对接面)
- [显存记账:口径与边界](#显存记账口径与边界)
- [帧率的口径:均值 vs 中位数](#帧率的口径均值-vs-中位数)
- [性能档位](#性能档位)
- [Inspector](#inspector)
- [无人值守压测 / CI 门禁](#无人值守压测--ci-门禁)
- [命令行](#命令行)
- [本地 webapp 走 `app://` 而不是 `file://`](#本地-webapp-走-app-而不是-file)
- [安全姿态](#安全姿态)
- [出安装包(与 `--export` 的分工)](#出安装包与---export-的分工)
- [已知限制](#已知限制)
- [项目结构](#项目结构)

---

## 为什么是 Electron

需求里最硬的一条是「webapp 提供的功能都要能**正确且稳定**展示」。

- **Tauri / 系统 WebView 过不了这一条**:Linux 上是 WebKitGTK,WebGL 性能差、WebGPU 缺失,
  同一份 webapp 代码在三个平台表现不一致,"跨平台一致性"直接失守。
- **Electron 自带 Chromium**:三平台同一个渲染实现、GPU 开关可控、进程可测可杀、DevTools 可用。

代价是壳自身体积与常驻内存都不小(本机实测:macOS arm64 未压缩 `.app` 276MB,
安装包压缩后约 100MB;空载启动器状态下全部进程合计约 300MB RSS)。
这正好落在既定前提里:**被装载 webapp 的内存要抠,工具自己的内存可以大。**

---

## App 模式:抹掉的浏览器痕迹

默认即 App 模式。清单如下,每一条都是"这是应用"和"这是网页"的差别:

| 浏览器行为 | Deskapp 的处理 |
|---|---|
| 地址栏 / 工具栏 / 标签页 | 没有。webapp 占满整个客户区 |
| 菜单栏 | Win/Linux 不挂菜单;macOS 保留 role 菜单(否则 Cmd+Q/W/H 失效,反而不像原生应用) |
| Ctrl+滚轮 / Ctrl± 缩放 | 屏蔽(画布尺寸不该被用户误改) |
| Ctrl+P/F/G/U/L/N/J/H、前后退 | 屏蔽 |
| Ctrl+R / F5 刷新 | App 模式屏蔽;Inspector 打开时(= dev 模式)放行 |
| 右键菜单 | App 模式没有;dev 模式给「检查元素 / 重新加载」 |
| 拖文件进窗口 → 导航打开它 | 拦下 |
| `window.open` 弹一个像浏览器的窗口 | 拦下,外链交给系统浏览器 |
| 站外链接在应用内跳走 | 拦下,交给系统浏览器;站内导航(SPA 路由)放行 |
| 启动白闪 | 窗口 `show:false` + 底色取自 manifest `background_color`,DOM 就绪才显示 |
| 窗口标题写着页面 URL | 标题取 `manifest.name`,其后跟随 `document.title` |
| 后台标签页被降频 | 关闭后台节流与遮挡检测,失焦/被盖住仍满帧 |

**开发者面板是独立窗口**(`F12`),不是叠在应用上的覆盖层——覆盖层会挤压或遮挡 webapp,
画布尺寸随面板开合抖动、输入被顶层视图吃掉,那就又变回"在操作浏览器"了。

### 自绘标题栏

macOS / Windows 上默认用 Deskapp 自绘的标题栏,Swiss Style 排版 + 系统级毛玻璃:

```
[红绿灯]  ▣ 图标 │ MY WEBAPP — DESKAPP DEMO      FPS 60  MS 1.0  CPU 2%  MEM 144M  ▮
```

- **左**:图标 + hairline + 全大写紧字距标题。图标优先用**页面自己的 favicon**
  (那才是"网页传进来的图标"),没有才退回 manifest / 内嵌配置的图标,都没有就画一个
  Swiss 红方块不留空位。用 `<img>` 而不是 CSS 背景图:URL 不进样式表没有注入面,
  且由 Chromium 解码——`.ico` / `.svg` 都能正确显示(主进程的 `nativeImage` 这两种都不支持)
- **右**:`FPS` / `MS`(主线程每帧脚本耗时)/ `CPU` / `MEM`,约 2Hz 刷新,都是**被装载 app 自己**的数据。
  点一下开 Inspector。窄窗口按优先级依次折叠 MS → CPU → 标题
- **配色分档**:FPS < 25 黄、< 10 红;MS > 8ms 黄、> 16ms 红
- 有未消解的告警(显存越线 / 崩溃过)时,底边 hairline 换成红色实条
- 全屏时标题栏收成 0 高,webapp 拿回整块客户区

**为什么必须自绘**:macOS 原生标题栏不显示应用图标(平台惯例,无 API 可改)。

**毛玻璃只能来自系统**:CSS `backdrop-filter` 在这里没用——它只能模糊同一页面内的背景,
而标题栏是独立的 `WebContentsView`,跨不过合成边界。真毛玻璃用 macOS `vibrancy` /
Windows `backgroundMaterial: acrylic`,模糊的是**窗口背后的桌面**,也就是 Finder 工具栏那种观感。
实测(Apple M3,压测台,各 3 次)**零可测性能成本**:自绘 60.0 fps / p95 17.75 vs 原生 60.0 fps / p95 17.75。

**拖拽区由标题栏自己声明** `-webkit-app-region: drag`。上一版用
`titleBarStyle: 'hiddenInset'` 指望被装载页面提供可拖区域——webapp 当然不会这么做,
结果窗口根本拖不动。这个坑不要再踩。

Linux 上 `titleBarStyle` 不生效(自绘条会叠在原生标题栏下变成双层),恒用原生边框。
不想要自绘条用 `--native-titlebar`。

### 快捷键

| 键 | 作用 |
|---|---|
| `F11`(mac `Ctrl+Cmd+F`) | 全屏 |
| `F12`(mac `Alt+Cmd+I`) | 开关 Inspector |
| `Ctrl/Cmd+Shift+R` | 硬刷新 |
| `Ctrl/Cmd+Shift+P` | 销毁并重建渲染进程(purge) |
| `Esc` | 退出全屏(kiosk 模式除外) |

---

## Web App Manifest(次要来源)

除 `deskapp.json` 外,Deskapp 也读标准 [Web App Manifest](https://developer.mozilla.org/docs/Web/Manifest)(`manifest.json`)。
**`deskapp.json` 是显式声明,逐字段压过它**;两者都没有时退化到目录名 + `document.title`。
下面这套 `deskapp` 私有扩展字段是早期设计,仍然可用,但新项目建议直接写 `deskapp.json`。
**本地目录目标在加载前就能读到它**,所以窗口第一次出现就是正确的尺寸、底色和标题,不会跳。

```json
{
    "name": "我的游戏",
    "short_name": "游戏",
    "display": "standalone",
    "background_color": "#0a0d12",
    "icons": [{ "src": "icon-512.png", "sizes": "512x512" }],

    "deskapp": {
        "width": 1280,
        "height": 720,
        "minWidth": 720,
        "minHeight": 480,
        "resizable": true,
        "aspectRatio": 0,
        "vramLimitMB": 400
    }
}
```

| 字段 | 作用 |
|---|---|
| `name` / `short_name` | 窗口标题、macOS Dock 名称 |
| `background_color` | 窗口底色(消除启动白闪) |
| `icons` | 取最大尺寸那张作为窗口/Dock 图标 |
| `display: "fullscreen"` | 全屏启动 |
| `deskapp.width/height` | 初始窗口尺寸 |
| `deskapp.minWidth/minHeight` | 最小尺寸 |
| `deskapp.resizable` | 是否允许缩放 |
| `deskapp.aspectRatio` | 锁定宽高比(如 `1.7777`),`0` 不锁 |
| `deskapp.vramLimitMB` | 该应用的显存告警线 |

没有 manifest 也能跑:标题退化成目录名 + `document.title`,尺寸用上次关闭时的(按目标分别记忆)。

远端 URL 目标的 manifest 在页面加载完成后抓取,因此只影响标题与图标,底色已经提交了。

---

## 项目协议 `deskapp.json`

Deskapp 打开时是**项目选择器**(这是它自己的启动器)。选一个项目目录即可运行。

**一种格式,三个位置** —— 这是整个抽象化的核心,导出应用与本地项目走的是同一条代码路径,
不存在"打包版特殊逻辑":

| 位置 | 场景 |
|---|---|
| `<项目目录>/deskapp.json` | 用启动器打开一个项目 |
| `<Resources>/deskapp.json` | 导出成独立应用后,它靠这份清单自我识别 |
| `--config <文件>` | 显式指定,优先级最高 |

### 两种入口模式

启动器给两个模式,**差别只在 `entry`,其余协议完全一致**(启动/关闭脚本、窗口、导出):

| 模式 | entry | 用法 |
|---|---|---|
| **本地项目** | `index.html` | 选一个目录。里面有 `index.html` 就够了,`deskapp.json` 可选 |
| **网址** | `http(s)://…` | 直接填地址,可再填启动脚本 / 关闭脚本 / 名称 |

网址模式里:**只填地址 = 看一眼**,不落盘;一旦填了名称或脚本,就会在 Deskapp 的数据目录
(`userData/projects/<名称>-<短哈希>/`)生成一份普通的 `deskapp.json` ——
之后它就是一个正常项目:进最近列表、可导出成独立应用。按钮文案会跟着变,行为看得见。

> 短哈希是 URL 的:同名不同址不会互相覆盖。

### 最小协议

**一个 `index.html` 就够了。** 目录里连 `deskapp.json` 都没有也能打开,全部走默认值。
其余字段都是渐进增强。

### 完整清单

```jsonc
{
    "version": 1,
    "name": "我的项目",              // 窗口标题 / Dock 名 / 导出应用名
    "entry": "index.html",           // 入口;也可写 http(s) URL
    "icon": "icon.png",

    "window": {
        "width": 1280, "height": 720,        // 指的是**网页视口**尺寸
        "minWidth": 720, "minHeight": 480,
        "background": "#0a0d12",             // 窗口底色,消除启动白闪
        "resizable": true,
        "aspectRatio": 0,                    // 锁宽高比,0 = 不锁
        "fullscreen": false,
        "frameless": false,
        "nativeTitlebar": false
    },

    "runtime": {
        "profile": "balanced",               // 进程级,运行期改不了(会提示重启)
        "angle": "default", "webgpu": false,
        "zoom": 1,
        "vramLimitMB": 400, "rssLimitMB": 1500, "maxOldSpaceMB": 2048,
        "sampleIntervalMs": 500,
        "crossOriginIsolated": false,
        "adoptPageIcon": false               // 用页面 favicon 当应用图标
    },

    // 常驻命令行(服务 / dev server)
    "command": {
        "run": "npm run serve",              // 原样交给登录 shell
        // 或显式形式(不经 shell):"command": "node", "args": ["server.mjs"]
        "cwd": ".", "env": {},
        "readyUrl": "http://127.0.0.1:5173/",  // 轮询到它有响应才加载页面
        "readyTimeoutMs": 90000
    },

    // 一次性生命周期脚本
    "hooks": {
        "startup": "pnpm install --frozen-lockfile",  // 装载前跑完才继续
        "shutdown": "./scripts/cleanup.sh",           // 关闭时跑
        "timeoutMs": 120000
    }
}
```

四个协议槽位(入口 / 启动脚本 / 命令行 / 关闭脚本)的完整可运行例子在
`fixtures/project-demo/`,`pnpm build && electron . fixtures/project-demo` 即可看到。

### 启动脚本的两种形态都支持

`command.run` 会等 `readyUrl` 通了才加载页面。**就绪判据是"地址通不通",
不是"我们 spawn 的那个进程还在不在"** —— 所以两种常见写法都成立:

| 写法 | 例子 | 收尾 |
|---|---|---|
| 服务本身长期运行 | `npm run serve` | Deskapp 退出时**整棵进程树**一起收 |
| 脚本把服务丢后台后自己退出 | `docker compose up -d`、`./start.sh &` | Deskapp 收不到,**必须写关闭脚本自己停** |

第二种情况日志里会明说"启动命令自身已退出,服务由它派生的后台进程提供 ——
这种情况 Deskapp 无法代为收尾"。可运行例子见 `fixtures/url-detach/`。

### ⚠️ 执行确认

`command` 与 `hooks` 是**磁盘上的数据**。无条件执行意味着"把一个目录拖进 Deskapp
就跑了里面的任意 shell 命令"——这是一条真实的攻击面,不能因为"通常是自己的项目"就免掉。

所以首次打开声明了命令的项目时会弹原生确认框,列出**确切的命令**,三选一:
运行并记住 / 只装载页面不跑命令 / 取消。按「项目路径 + 命令内容哈希」记住决定,
**项目改了命令会重新确认**——记住的是"这些命令",不是"这个目录以后随便跑"。
只记住"运行";选了"只装载页面"下次仍然问,免得一次误点就永久静默。

无人值守场景用 `--trust-project` 跳过(等于声明"我已审阅过这份清单")。

### 页面访问自己的服务:CORS 已自动放行

本地项目的页面跑在 `app://local`,而它的服务在 `http://127.0.0.1:PORT` —— 这是**跨源**,
浏览器默认全拦。几乎每个带 `command` 的项目都会撞上,所以 Deskapp 自动给
**清单里 `readyUrl` 的那个源**补上 CORS 响应头。

放行范围严格限定在项目自己声明的那个源,不是"所有 localhost"。
局限:需要预检(OPTIONS)的请求还得服务端自己应答 OPTIONS ——
我们只能给响应补头,造不出一个服务端不给的响应。

## 导出成独立桌面应用

把配置好的项目连同 Deskapp 运行时一起打包成一个双击即用的应用:

```bash
electron . --export <项目目录> [--out <输出目录>] [--export-name 名称] [--export-app-id id]
```

不给 `--out` 就落到项目内的 `apps/<设备>/`,与 `pnpm dist:*` 的产物同处一地。

或在启动器里把鼠标移到某个项目上,点「导出」。

**不依赖 electron-builder** —— 这是关键取舍:打包后的 Deskapp 里没有 builder,
也不该在用户机器上现下载 Electron 运行时。做法是**拿一个已存在的 Electron 骨架往里注入**:

| 步骤 | 内容 |
|---|---|
| 骨架 | 已打包运行时 = Deskapp 自己的 `.app`;从源码跑 = `node_modules/electron/dist` |
| 注入应用代码 | Deskapp 有**零运行时依赖**,只要 `build/**` + 精简 `package.json`(打包态直接搬 `app.asar`) |
| 注入项目 | 项目文件 → `Resources/project/`(跳过 `node_modules` / `.git` 等) |
| 注入清单 | `Resources/deskapp.json`,`entry` 重指到 `project/` |
| 改身份 | Info.plist(名称/标识/可执行名)、可执行文件改名、`icon.icns` |

于是导出是纯文件操作:离线可用、秒级完成、产物与"专属打包"完全同构。
实测 macOS 产物 276MB。

`command` / `hooks` 的 `cwd` **不需要在导出时改写**:它们相对**内容根**(entry 所在目录)
解析,导出后 `entry` 指向 `project/`,内容根自然跟着走。

> **平台差异**:macOS 路径经过实测(导出物独立跑通了完整四槽位协议)。
> Windows / Linux 用同一套拷贝注入逻辑但**未在实机验证过**;
> 且 Windows 的 exe 图标与产品名编在 PE 资源里,本导出方式改不了(窗口标题与 Dock 名正确)。
> 这些局限会原样出现在导出完成的提示里,不藏着。

## `window.deskapp` —— webapp 对接面

被装载页面里始终存在(可用 `window.deskapp?.isDeskapp` 探测)。

```ts
// 上报应用自己的指标 → 进 Inspector 面板与 smoke 报告
deskapp.report({ nodes: 1240, drawCalls: 86, frameProcessMs: 4.2 });

// 无副作用读显存记账与 GL 对象数(可以每秒轮询)
const { vram, counts, gl } = deskapp.peek();
if (vram.total > 380 * 1024 * 1024) releaseAtlases();

// 完整采样(含帧统计)。⚠️ 有副作用:会清空采样窗口,别放进帧循环
const s = deskapp.stats();

// 时间点标记,落进 smoke 报告的时间轴
deskapp.mark('assets-loaded');

// 窗口
await deskapp.setFullscreen(true);
await deskapp.setWindowSize(1600, 900);
await deskapp.setTitle('第 3 关');

// 生命周期与外链
await deskapp.reload();
await deskapp.quit();
await deskapp.openExternal('https://example.com');

// 主动触发 V8 GC(默认已带 --expose-gc)
deskapp.gc();

// 宿主事件
deskapp.on('fullscreen-change', (e) => resize());
deskapp.on('before-purge', () => saveState());

// 只读信息
deskapp.version; deskapp.platform; deskapp.profile;
```

---

## 显存记账:口径与边界

浏览器不向 JS 暴露真实显存占用。Deskapp 的做法是**记账**:挂钩所有会分配 GPU 内存的
WebGL/WebGPU 调用,维护影子绑定状态,逐对象累计。

**覆盖的分配路径**

`texImage2D` / `texImage3D` / `texStorage2D` / `texStorage3D` / `copyTexImage2D` /
`compressedTexImage2D` / `compressedTexImage3D` / `generateMipmap` /
`renderbufferStorage` / `renderbufferStorageMultisample` / `bufferData` /
`GPUDevice.createTexture` / `GPUDevice.createBuffer`,以及对应的 `delete*` / `destroy()`。

**已知偏差(记账值是下界,真实占用只会更高)**

- 三通道格式(RGB8 / RGB16F / RGB32F)在绝大多数 GPU 上按四通道存储,这里按四通道算;
- 驱动的 tile / 对齐补齐未计入;
- 默认帧缓冲(canvas 自己的 drawing buffer)不经 API 分配,不在账内;
- 压缩纹理按上传的 `byteLength` 计,与实际一致。

结论:**用于判断「离 400MB 死线还有多远」足够,不能当精确显存读数。**
面板同时显示 GPU 进程 RSS 作为交叉验证——两者长期背离说明记账有洞。

**mip 链是精确算的**,不用常见的「level 0 的 1/3」近似(那个值只在无穷级数下成立,
256² RGBA 会差 2 字节,非方形纹理误差更大)。

**按上下文分账**:Pixi 等库会先建一个临时上下文探测硬件能力再主动丢弃。
如果记一本全局账、"任一上下文丢失就清零",那次无害的丢弃会把真实上下文的账一起抹掉。

**对象数是 `create` 减 `delete`**。持续单向上涨即为泄漏——未显式 delete 的 GL 对象
只有等 JS 对象被 GC 才释放,时机不可控。

### 记账正确性怎么保证

`fixtures/stress` 压测台**自己独立算一份期望值**(同一口径、不同实现),
再和探针实测值逐字节对比,结果通过 `deskapp.report({ vramAccountingOk })` 上报。
`pnpm selftest` 会跑它;期望值随分配同步累加,不是硬编码常数。

当前实测:期望 25,864,912 B = 实测 25,864,912 B,差 0 字节(含 mipmap 路径)。

---

## 帧率的口径:均值 vs 中位数

两类应用的帧数据要分开理解,混着看会得出完全错的结论:

- **持续渲染**(游戏 / 动画):每帧都请求 rAF,均值与中位数几乎相等,两个都能看。
- **事件驱动**(DOM 应用):静止时**根本不请求 rAF**,空闲间隔会把均值拖到十几帧。
  实测典型 DOM 应用:均值 19 fps,而 `p50 = 16.75ms`——它动的时候是满帧 60。

所以:

| 位置 | 用哪个 | 为什么 |
|---|---|---|
| 标题栏 `FPS` | **中位数**推算 | 一眼扫的数字不能骗人也不能狼来了;中位数对两类应用都成立,也抗单次长帧 |
| Inspector | 均值 + p50 + p95 + p99 + max 全给 | 详细面板不做取舍,长帧要靠 p95/max 才看得见 |
| smoke 报告 | 均值 + 全分位数;窗口内 0 帧时明确写"事件驱动,非持续渲染" | 报告要能被别人正确读懂 |

### 页面完全静止时显示什么

标题栏显示 **FPS = 显示器刷新率上限、MS = 0**,不显示 `—`。

理由:页面已经画出来、现在没有任何工作要做,也就没有任何阻塞。显示 `—` 会被读成"坏了",
显示被空闲拖低的均值会被读成"很卡",两者都不是事实。

**但这里有个必须堵住的坑**:主线程被死循环堵住时 rAF 也停了,"没有帧"和"完全空闲"
在数据上长得一模一样。所以额外接了 Electron 的 `unresponsive` / `responsive` 事件——
主线程被堵时强制显示 FPS 0(红),绝不报"一切正常"。否则最该看见的故障恰好被优化掉了。

### 「有没有渲染」不能问 rAF

判断页面是否真的画出来了,用的是 **Paint Timing API**(`first-contentful-paint`),
不是 rAF。因为**完全静态的页面从不调用 rAF**,但画面早就在屏幕上了——
只看 rAF 会把"画好了但不动"误判成"白屏"。(这是实测踩出来的:静态 fixture 一开始被判失败。)

所以 smoke 的失败判定是三层:

- 统计窗口内 0 帧 → **正常**(事件驱动的应用静止时不请求 rAF)
- 一次 rAF 都没有 → **也可能正常**(完全静态的页面从不调 rAF)
- 连首次绘制都没有 → **才是真故障**(白屏 / 探针没装上)

报告里 `启动到首绘` 与 `启动到首帧` 分开给:静态页面只有前者,游戏两者都有。

`--assert-fps` / `--assert-p95` 是给持续渲染的应用用的,对事件驱动应用没有意义。

## 性能档位

档位决定 Chromium 命令行开关,是**进程级**的,改了要重启 Deskapp。

| 档位 | 用途 |
|---|---|
| `balanced`(默认) | 保留 vsync,行为最接近玩家实机 |
| `max-perf` | 关 vsync、禁止软渲染回退,用于量真实帧成本 |
| `compat` | 强制 SwiftShader 软件渲染,管线形状不变——用于三分排查「是 webapp 的问题还是 GPU/驱动问题」 |

### macOS 上 max-perf 不解帧率上限

真正解掉帧率上限的开关是 `--disable-frame-rate-limit`。它确实有效(本机实测 **615 fps**),
但在 macOS / Metal 上会让 **GPU 进程 SIGSEGV**(Apple M3 + macOS 26.5,`exit_code=11`,稳定复现)。

崩溃换来的高帧率没有意义,所以 macOS 上默认不加这个开关,`max-perf` 仍受显示器刷新率限制
(其余优化照常生效)。Windows / Linux 上正常加。要在 macOS 上强行解锁:`--unsafe-uncap`
——它会崩,只在明知代价时用。

所有档位共有:关闭后台节流与遮挡检测、`autoplay-policy=no-user-gesture-required`、
关闭双指缩放、`force-color-profile=srgb`(同一份内容在不同显示器色域下结果一致)、
`--expose-gc`、可配的 V8 老生代上限。

**软件渲染检测**:Chromium 在驱动异常 / 黑名单命中 / 远程桌面等场景会悄悄换成 SwiftShader,
表现是"画面完全正确但只有几帧"。Deskapp 主动检测并高声告警——不检测就会把几小时
浪费在找 webapp 的性能 bug 上。

---

## Inspector

`F12` 打开。数据全部由主进程推送,面板只做展示。

- **帧**:fps、帧时间条形图(按预算分绿/黄/红)、`avg/p50/p95/p99/max`、长帧计数、主线程脚本耗时
- **显存记账**:总量对告警线的进度条 + 纹理/renderbuffer/buffer/WebGPU 明细 + 历史峰值
- **绘制与 GL 对象**:每帧 drawcall avg/max、各类对象存活数、WebGL 上下文数
- **内存**:JS 堆已用/总量/上限、webapp 渲染进程 RSS、GPU 进程 RSS、各进程明细表
- **应用自报指标**:`deskapp.report()` 的内容
- **GPU**:渲染器 / 厂商 / 特性状态
- **设置**:档位、显存与 RSS 告警线、采样周期
- **日志**:宿主告警 + 页面 `console.warn/error`

工具栏动作:刷新 / 硬刷新 / **销毁重建** / GC / DevTools / 全屏 / 截图 / 换应用。

> **销毁重建(purge)和刷新的区别**:刷新复用渲染进程,GPU 侧资源与 V8 堆碎片都留着;
> purge 把整个渲染进程扔掉重建,是唯一能真正把显存与堆归零的手段。

---

## 无人值守压测 / CI 门禁

```bash
electron . --smoke <目标> --duration 15 --assert-fps 58 --assert-p95 20 --assert-vram 400
```

加载目标 → 预热 → 采样 → 截图 → 写 `report.json` → 按阈值给退出码(0 通过 / 1 失败 / 2 用法错)。

报告包含:启动到首帧耗时、启动期最长帧、稳态帧率与分位数、显存峰值、进程 RSS 峰值、
单帧最大 drawcall、应用自报指标、进程明细、GL 事件、`console.error`、全部告警、崩溃次数。

**启动期与稳态分开报,不是把启动数据丢掉**:「多久出第一帧」和「稳定后掉不掉帧」
是两个问题,混进一个平均值里两个都看不清。默认预热 3s(`--warmup` 可调)。

失败判定除了显式断言,还包括:截不到画面、整段没有观察到任何一帧、落到软件渲染(`compat` 档除外)、
渲染进程或 GPU 进程崩溃、以及页面自报的 `*Ok` 指标为 0。
`console.error` 默认只进报告不判失败(很多游戏会打无害的错误日志),
要当门禁用 `--assert-no-console-errors`。

配 `--dev` 一起用会额外存一张 `inspector.png`,CI 可直接归档。

**看门狗**:GPU 进程崩溃会让 `capturePage()` 永不返回。smoke 因此带硬超时
(预热 + 时长 + 30s)并强制退出——CI 里挂死比失败更糟,会占着 runner 直到整体超时。

### 宿主自检(不带目标)

```bash
electron . --smoke --duration 3
```

不给目标时 smoke 退化成宿主自检:装载启动器、截图、验证 Deskapp 自己能起来且 shell UI 无报错。
不涉及任何 webapp,帧与显存断言全部跳过。换机器 / 升 Electron 后先跑这个。

> ⚠️ smoke 模式**会显示真实窗口**。隐藏窗口不参与合成,Chromium 会把 rAF 掐到接近 0,
> 量出来的帧数据是假的。Linux CI 上用 `xvfb-run` 跑。

---

## 命令行

```
deskapp [目标] [选项]
```

| 选项 | 说明 |
|---|---|
| `--dev` | 启动即显示 Inspector |
| `--size <宽x高>` | 初始窗口尺寸 |
| `--fullscreen` / `--frameless` / `--kiosk` | 窗口模式 |
| `--native-titlebar` | 用平台原生标题栏,不用自绘那条 |
| `--config <文件>` | 内嵌应用配置(见「打成专属应用」) |
| `--title <文本>` | 覆盖窗口标题 |
| `--zoom <倍数>` | 页面缩放 |
| `--profile <档位>` | `balanced` / `max-perf` / `compat` |
| `--angle <后端>` | `default`/`gl`/`d3d11`/`d3d9`/`metal`/`vulkan`/`swiftshader` |
| `--webgpu` | 放开 WebGPU |
| `--unsafe-uncap` | 强行加 `--disable-frame-rate-limit`(macOS 上会崩 GPU 进程) |
| `--max-old-space <MB>` | 渲染进程 V8 老生代上限,默认 2048 |
| `--sample-interval <ms>` | 指标采样周期,默认 500 |
| `--vram-limit <MB>` | 显存告警线,默认 400 |
| `--rss-limit <MB>` | 渲染进程 RSS 告警线,默认 1500 |
| `--no-probe` | 关闭页面内插桩(同时开启 contextIsolation) |
| `--coi` | 发 COOP/COEP 头,启用跨源隔离(SharedArrayBuffer 需要) |
| `--no-web-security` | 关闭同源策略(仅本地素材调试) |
| `--smoke` `--duration` `--warmup` `--out` `--assert-*` | 无人值守压测(不给目标 = 宿主自检) |

`--profile` / `--angle` 的选择会持久化,下次启动自动沿用。

---

## 本地 webapp 走 `app://` 而不是 `file://`

三条硬理由:

1. `file://` 是不透明源,`localStorage` / `IndexedDB` / `SharedArrayBuffer` 全部不可用;
2. 构建产物里 `/assets/index.js` 这类根绝对路径在 `file://` 下会解析到磁盘根,直接 404;
3. ES module 脚本在 `file://` 下被 CORS 拒绝。

`app://` 注册为 standard + secure 自定义协议,页面拿到的是正常安全源,行为与线上一致。
附带:路径穿越防护、`Range` 透传(音视频 seek)、无扩展名路径回落到入口(SPA 路由)、
入口 HTML 永不缓存(改一行代码刷新就能看到)。

---

## 安全姿态

Deskapp 装载的是**你自己的构建产物**,不是任意网页。为了让显存记账能挂到页面主世界的
WebGL 原型上,被装载页面用 `contextIsolation: false` + `nodeIntegration: false` + `webSecurity: true`。

- 页面**拿不到** Node(`nodeIntegration: false`);
- 需要沙箱强度时用 `--no-probe`,它会开启 `contextIsolation` 并关掉插桩;
- Inspector 与启动器是另一套 preload,始终开启 `contextIsolation`。

**它是给自己人用的调试宿主,不是浏览器。别拿它开不受信的站点。**

---

## 出安装包(与 `--export` 的分工)

产出独立应用有两条路,**做的不是同一件事**:

| | `--export` | electron-builder |
|---|---|---|
| 产物 | `.app` / 可执行目录 | dmg · nsis · deb · AppImage |
| 依赖 | 无(拷骨架 + 注入) | 需要 builder 与其工具链 |
| 速度 | 秒级、离线 | 分钟级,可能要下载 |
| 用途 | 自己用、内部传递 | **对外分发**:签名、公证、自动更新 |

Deskapp 自身的安装包:

```bash
pnpm dist:mac       # arm64:dmg + zip → apps/mac-arm64/
pnpm dist:mac-x64   # Intel Mac      → apps/mac-x64/
pnpm dist:win       # nsis + zip     → apps/windows-x64/
pnpm dist:linux     # AppImage + deb → apps/linux-x64/
```

产物在 **`apps/<设备>/`**,与 `--export` 的导出物同处一地 —— 见 [apps/README.md](apps/README.md)。
macOS 默认不签名(`identity: null`);要分发到公司外部时配证书与公证。

> `directories.output` 用了 `apps/${os}-${arch}` 宏,但 electron-builder 仍会在里面再套一层
> 自己命名的目录(`mac-arm64/` / `win-unpacked/`),且**多架构一起构建时 `${arch}` 只解析成其中一个**,
> 另一个架构的安装包会落错目录。所以脚本一次只构建一个架构,构建后跑
> `scripts/flatten-apps.mjs` 把多余那层压平。

### 给某个项目出安装包

想把自己某个项目打成独立的安装包(而不是 Deskapp 自身),写一份自定义 builder 配置:
不同的 `appId` / `productName` / 图标,外加把项目的 `deskapp.json` 放进
`extraResources` 的资源根目录,然后:

```bash
electron-builder --mac --arm64 --config <你的配置>.yml && node scripts/flatten-apps.mjs
```

> **应用图标还是占位符**:`packaging/gen-icon.mjs` 生成的 Swiss 几何图形,不是任何品牌标识。
> 放一个 `resources/icon.png`(≥512²)electron-builder 会自动采用。注意这只影响安装包与
> App Bundle 本身——被装载 webapp 的 Dock 图标由它自己的 favicon / manifest 决定。

## 已知限制

- 档位与 ANGLE 后端是 Chromium 进程级开关,改了必须重启(面板会提示)。
- macOS 上 `max-perf` 无法解掉帧率上限(见上文,Chromium/Metal 的问题)。
- 远端 URL 目标的 manifest 在加载后才拿到,只影响标题与图标,窗口底色已经提交。
- 单个上下文丢失后,该上下文的记账清零并重新计入;多上下文页面在丢失瞬间读数会短暂偏低。
- 移动端不在范围内(需求明确排除)。
- smoke 需要真实显示器/虚拟显示器,无法完全 headless。

## 项目结构

```
src/
  main/            主进程:窗口、app:// 协议、项目清单、执行同意、托管进程、
                   档位、指标、崩溃恢复、导出、smoke
  preload/         被装载页面的 preload(探针 + window.deskapp)与 shell preload
  shell/           Inspector / 启动器 / 自绘标题栏 UI(原生 DOM,无框架)
  shared/          三方共享的类型与 IPC 频道定义
fixtures/
  stress/          自带压测台:校验显存记账 + 施加可控渲染压力
  sidecar/         托管后端的回归 fixture:会 spawn 孙子进程,验证进程树整棵回收
  project-demo/    项目协议四槽位的完整例子:入口 + 启动脚本 + 命令行 + 关闭脚本
  url-detach/      网址模式 + 脱离式启动脚本(脚本退出、服务留后台)的例子
packaging/
  gen-icon.mjs         占位图标生成器(零依赖手写 PNG)
```

---

## License

[MIT](LICENSE) © [InliSpwrad](https://github.com/Inlispwrad)
