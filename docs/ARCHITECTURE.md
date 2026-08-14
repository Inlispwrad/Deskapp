# 架构与设计决策

本文档是 Deskapp 的内部架构、统计口径与设计取舍。首页见 [README.md](../README.md),协议与 API 见 [PROTOCOL.md](PROTOCOL.md)。

## 目录

- [为什么是 Electron](#为什么是-electron)
- [App 模式:抹掉的浏览器痕迹](#app-模式抹掉的浏览器痕迹)
- [显存记账:口径与边界](#显存记账口径与边界)
- [帧率的口径:均值 vs 中位数](#帧率的口径均值-vs-中位数)
- [性能档位](#性能档位)
- [Inspector](#inspector)
- [无人值守压测 / CI 门禁](#无人值守压测--ci-门禁)
- [本地 webapp 走 `app://` 而不是 `file://`](#本地-webapp-走-app-而不是-file)
- [安全姿态](#安全姿态)
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

---

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

## 已知限制

- 档位与 ANGLE 后端是 Chromium 进程级开关,改了必须重启(面板会提示)。
- macOS 上 `max-perf` 无法解掉帧率上限(见上文,Chromium/Metal 的问题)。
- 远端 URL 目标的 manifest 在加载后才拿到,只影响标题与图标,窗口底色已经提交。
- 单个上下文丢失后,该上下文的记账清零并重新计入;多上下文页面在丢失瞬间读数会短暂偏低。
- 移动端不在范围内(需求明确排除)。
- smoke 需要真实显示器/虚拟显示器,无法完全 headless。

---

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
