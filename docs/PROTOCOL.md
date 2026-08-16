# 项目协议与 API 详解

本文档是 Deskapp 的完整协议与接口参考。首页见 [README.md](../README.md)。

## 目录

- [Web App Manifest(次要来源)](#web-app-manifest次要来源)
- [项目协议 `deskapp.json`](#项目协议-deskappjson)
- [导出成独立桌面应用](#导出成独立桌面应用)
- [`window.deskapp` —— webapp 对接面](#windowdeskapp--webapp-对接面)
- [命令行](#命令行)
- [出安装包(与 `--export` 的分工)](#出安装包与---export-的分工)

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
| `display: "fullscreen"` | 已忽略 —— 全屏是用户动作（F11 / 菜单），不由 manifest 默认开启 |
| `deskapp.width/height` | 初始窗口尺寸 |
| `deskapp.minWidth/minHeight` | 最小尺寸 |
| `deskapp.resizable` | 是否允许缩放 |
| `deskapp.aspectRatio` | 锁定宽高比(如 `1.7777`),`0` 不锁 |
| `deskapp.vramLimitMB` | 该应用的显存告警线 |

没有 manifest 也能跑:标题退化成目录名 + `document.title`,尺寸用上次关闭时的(按目标分别记忆)。

远端 URL 目标的 manifest 在页面加载完成后抓取,因此只影响标题与图标,底色已经提交了。

---

## 项目协议 `deskapp.json`

Deskapp 打开时是**项目选择器**(这是它自己的启动器)。选一个项目目录会**新开一个应用窗口**来运行；启动器窗口保留，因此可以同时打开多个装载。

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
        "fullscreen": false,                // 已忽略：全屏只能用户手动开（F11 / 菜单 / --fullscreen）
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

本地项目的页面跑在 `app://<项目根哈希>`,而它的服务在 `http://127.0.0.1:PORT` —— 这是**跨源**,
浏览器默认全拦。几乎每个带 `command` 的项目都会撞上,所以 Deskapp 自动给
**清单里 `readyUrl` 的那个源**补上 CORS 响应头。

放行范围严格限定在项目自己声明的那个源,不是"所有 localhost"。
局限:需要预检(OPTIONS)的请求还得服务端自己应答 OPTIONS ——
我们只能给响应补头,造不出一个服务端不给的响应。

---

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
| 改身份 | macOS:Info.plist(名称/标识/可执行名)+ `icon.icns`;Windows / Linux:可执行文件改名 |

于是导出是纯文件操作:离线可用、秒级完成、产物与"专属打包"完全同构。
实测产物体积:macOS 276MB,Windows 348MB。

`command` / `hooks` 的 `cwd` **不需要在导出时改写**:它们相对**内容根**(entry 所在目录)
解析,导出后 `entry` 指向 `project/`,内容根自然跟着走。

> **平台差异**:macOS 与 Windows 两条路径都经过实测 —— 导出物独立跑通了完整四槽位协议
> (入口装载 · 启动脚本 · 常驻命令行 · 关闭脚本)。Linux 用与 Windows 同一套拷贝注入逻辑,
> 但**未在实机验证过**。
> 另:Windows 的 exe 图标与产品名编在 PE 资源里,本导出方式改不了(窗口标题正确);
> Linux 的图标需要自行写 `.desktop` 条目。
> 这些局限会原样出现在导出完成的提示里,不藏着。

---

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

产物在 **`apps/<设备>/`**,与 `--export` 的导出物同处一地 —— 见 [apps/README.md](../apps/README.md)。
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
