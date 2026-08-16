/**
 * 宿主编排。
 *
 * 窗口结构（刻意做成「一个应用窗口 + 一个独立检查器窗口」）：
 *
 *   BaseWindow（应用窗口，原生边框，无自带 webContents）
 *     └── WebContentsView   ← 被装载的 webapp，永远 100% 铺满客户区
 *
 *   BrowserWindow（Inspector，按需打开，独立窗口）
 *     └── shell UI（工具栏 + 指标面板）
 *
 * 为什么 Inspector 是独立窗口而不是覆盖层：覆盖层会挤压或遮挡 webapp，
 * 画布尺寸随面板开合变化、输入被顶层视图吃掉 —— 那就"像在操作浏览器"了。
 * 独立窗口让应用窗口始终保持纯净，和 DevTools 的形态一致。
 *
 * 为什么 webapp 装在可替换的 WebContentsView 里而不是窗口自带的 webContents：
 * purge（彻底销毁渲染进程以释放 GPU 资源）需要能把整个渲染器扔掉再建，
 * 而窗口自带的 webContents 无法替换 —— 只能重建窗口，会闪、会丢窗口位置与全屏状态。
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
    BaseWindow,
    BrowserWindow,
    Menu,
    MenuItem,
    WebContentsView,
    app,
    dialog,
    nativeImage,
    net,
    screen,
    shell as electronShell,
    type WebContents,
} from 'electron';
import { CH, type PageCommand, type PageEvent, type ShellCommand } from '../shared/channels';
import type {
    AppTarget,
    HostAlert,
    HostSettings,
    HostState,
    ProbeSample,
    SystemSample,
    TitlebarMetrics,
    TitlebarState,
} from '../shared/types';
import { askExecutionConsent } from './consent';
import {
    defaultExportDir,
    exportProject,
    type ExportOptions,
    type ExportResult,
} from './export-app';
import {
    DEFAULT_ENTRY,
    contentRoot,
    createUrlProject,
    declaredExecution,
    loadProjectAt,
    mergeIdentity,
    projectIdentity,
    resolveEntry,
    toSidecarConfig,
    ManifestError,
    type LoadedProject,
} from './project';
import { runOnce } from './sidecar';
import type { CliOptions } from './cli';
import { Sidecar } from './sidecar';
import {
    addRecent,
    clearRecents,
    flushConfig,
    loadConfig,
    recallWindow,
    rememberWindow,
    saveConfig,
    targetKey,
} from './config';
import { IconCache } from './icon-cache';
import { collectGpuStatus } from './gpu-info';
import { sampleSystem } from './metrics';
import { filePathForAppUrl, setCrossOriginIsolated } from './protocol';
import { allowApiOrigin as addCorsOrigin, registerPageOrigin, unregisterPageOrigin } from './cors';
import {
    TargetError,
    parseRemoteManifest,
    readLocalManifest,
    resolveTarget,
    type AppManifest,
    type ResolvedTarget,
} from './target';

const PRELOAD_APP = join(__dirname, '../preload/index.js');
const PRELOAD_SHELL = join(__dirname, '../preload/shell.js');
const SHELL_HTML = join(__dirname, '../shell/index.html');

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
/** 连续崩溃保护窗口 */
const CRASH_WINDOW_MS = 60_000;
const CRASH_GIVE_UP = 3;

/** 应用窗口的兜底底色：manifest 没给 background_color 时用它，避免白闪。 */
const FALLBACK_BG = '#101014';

/** 自绘标题栏高度。 */
const TITLEBAR_HEIGHT = 40;
/** macOS 原生红绿灯占位：三个 12px 灯 + 间距，内容从这之后开始。 */
const MAC_TRAFFIC_INSET = 82;
/**
 * Windows 原生窗口控件叠加层宽度。
 *
 * 实测值：用 `navigator.windowControlsOverlay.getTitlebarAreaRect()` 在
 * Windows 11 (26200) + Electron 43 上量得 137 CSS px，
 * 强制 devicePixelRatio 1 / 1.25 / 1.5 / 2 四档结果为 137/138/137/137 ——
 * 也就是它按 CSS 像素恒定，不随 DPI 变，取上界 138 即可。
 *
 * 为什么只能写常量：叠加层的 WCO API 只对窗口顶层 webContents 可见，
 * 而这里的标题栏是 BaseWindow 的子 WebContentsView，在它里面
 * `windowControlsOverlay.visible === false`、rect 恒为 0，取不到真值。
 *
 * 宁可多留几像素也不能少留：少留会被三个原生按钮压住，多留只是右侧多点空白。
 */
const WIN_OVERLAY_INSET = 138;
/** 标题栏两侧的基础留白。 */
const TITLEBAR_PAD = 14;

type ViewMode = 'app' | 'launcher';

export class Host {
    win: BaseWindow | null = null;
    private view: WebContentsView | null = null;
    private viewMode: ViewMode = 'launcher';
    private inspector: BrowserWindow | null = null;
    /** 自绘标题栏（Deskapp 自己的 chrome，跨应用切换不重建） */
    private titlebar: WebContentsView | null = null;
    /** 是否使用自绘标题栏 —— 只看平台与命令行，建窗口前就要定 */
    private readonly customTitlebar: boolean;
    /** manifest 图标转成的 data URL，缓存避免每次推送都重新编码 */
    private iconDataUrl: string | null = null;
    /** 页面自己给的 favicon URL —— 标题栏图标优先用它（那才是"网页传进来的图标"） */
    private faviconUrl: string | null = null;
    /** 宿主托管的后端进程 */
    private sidecar: Sidecar | null = null;
    /** 渲染进程主线程是否被堵住（Electron 的 unresponsive 事件） */
    private pageUnresponsive = false;
    /** 当前项目（清单 + 根目录）。URL 快速装载时是一份空清单。 */
    private project: LoadedProject | null = null;
    /** 本次运行是否获准执行项目声明的命令 */
    private mayExecute = false;
    /** teardownProject 的幂等闸门 */
    private tornDown = false;
    /** dispose 的幂等闸门（窗口 X 关闭、shutdown、close 三条路都可能走到） */
    private disposed = false;
    /** 采用页面图标做应用图标（专属打包才开） */
    private iconCache: IconCache | null = null;

    private target: ResolvedTarget | null = null;
    private manifest: AppManifest | null = null;
    private settings: HostSettings;
    private state: HostState;

    private sampleTimer: ReturnType<typeof setInterval> | null = null;
    private lastSample: ProbeSample | null = null;
    private lastSystem: SystemSample | null = null;
    /** 最近一次发起加载的时刻，用来算"启动到首帧"耗时 */
    private loadStartedAt = 0;
    private alerts: HostAlert[] = [];
    private crashTimes: number[] = [];
    /** 越界告警只在跨越边界时报一次，不每个采样周期都刷 */
    private vramCrossed = false;
    private rssCrossed = false;

    /** smoke 模式的采样收集钩子 */
    onSample: ((s: ProbeSample) => void) | null = null;
    onSystemSample: ((s: SystemSample) => void) | null = null;
    onPageMark: ((name: string, t: number) => void) | null = null;
    consoleErrors: string[] = [];

    /**
     * 由 HostManager 注入的回调。
     * 启动器窗口点「打开项目」时不能就地装载，而是通知管理器新开一个应用窗口。
     */
    onOpenTargetRequest: ((input: string) => void) | null = null;
    onOpenUrlProjectRequest: ((
        input: { url: string; name?: string; startup?: string; shutdown?: string },
    ) => void) | null = null;
    onReturnLauncher: (() => void) | null = null;
    onOpenUrlInDeskapp: ((url: string) => void) | null = null;
    /** 窗口关闭后通知管理器移除本 Host。 */
    onClosed: (() => void) | null = null;

    private readonly isLauncherHost: boolean;
    /**
     * 宽松导航模式：用于「在 Deskapp 中打开」的额外窗口。
     * 登录/OAuth 流程经常要跳去 accounts.google.com 之类的外部域，
     * 这种窗口允许 http(s) 内部跳转，不再把每一步都当外链拦截。
     */
    private readonly relaxedNavigation: boolean;
    private readonly initialProject: LoadedProject | 'launcher' | null;

    /**
     * @param embedded 内嵌项目清单。导出出来的独立应用靠它自我识别
     *   （`<Resources>/deskapp.json`），从而与"打开本地项目"走同一条代码路径。
     */
    constructor(
        private cli: CliOptions,
        private embedded: LoadedProject | null = null,
        options: { initialProject?: LoadedProject | 'launcher'; relaxedNavigation?: boolean } = {},
    ) {
        this.initialProject = options.initialProject ?? null;
        this.relaxedNavigation = options.relaxedNavigation === true;
        this.isLauncherHost = this.initialProject === 'launcher';
        if (embedded?.manifest.runtime?.adoptPageIcon) {
            this.iconCache = new IconCache((level, message) => this.alert(level, 'icon', message));
        }

        // Linux 不支持 titleBarStyle，自绘条会叠在原生标题栏下面变成双层 —— 那里保留原生边框。
        // frameless / kiosk 本就是"要全出血"的意思，也不加。
        this.customTitlebar =
            !cli.frameless &&
            !cli.kiosk &&
            !cli.nativeTitlebar &&
            process.platform !== 'linux';

        const persisted = loadConfig();
        this.settings = {
            profile: cli.profile,
            angle: cli.angle,
            vramLimitMB: cli.vramLimitMB,
            rssLimitMB: cli.rssLimitMB,
            zoomFactor: cli.zoomFactor,
            sampleIntervalMs: cli.sampleIntervalMs,
            probeEnabled: cli.probe,
            crossOriginIsolated: cli.crossOriginIsolated,
            webSecurityDisabled: !cli.webSecurity,
            ...persisted.settings,
            // 命令行显式给出的值覆盖持久化值
            ...(cli.profileExplicit ? { profile: cli.profile } : {}),
            ...(cli.angleExplicit ? { angle: cli.angle } : {}),
        };
        setCrossOriginIsolated(this.settings.crossOriginIsolated);

        this.state = {
            target: null,
            loading: false,
            loadError: null,
            settings: this.settings,
            gpu: null,
            crashCount: 0,
            recents: persisted.recents,
            fullscreen: false,
            panelVisible: false,
            version: {
                deskapp: app.getVersion(),
                electron: process.versions.electron,
                chrome: process.versions.chrome,
                node: process.versions.node,
            },
        };
    }

    /* ==================== 启动 ==================== */

    async start(): Promise<void> {
        let project: LoadedProject | null = null;
        if (this.initialProject === 'launcher') {
            // 启动器窗口：不装载任何项目
            project = null;
        } else if (this.initialProject) {
            project = this.initialProject;
        } else {
            // 目标优先级：命令行 > 内嵌清单（导出的独立应用靠它自我识别）> 启动器
            if (this.cli.target !== null) {
                try {
                    project = this.projectFromInput(this.cli.target);
                } catch (err) {
                    this.alert(
                        'error',
                        'target',
                        err instanceof ManifestError ? err.message : String(err),
                    );
                }
            } else if (this.embedded) {
                project = this.embedded;
            }
        }

        // 先把项目解析出来，窗口才能一次就按正确的尺寸/底色/标题创建
        const prepared = project !== null && this.prepareProject(project);
        this.createWindow();

        if (prepared) await this.loadPrepared();
        else this.mountLauncher();

        if (this.cli.dev) this.toggleInspector(true);
        this.startSampling();

        void collectGpuStatus().then((gpu) => {
            this.state.gpu = gpu;
            for (const w of gpu.warnings) {
                this.alert(gpu.softwareRendering ? 'error' : 'warn', 'gpu', w);
            }
            this.pushState();
        });
    }

    /**
     * 窗口尺寸的决定顺序：命令行 > manifest.deskapp > 该应用上次关闭时的尺寸 > 默认。
     *
     * 关键是这三件事必须在**创建窗口之前**就定下来：尺寸、底色、标题。
     * 先建一个默认窗口再 resize 会让用户看到窗口跳一下 —— 桌面应用不会这样。
     */
    private createWindow(): void {
        const ext = this.manifest?.deskapp ?? {};
        const bounds = recallWindow(this.state.target);
        const width = this.cli.width ?? ext.width ?? bounds?.width ?? DEFAULT_WIDTH;
        const height = this.cli.height ?? ext.height ?? bounds?.height ?? DEFAULT_HEIGHT;

        this.win = new BaseWindow({
            // useContentSize：width/height 表示**网页视口**尺寸而不是窗口外框。
            // manifest 里写 1280×720 想表达的显然是"我要这么大的画布"，
            // 不是"算上标题栏一共这么高"。自绘标题栏的高度要额外加上去，
            // 否则 manifest 声明的高度会被标题栏吃掉一截。
            useContentSize: true,
            width: Math.round(width),
            height: Math.round(height) + (this.customTitlebar ? TITLEBAR_HEIGHT : 0),
            ...(bounds?.x !== undefined && bounds?.y !== undefined
                ? { x: bounds.x, y: bounds.y }
                : {}),
            minWidth: Math.round(ext.minWidth ?? 480),
            minHeight: Math.round(ext.minHeight ?? 320),
            show: false,
            // 底色取自 manifest：窗口一出现就是应用自己的颜色，没有白闪
            backgroundColor: this.manifest?.backgroundColor ?? FALLBACK_BG,
            frame: !this.cli.frameless,

            // 自绘标题栏：藏掉原生那条，但保留平台原生的窗口控件
            // （macOS 红绿灯 / Windows 控件叠加层）—— 自己画控件既难测又容易做错。
            // 拖拽区由自绘条自己声明 -webkit-app-region: drag，不再指望被装载页面提供。
            ...(this.customTitlebar ? { titleBarStyle: 'hidden' as const } : {}),
            ...(this.customTitlebar && process.platform === 'darwin'
                ? {
                      // 红绿灯垂直居中于 40px 条：(40 - 12) / 2 = 14
                      trafficLightPosition: { x: 14, y: 14 },
                      // 真毛玻璃只能来自系统级 vibrancy —— CSS backdrop-filter 跨不过
                      // WebContentsView 的合成边界。它模糊的是窗口背后的桌面，
                      // 也就是 Finder 工具栏那种正统观感。
                      vibrancy: 'header' as const,
                  }
                : {}),
            ...(this.customTitlebar && process.platform === 'win32'
                ? {
                      titleBarOverlay: {
                          color: '#00000000',
                          symbolColor: '#e6e7ec',
                          height: TITLEBAR_HEIGHT,
                      },
                      backgroundMaterial: 'acrylic' as const,
                  }
                : {}),

            title: this.appName(),
            resizable: ext.resizable !== false,
            // 全屏是用户动作，不由 manifest 默认开启；只有 --fullscreen 才在启动时全屏
            fullscreen: this.cli.fullscreen,
            kiosk: this.cli.kiosk,
            // 透明窗口会强制走慢速合成路径，性能宿主绝不能开
            transparent: false,
            autoHideMenuBar: true,
        });

        if (process.platform !== 'darwin') this.win.setMenuBarVisibility(false);
        if (ext.aspectRatio && ext.aspectRatio > 0) this.win.setAspectRatio(ext.aspectRatio);
        this.applyIcon();
        if (this.customTitlebar) this.createTitlebar();

        this.win.on('resize', () => this.layout());
        this.win.on('enter-full-screen', () => this.onFullscreenChange(true));
        this.win.on('leave-full-screen', () => this.onFullscreenChange(false));
        this.win.on('close', () => this.rememberBounds());
        this.win.on('closed', () => {
            this.win = null;
            this.dispose();
            // 用户直接关掉某一个应用窗口时，也要把该项目托管的进程树与 shutdown 脚本收掉。
            // teardownProject 幂等，和 shutdown() 里的调用不会跑两遍。
            void this.teardownProject();
            this.onClosed?.();
        });
        this.win.on('moved', () => this.rememberBounds());
        this.win.on('resized', () => this.rememberBounds());
    }

    /**
     * 按目标分别记住窗口尺寸 —— 不同应用本该有不同的窗口大小。
     *
     * 尺寸取**内容区**（与 useContentSize 对齐），位置取**窗口外框**
     * （x/y 选项吃的是外框坐标）。混用会让每次恢复都往下漂一个标题栏的高度。
     */
    private rememberBounds(): void {
        if (!this.win || this.win.isFullScreen() || this.win.isMinimized()) return;
        const outer = this.win.getBounds();
        const content = this.win.getContentBounds();
        rememberWindow(this.state.target, {
            width: content.width,
            // 减掉自绘标题栏，存的是"画布高度"，与 manifest / createWindow 口径一致
            height: content.height - (this.customTitlebar ? TITLEBAR_HEIGHT : 0),
            x: outer.x,
            y: outer.y,
            maximized: this.win.isMaximized(),
        });
    }

    private applyIcon(): void {
        this.iconDataUrl = null;
        if (!this.win) return;

        // 已缓存的页面图标优先于打包时塞的图标 —— 这就是"第一次运行以后才更新"：
        // 页面还没加载就已经是对的图标了，不用等 favicon 事件。
        const cached = this.iconCache?.load(targetKey(this.state.target)) ?? null;
        if (cached) {
            this.applyRuntimeIcon(cached);
            // 包内图标可能被重新打包重置回占位图 —— 判包内现状，而不是"本次有没有抓图标"
            if (this.iconCache && !this.iconCache.bundleIconInSync()) {
                const res = this.iconCache.installBundleIcon(cached);
                this.alert(
                    'info',
                    'icon',
                    res.ok
                        ? '包内启动图标与缓存不一致，已用缓存的页面图标重装'
                        : `启动图标未替换：${res.reason}`,
                );
            } else {
                this.alert('info', 'icon', '启动即使用已缓存的页面图标（未等页面加载）');
            }
            return;
        }

        const iconPath = this.manifest?.iconPath;
        if (!iconPath || /^https?:/i.test(iconPath) || !existsSync(iconPath)) return;
        const img = nativeImage.createFromPath(iconPath);
        if (img.isEmpty()) return;
        this.applyRuntimeIcon(img);
    }

    /** 设置运行中的 Dock / 窗口图标，并把它作为标题栏图标的兜底。 */
    private applyRuntimeIcon(img: Electron.NativeImage): void {
        if (process.platform === 'darwin') app.dock?.setIcon(img);
        else this.win?.setIcon(img);
        // 缩到标题栏用的尺寸再编码，避免把 1024² 的 PNG 反复塞进 IPC
        this.iconDataUrl = img.resize({ width: 32, height: 32, quality: 'best' }).toDataURL();
    }

    /**
     * 尽力把页面 favicon 变成窗口/任务栏图标（Windows / Linux）。
     * 标题栏图标已经用 Chromium 的 <img> 解码，SVG/ICO 都能显示；
     * 这里只是补任务栏图标，解码失败就保持原样，绝不打断页面。
     */
    private async applyFaviconToWindow(url: string): Promise<void> {
        if (!this.win || process.platform === 'darwin') return;
        try {
            let img: Electron.NativeImage | null = null;
            if (url.startsWith('data:')) {
                img = nativeImage.createFromDataURL(url);
            } else if (/^app:/i.test(url)) {
                const p = filePathForAppUrl(url);
                if (p) img = nativeImage.createFromPath(p);
            } else if (/^file:/i.test(url)) {
                const { fileURLToPath } = await import('node:url');
                img = nativeImage.createFromPath(fileURLToPath(url));
            } else if (/^https?:/i.test(url)) {
                const res = await net.fetch(url);
                if (res.ok) {
                    const buf = Buffer.from(await res.arrayBuffer());
                    img = nativeImage.createFromBuffer(buf);
                }
            }
            if (img && !img.isEmpty()) this.win?.setIcon(img);
        } catch {
            /* 任务栏图标更新失败可忽略 —— 标题栏图标才是主 UI */
        }
    }

    /**
     * 采用页面的 favicon 作为本应用图标：缓存 → 立即换 Dock 图标 → 尝试改 .app 的 icns。
     * 只在专属打包（bundle 里 adoptPageIcon 打开）时生效。
     */
    private async adoptPageIcon(url: string): Promise<void> {
        const cache = this.iconCache;
        if (!cache) return;
        const img = await cache.adopt(
            targetKey(this.state.target),
            url,
            this.manifest?.backgroundColor ?? null,
        );
        if (!img) return; // 图标没变，或者抓取失败（cache 内部已记日志）

        this.applyRuntimeIcon(img);
        this.pushTitlebar();

        const res = cache.installBundleIcon(img);
        this.alert(
            'info',
            'icon',
            res.ok
                ? '已用页面图标替换启动图标（Finder 的图标缓存可能要过一会儿才刷新）'
                : `启动图标未替换：${res.reason}`,
        );
    }

    /* ==================== 自绘标题栏 ==================== */

    private createTitlebar(): void {
        if (!this.win || this.titlebar) return;
        const view = new WebContentsView({
            webPreferences: {
                preload: PRELOAD_SHELL,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
                backgroundThrottling: false,
            },
        });
        // 透明背景，让窗口级的原生毛玻璃透上来
        view.setBackgroundColor('#00000000');
        this.titlebar = view;
        this.win.contentView.addChildView(view);
        void view.webContents.loadFile(SHELL_HTML, { query: { view: 'titlebar' } });
    }

    /** 标题栏占的高度。全屏时归零 —— 游戏该全出血。 */
    private chromeHeight(): number {
        if (!this.titlebar || !this.win) return 0;
        return this.win.isFullScreen() ? 0 : TITLEBAR_HEIGHT;
    }

    /** 当前窗口所在显示器的刷新率。 */
    private refreshHz(): number {
        const d = this.win
            ? screen.getDisplayMatching(this.win.getBounds())
            : screen.getPrimaryDisplay();
        return d.displayFrequency || 60;
    }

    private titlebarState(): TitlebarState {
        const alert = this.vramCrossed || this.rssCrossed || this.state.crashCount > 0;
        return {
            title: this.win?.getTitle() ?? this.appName(),
            // 优先页面自己的 favicon；没有才退回 manifest / 内嵌配置的图标
            iconUrl: this.faviconUrl ?? this.iconDataUrl,
            platform: process.platform as TitlebarState['platform'],
            insetLeft: process.platform === 'darwin' ? MAC_TRAFFIC_INSET : TITLEBAR_PAD,
            insetRight: process.platform === 'win32' ? WIN_OVERLAY_INSET : TITLEBAR_PAD,
            profile: this.settings.profile,
            alert,
        };
    }

    private pushTitlebar(): void {
        if (!this.titlebar || this.titlebar.webContents.isDestroyed()) return;
        this.titlebar.webContents.send(CH.titlebar, this.titlebarState());
    }

    private pushTitlebarMetrics(): void {
        if (!this.titlebar || this.titlebar.webContents.isDestroyed()) return;
        const sample = this.viewMode === 'app' ? this.lastSample : null;
        const frame = sample?.frame ?? null;
        const proc = this.lastSystem?.procs.find((p) => p.role === 'app');

        let fps: number | null = null;
        let mainThreadMs: number | null = null;

        if (this.pageUnresponsive) {
            // 主线程被堵住时 rAF 也停了，"没有帧"和"完全空闲"在数据上长得一样。
            // 这种情况绝不能报"一切正常" —— 否则最该看见的故障恰好被优化掉了。
            fps = 0;
            mainThreadMs = null;
        } else if (frame && frame.frames >= 3 && frame.p50Ms > 0) {
            // 用**中位数**而不是均值：均值对事件驱动的 DOM 应用是错的统计量
            // （实测典型 DOM 应用均值 19fps，而 p50=16.75ms —— 动的时候满帧）。
            // 中位数对两类应用都成立，也天然抗单次长帧干扰；长帧去 Inspector 看 p95/max。
            fps = 1000 / frame.p50Ms;
            mainThreadMs = frame.scriptAvgMs;
        } else if (sample && (sample.firstPaintAt > 0 || sample.firstFrameAt > 0)) {
            // 页面已经画出来、现在完全静止：它没有工作要做，也就没有任何阻塞。
            // 显示"—"会被读成"坏了"，显示均值会被读成"很卡"，都不对 ——
            // 事实是主线程 0ms、跑在显示器刷新率上限。
            // 判据用 firstPaintAt 而不是 firstFrameAt：静态页面从不调 rAF，
            // 只看 rAF 会把"画好了但不动"误判成"没渲染"。
            fps = this.refreshHz();
            mainThreadMs = 0;
        }

        const metrics: TitlebarMetrics = {
            fps,
            mainThreadMs,
            cpuPercent: proc ? proc.cpuPercent : null,
            memoryMB: proc ? proc.memoryMB : null,
        };
        this.titlebar.webContents.send(CH.titlebarMetrics, metrics);
    }

    private onFullscreenChange(value: boolean): void {
        this.state.fullscreen = value;
        // 全屏时标题栏收成 0 高，webapp 拿回整块客户区
        this.layout();
        this.sendPageEvent({ type: 'fullscreen-change', value });
        this.pushState();
    }

    /* ==================== 视图装载 ==================== */

    private destroyView(): void {
        if (!this.view) return;
        const wc = this.view.webContents;
        if (this.viewMode === 'app') {
            try {
                unregisterPageOrigin(wc.id);
            } catch {
                /* ignore */
            }
        }
        if (this.win) this.win.contentView.removeChildView(this.view);
        this.view = null;
        // close() 会走正常卸载流程；destroy 由 GC 处理
        if (!wc.isDestroyed()) wc.close();
    }

    private createView(mode: ViewMode): WebContentsView {
        this.destroyView();
        this.viewMode = mode;

        const isApp = mode === 'app';
        const view = new WebContentsView({
            webPreferences: {
                preload: isApp ? PRELOAD_APP : PRELOAD_SHELL,
                // 见 probe.ts 的说明：显存记账必须挂到页面主世界的 WebGL 原型上，
                // 隔离世界挂不上。Deskapp 装载的是自家构建产物，取插桩能力这一侧。
                contextIsolation: isApp ? !this.settings.probeEnabled : true,
                nodeIntegration: false,
                sandbox: false,
                backgroundThrottling: false,
                webgl: true,
                spellcheck: false,
                webSecurity: isApp ? !this.settings.webSecurityDisabled : true,
                // 重复启动同一应用时省掉 JS 重新编译
                v8CacheOptions: 'code',
                devTools: true,
            },
        });

        view.setBackgroundColor(this.manifest?.backgroundColor ?? FALLBACK_BG);
        this.view = view;
        if (isApp) {
            try {
                registerPageOrigin(view.webContents.id, this.pageOrigin());
            } catch {
                /* ignore */
            }
        }
        this.win?.contentView.addChildView(view);
        this.layout();

        if (isApp) this.wireAppView(view.webContents);
        else this.wireLauncherView(view.webContents);

        return view;
    }

    private layout(): void {
        if (!this.win) return;
        const { width, height } = this.win.getContentBounds();
        const chrome = this.chromeHeight();
        // 标题栏与 webapp 严格不重叠：重叠的话顶层视图会吃掉指针事件
        this.titlebar?.setBounds({ x: 0, y: 0, width, height: chrome });
        this.view?.setBounds({ x: 0, y: chrome, width, height: Math.max(0, height - chrome) });
    }

    private mountLauncher(): void {
        this.manifest = null;
        this.target = null;
        this.project = null;
        this.mayExecute = false;
        this.state.target = null;
        this.state.loadError = null;
        const view = this.createView('launcher');
        void view.webContents.loadFile(SHELL_HTML, { query: { view: 'launcher' } });
        this.win?.setTitle('Deskapp');
        this.showWindowOn(view.webContents);
        this.pushState();
    }

    /* ==================== 打开目标 ==================== */

    /**
     * 把用户给的东西（目录 / index.html / URL）变成一个「项目」。
     *
     * 最小协议就在这里体现：目录里只要有 index.html 就能打开，
     * 有 deskapp.json 则用它增强；URL 走一份空清单（除非内嵌清单正指着它）。
     */
    private projectFromInput(input: string): LoadedProject {
        if (/^https?:\/\//i.test(input)) {
            // 导出应用/专属打包指向远端时，内嵌清单才是它的身份来源
            if (this.embedded && this.embedded.manifest.entry === input) return this.embedded;
            return { manifest: { entry: input }, root: process.cwd(), manifestPath: null };
        }
        const abs = isAbsolute(input) ? input : resolve(process.cwd(), input);
        let isDir = false;
        try {
            isDir = statSync(abs).isDirectory();
        } catch {
            /* 不存在的路径交给下游 resolveTarget 报错 */
        }
        if (isDir) return loadProjectAt(abs);
        // 显式指到某个文件：以它所在目录为项目根，但入口用这个文件
        const loaded = loadProjectAt(dirname(abs));
        return { ...loaded, manifest: { ...loaded.manifest, entry: basename(abs) } };
    }

    /**
     * 解析项目并写入状态 —— 不触碰窗口与视图。
     * 拆出来是为了让「建窗口前」和「运行期换项目」两条路径共用同一份解析逻辑。
     */
    private prepareProject(project: LoadedProject): boolean {
        const entry = resolveEntry(project);
        if (!entry) {
            this.alert(
                'error',
                'target',
                `项目里找不到入口：${project.manifest.entry ?? 'index.html'}（根目录 ${project.root}）`,
            );
            return false;
        }

        let resolved: ResolvedTarget;
        try {
            resolved = resolveTarget(entry);
        } catch (err) {
            const msg = err instanceof TargetError ? err.message : String(err);
            this.alert('error', 'target', msg);
            return false;
        }

        this.project = project;
        this.tornDown = false;
        this.target = resolved;
        this.faviconUrl = null;
        this.pageUnresponsive = false;
        this.mayExecute = false;
        // deskapp.json 是显式声明，压过页面自带的 Web App Manifest
        this.manifest = mergeIdentity(projectIdentity(project), readLocalManifest(resolved));
        this.applyProjectRuntime(project);

        // 记住的是**项目根**而不是入口文件 —— 下次打开还是同一个项目，
        // 也避免同一个项目在最近列表里同时留下"根目录"和"index.html"两条。
        // 只有用户显式指到一个非默认入口文件时才记那个文件，否则会丢掉他的选择。
        const entryIsDefault =
            resolved.kind === 'dir' && resolved.value === join(project.root, DEFAULT_ENTRY);
        const recordRoot =
            Boolean(project.manifestPath) || entryIsDefault || resolved.value === project.root;
        const plain: AppTarget = {
            // kind 描述的是**记录下来的那个值**，不是入口类型。
            // 入口是 URL 但项目本身是一个目录（网址模式就是这样）时它仍然是本地项目：
            // 能进最近列表、能导出。按入口类型标成 url 会把导出入口错误地藏掉。
            kind: recordRoot ? 'dir' : resolved.kind,
            value: recordRoot ? project.root : resolved.value,
            resolvedUrl: resolved.resolvedUrl,
            label: this.appName(),
        };
        this.state.target = plain;
        this.state.recents = addRecent(plain);
        this.state.loadError = null;
        return true;
    }

    /**
     * 让 `app://` 页面能访问项目自己声明的那个本地服务。
     *
     * 为什么必须做：本地项目的页面跑在 `app://<项目根哈希>`，而它的服务在
     * `http://127.0.0.1:PORT` —— 这是**跨源**，浏览器默认全拦。
     * 几乎每个带 `command` 的项目都会撞上，让每个项目自己去加 CORS 头是转嫁成本。
     *
     * 放行范围严格限定在**项目清单里 readyUrl 的那个源**，不是"所有 localhost"。
     *
     * 局限：需要预检（OPTIONS）的请求还得服务端自己应答 OPTIONS ——
     * 我们只能给响应补头，造不出一个服务端不给的响应。
     */
    private allowApiOrigin(readyUrl: string | undefined): void {
        addCorsOrigin(readyUrl, this.pageOrigin());
    }

    /** 当前页面源：本地项目是 app://<root-hash>，URL 目标是 http(s) 源。 */
    private pageOrigin(): string {
        if (this.target) {
            try {
                const u = new URL(this.target.resolvedUrl);
                // Node 的 URL 对非 special scheme（如 app://）的 origin 会返回字符串 "null"，
                // 必须手动拼成 `app://<host>` 才是浏览器里真正的源。
                return u.protocol === 'app:' ? `${u.protocol}//${u.host}` : u.origin;
            } catch {
                /* fall through */
            }
        }
        return 'app://local';
    }

    /** 项目清单里的 runtime 段落 → 运行期设置。进程级开关只能提示重启。 */
    private applyProjectRuntime(project: LoadedProject): void {
        const r = project.manifest.runtime;
        if (!r) return;
        const patch: Partial<HostSettings> = {};
        if (typeof r.vramLimitMB === 'number' && r.vramLimitMB > 0) patch.vramLimitMB = r.vramLimitMB;
        if (typeof r.rssLimitMB === 'number' && r.rssLimitMB > 0) patch.rssLimitMB = r.rssLimitMB;
        if (typeof r.zoom === 'number' && r.zoom > 0) patch.zoomFactor = r.zoom;
        if (typeof r.sampleIntervalMs === 'number' && r.sampleIntervalMs >= 50) {
            patch.sampleIntervalMs = r.sampleIntervalMs;
        }
        if (typeof r.crossOriginIsolated === 'boolean') {
            patch.crossOriginIsolated = r.crossOriginIsolated;
        }
        Object.assign(this.settings, patch);
        setCrossOriginIsolated(this.settings.crossOriginIsolated);

        // profile / angle / webgpu 是 Chromium 进程级开关，运行期改不了
        if (r.profile && r.profile !== this.settings.profile) {
            this.alert(
                'warn',
                'profile',
                `项目要求 ${r.profile} 档，当前是 ${this.settings.profile} —— 档位是进程级开关，需带 --profile ${r.profile} 重启才生效`,
            );
        }
    }

    private async loadPrepared(): Promise<void> {
        const target = this.target;
        const project = this.project;
        if (!target || !project) return;
        this.state.loading = true;
        this.pushState();

        const view = this.createView('app');
        this.showWindowOn(view.webContents);

        const fail = async (message: string): Promise<void> => {
            this.state.loading = false;
            this.state.loadError = message;
            this.pushState();
            if (this.viewIsAlive()) {
                await this.view!.webContents.loadURL(errorPageUrl(message, target.resolvedUrl));
            }
        };

        // 项目声明了要执行的东西 → 先征求同意。清单是磁盘上的数据，不能默认就跑。
        const declared = declaredExecution(project);
        if (declared && this.cli.trustProject) {
            this.mayExecute = true;
            this.alert('info', 'consent', '--trust-project 已生效，跳过执行确认');
        } else if (declared) {
            const decision = await askExecutionConsent(project, declared, this.win);
            if (decision === null) {
                this.mountLauncher();
                return;
            }
            this.mayExecute = decision === 'run';
            if (!this.mayExecute) {
                this.alert('warn', 'consent', '按你的选择只装载页面，项目声明的命令不会执行');
            }
        }

        // ① 一次性启动脚本：跑完（成功）才继续
        if (this.mayExecute && project.manifest.hooks?.startup) {
            await view.webContents.loadURL(statusPageUrl('正在执行启动脚本…'));
            const ok = await this.runHook('startup', project.manifest.hooks.startup);
            if (!this.viewIsAlive()) return;
            if (!ok) {
                await fail('启动脚本执行失败。按 F12 打开 Inspector 看日志。');
                return;
            }
        }

        // ② 常驻命令行（服务）：拉起并等就绪。期间显示状态页而不是白屏或加载失败页。
        const sidecarCfg = this.mayExecute ? toSidecarConfig(project) : null;
        if (sidecarCfg) {
            this.allowApiOrigin(sidecarCfg.readyUrl);
            this.sidecar = new Sidecar(sidecarCfg, contentRoot(project), (level, message) => {
                // 服务日志进 Inspector 的日志面板；只有异常才升级成告警
                this.inspector?.webContents.send(CH.pageLog, {
                    level: level === 'info' ? 'warning' : level,
                    message,
                    source: 'server',
                    line: 0,
                });
                if (level === 'info') console.log(`[deskapp][server] ${message}`);
                else this.alert(level, 'server', message);
            });
            const t0 = Date.now();
            await view.webContents.loadURL(statusPageUrl('正在启动本地服务…'));
            const ok = await this.sidecar.ensureUp();
            if (!this.viewIsAlive()) return;
            if (!ok) {
                await fail('本地服务启动失败。按 F12 打开 Inspector 看服务日志。');
                return;
            }
            this.alert('info', 'server', `服务就绪耗时 ${Date.now() - t0}ms`);
        }

        this.loadStartedAt = Date.now();

        try {
            await view.webContents.loadURL(target.resolvedUrl);
        } catch (err) {
            // did-fail-load 已经处理过展示，这里只补日志
            this.alert('error', 'load', `加载失败：${String(err)}`);
        }
    }

    /** 跑一次性钩子。与 sidecar 共用 PATH 解析与进程组语义。 */
    private async runHook(kind: 'startup' | 'shutdown', line: string): Promise<boolean> {
        const project = this.project;
        if (!project) return false;
        const timeout = project.manifest.hooks?.timeoutMs ?? 120_000;
        this.alert('info', 'hook', `${kind} 脚本：${line}`);
        const res = await runOnce({ shellLine: line }, contentRoot(project), (level, message) => {
            this.inspector?.webContents.send(CH.pageLog, {
                level: level === 'info' ? 'warning' : level,
                message,
                source: `hook:${kind}`,
                line: 0,
            });
            if (level === 'info') console.log(`[deskapp][${kind}] ${message}`);
            else this.alert(level, 'hook', message);
        }, timeout);
        if (!res.ok) this.alert('error', 'hook', `${kind} 脚本失败（exit=${res.code}）`);
        return res.ok;
    }

    /**
     * 停掉当前项目托管的东西：先跑 shutdown 脚本，再收服务进程树。
     *
     * **必须幂等**：退出路径不止一条（窗口全关 → app.quit → before-quit，
     * 以及 smoke 显式调用），不设防会把 shutdown 脚本跑两遍。
     */
    private async teardownProject(): Promise<void> {
        if (this.tornDown) return;
        this.tornDown = true;
        const shutdown = this.project?.manifest.hooks?.shutdown;
        if (this.mayExecute && shutdown) {
            await this.runHook('shutdown', shutdown);
        }
        this.sidecar?.stop();
        this.sidecar = null;
    }

    /** 打开一个项目（目录 / index.html / URL）。窗口已存在时会重新套用清单里的窗口属性。 */
    async openTarget(input: string): Promise<void> {
        let project: LoadedProject;
        try {
            project = this.projectFromInput(input);
        } catch (err) {
            const msg = err instanceof ManifestError ? err.message : String(err);
            this.alert('error', 'target', msg);
            if (!this.target) this.mountLauncher();
            return;
        }

        // 换项目前把上一个项目托管的东西收干净
        await this.teardownProject();

        if (!this.prepareProject(project)) {
            if (!this.target) this.mountLauncher();
            return;
        }
        this.applyManifest();
        await this.loadPrepared();
    }

    /** 导出当前项目（或指定项目）为独立桌面应用。 */
    exportProjectTo(project: LoadedProject, options: ExportOptions): ExportResult {
        this.alert('info', 'export', `开始导出 → ${options.outDir}`);
        const res = exportProject(project, options, (message) => {
            this.alert('info', 'export', message);
        });
        if (!res.ok) this.alert('error', 'export', res.error ?? '导出失败');
        for (const c of res.caveats) this.alert('warn', 'export', c);
        return res;
    }

    getProject(): LoadedProject | null {
        return this.project;
    }

    /** dialog 的 parent 参数不接受 undefined，包一层免得每处都写分支。 */
    private messageBox(
        opts: Electron.MessageBoxOptions,
    ): Promise<Electron.MessageBoxReturnValue> {
        return this.win ? dialog.showMessageBox(this.win, opts) : dialog.showMessageBox(opts);
    }

    private appName(): string {
        return (
            this.cli.title ??
            this.manifest?.name ??
            this.manifest?.shortName ??
            this.target?.label ??
            'Deskapp'
        );
    }

    /** 运行期换应用时，把 manifest 的窗口属性应用到已存在的窗口上。 */
    private applyManifest(): void {
        if (!this.win) return;
        const ext = this.manifest?.deskapp ?? {};

        this.win.setTitle(this.appName());
        this.applyIcon();

        const remembered = recallWindow(this.state.target);
        const w = this.cli.width ?? ext.width ?? remembered?.width;
        const h = this.cli.height ?? ext.height ?? remembered?.height;
        if (w && h) {
            // 与 useContentSize 对齐：这里比较/设置的都是内容区尺寸（含标题栏）
            const wantW = Math.round(w);
            const wantH = Math.round(h) + this.chromeHeight();
            const cur = this.win.getContentSize();
            if (cur[0] !== wantW || cur[1] !== wantH) {
                this.win.setContentSize(wantW, wantH);
                this.win.center();
            }
        }
        this.win.setMinimumSize(Math.round(ext.minWidth ?? 480), Math.round(ext.minHeight ?? 320));
        this.win.setResizable(ext.resizable !== false);
        this.win.setAspectRatio(ext.aspectRatio && ext.aspectRatio > 0 ? ext.aspectRatio : 0);

    }

    /**
     * DOM 就绪即显示窗口：底色已由 manifest 设对，看不到白闪。
     *
     * smoke 模式同样显示窗口 —— 隐藏窗口不参与合成，rAF 会被 Chromium 掐到接近 0，
     * 量出来的帧数据毫无意义。CI 上要跑就配显示器（Linux 用 xvfb-run）。
     */
    private showWindowOn(wc: WebContents): void {
        if (!this.win) return;
        const win = this.win;
        let shown = false;
        const show = () => {
            if (shown || win.isDestroyed()) return;
            shown = true;
            win.show();
            win.focus();
        };
        wc.once('dom-ready', show);
        // 页面卡死也不能留一个看不见的窗口
        setTimeout(show, 3000);
    }

    /* ==================== 被装载页面的接线 ==================== */

    private wireAppView(wc: WebContents): void {
        this.applyAppLikeBehavior(wc);

        wc.on('did-finish-load', () => {
            this.state.loading = false;
            this.pushState();
            this.pushProbeConfig();
            if (this.target?.kind === 'url') void this.fetchRemoteManifest(wc);
        });

        wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
            if (!isMainFrame) return;
            this.state.loading = false;
            this.state.loadError = `${desc} (${code}) — ${url}`;
            this.alert('error', 'load', this.state.loadError);
            this.pushState();
            void wc.loadURL(errorPageUrl(this.state.loadError, url));
        });

        wc.on('page-title-updated', (_e, title) => {
            // 页面自己声明的标题优先（和原生应用一致），除非命令行显式覆盖
            if (!this.cli.title && title) this.win?.setTitle(title);
            this.pushTitlebar();
        });

        wc.on('render-process-gone', (_e, details) => {
            this.handleCrash(details.reason, details.exitCode);
        });

        wc.on('unresponsive', () => {
            this.pageUnresponsive = true;
            this.pushTitlebarMetrics();
            this.alert('warn', 'unresponsive', '渲染进程无响应（主线程被长任务阻塞）');
        });

        wc.on('responsive', () => {
            this.pageUnresponsive = false;
            this.pushTitlebarMetrics();
            this.alert('info', 'unresponsive', '渲染进程恢复响应');
        });

        // 标题栏图标要的是"网页传进来的图标" —— favicon 才是那个东西。
        // manifest 的 icons 是应用级声明（Dock 图标用它），favicon 是当前页面的身份。
        wc.on('page-favicon-updated', (_e, favicons) => {
            // app:// 页面的 favicon 也是 app:// —— 必须放行，那才是内容自己的图标
            const url = favicons.find((u) => /^(https?|data|file|app):/i.test(u));
            if (url && url !== this.faviconUrl) {
                this.faviconUrl = url;
                this.pushTitlebar();
                void this.adoptPageIcon(url);
                void this.applyFaviconToWindow(url);
            }
        });

        wc.on('console-message', (details) => {
            const level = details.level;
            if (level !== 'warning' && level !== 'error') return;
            const entry = {
                level,
                message: details.message,
                source: details.sourceId ?? '',
                line: details.lineNumber ?? 0,
            };
            if (level === 'error') {
                this.consoleErrors.push(details.message);
                if (this.consoleErrors.length > 200) this.consoleErrors.shift();
            }
            this.inspector?.webContents.send(CH.pageLog, entry);
        });

        wc.setVisualZoomLevelLimits(1, 1).catch(() => undefined);
        wc.setZoomFactor(this.settings.zoomFactor);
    }

    /**
     * 抹掉一切"我在浏览器里"的痕迹。
     * 这些行为单独看都很小，凑在一起就是"这是个应用"和"这是个网页"的差别。
     */
    private applyAppLikeBehavior(wc: WebContents): void {
        // window.open 不弹一个像浏览器的新窗口。外链先问用户：
        // 用默认浏览器打开（登录态不在 Deskapp 里），还是再开一个 Deskapp 窗口装载
        // （同一 session，登录 cookie 能回流到原页面）。
        wc.setWindowOpenHandler(({ url }) => {
            if (/^https?:/i.test(url)) void this.promptExternalOpen(wc, url);
            return { action: 'deny' };
        });

        // 站外跳转一律拦下；站内导航（SPA 路由、reload）放行。
        // 这同时挡掉了"把文件拖进窗口 → 导航到 file:// 打开它"这个浏览器行为。
        wc.on('will-navigate', (event, url) => {
            if (this.isInsideApp(url)) return;
            event.preventDefault();
            if (/^https?:/i.test(url)) void this.promptExternalOpen(wc, url);
        });

        wc.on('before-input-event', (event, input) => {
            if (input.type !== 'keyDown') return;
            const mod = process.platform === 'darwin' ? input.meta : input.control;
            const key = input.key.toLowerCase();

            /* --- Deskapp 自己的快捷键 --- */
            if (key === 'f11' || (process.platform === 'darwin' && mod && input.control && key === 'f')) {
                event.preventDefault();
                this.toggleFullscreen();
                return;
            }
            if (key === 'f12' || (mod && input.alt && key === 'i')) {
                event.preventDefault();
                this.toggleInspector();
                return;
            }
            if (mod && input.shift && key === 'r') {
                event.preventDefault();
                this.reload(true);
                return;
            }
            if (mod && input.shift && key === 'p') {
                event.preventDefault();
                void this.purge();
                return;
            }
            if (key === 'escape' && this.win?.isFullScreen() && !this.cli.kiosk) {
                event.preventDefault();
                this.win.setFullScreen(false);
                return;
            }

            /* --- 屏蔽浏览器味道的组合键 --- */
            if (!mod) return;
            // 缩放：桌面应用不该被 Ctrl+滚轮 / Ctrl± 改变画布尺寸
            if (key === '=' || key === '+' || key === '-' || key === '0') {
                event.preventDefault();
                return;
            }
            // 打印 / 页内查找 / 查看源码 / 地址栏 / 新窗口 / 历史前后退
            if (['p', 'f', 'g', 'u', 'l', 'n', 'j', 'h', '[', ']'].includes(key)) {
                event.preventDefault();
                return;
            }
            // 刷新：应用模式下不给，dev 模式（Inspector 开着）放行
            if ((key === 'r' || key === 'f5') && !this.inspector) {
                event.preventDefault();
            }
        });

        // dev 模式给一个最小右键菜单；应用模式 Electron 本来就没有默认菜单
        wc.on('context-menu', (_e, params) => {
            if (!this.inspector) return;
            const menu = new Menu();
            menu.append(
                new MenuItem({
                    label: '检查元素',
                    click: () => wc.inspectElement(params.x, params.y),
                }),
            );
            menu.append(new MenuItem({ label: '重新加载', click: () => this.reload(false) }));
            menu.popup();
        });
    }

    private isInsideApp(url: string): boolean {
        // 宽松导航：额外开的登录窗口允许在 http(s) 域间跳转（OAuth 需要）
        if (this.relaxedNavigation && /^https?:/i.test(url)) return true;
        const base = this.target?.resolvedUrl;
        if (!base) return false;
        try {
            const a = new URL(url);
            const b = new URL(base);
            return a.protocol === b.protocol && a.host === b.host;
        } catch {
            return false;
        }
    }

    /**
     * 页面请求打开外部地址（window.open / 站外跳转）时，让用户决定去向。
     * 选择「在 Deskapp 中打开」会通知管理器新开一个独立窗口 —— 每个窗口的
     * 监控、告警、采样各自独立，互不污染。
     * 选择「在当前页面打开」则让当前应用窗口直接跳过去（登录态留在当前页面）。
     */
    private async promptExternalOpen(wc: WebContents, url: string): Promise<void> {
        try {
            const res = await this.messageBox({
                type: 'question',
                title: '这个页面想打开一个外部地址',
                message: url,
                detail:
                    '用默认浏览器打开，登录状态不会回到 Deskapp；' +
                    '在 Deskapp 新窗口打开，共享登录会话，但原页面不会变成登录后的状态；' +
                    '在当前页面打开，则把当前应用窗口直接导航过去。',
                buttons: ['用默认浏览器打开', '在 Deskapp 新窗口打开', '在当前页面打开', '取消'],
                defaultId: 0,
                cancelId: 3,
                noLink: true,
            });
            if (res.response === 0) {
                void electronShell.openExternal(url);
            } else if (res.response === 1) {
                this.onOpenUrlInDeskapp?.(url);
            } else if (res.response === 2) {
                if (!wc.isDestroyed()) void wc.loadURL(url);
            }
        } catch {
            /* 用户可能已经关了窗口；静默 */
        }
    }

    private wireLauncherView(wc: WebContents): void {
        wc.setWindowOpenHandler(({ url }) => {
            if (/^https?:/i.test(url)) void electronShell.openExternal(url);
            return { action: 'deny' };
        });
        // 启动器自己的报错也要能被自检抓到，否则 shell UI 挂了没人知道
        wc.on('console-message', (details) => {
            if (details.level !== 'error') return;
            this.consoleErrors.push(details.message);
            if (this.consoleErrors.length > 200) this.consoleErrors.shift();
            this.alert('error', 'launcher', details.message);
        });
    }

    /** 远端目标的 manifest 只能在加载后由页面代取。 */
    private async fetchRemoteManifest(wc: WebContents): Promise<void> {
        // deskapp.json 是显式声明，优先级高于远端页面自己的 Web App Manifest
        if (this.project && projectIdentity(this.project)) return;
        try {
            const raw = (await wc.executeJavaScript(
                `(async () => {
                    const link = document.querySelector('link[rel="manifest"]');
                    const href = link ? link.getAttribute('href') : '/manifest.json';
                    try {
                        const r = await fetch(new URL(href, location.href), { credentials: 'omit' });
                        return r.ok ? await r.text() : null;
                    } catch { return null; }
                })()`,
            )) as string | null;
            if (!raw) return;
            const m = parseRemoteManifest(raw, wc.getURL());
            if (!m) return;
            this.manifest = m;
            this.applyManifest();
            this.pushState();
        } catch {
            /* 远端没有 manifest 是常态，静默 */
        }
    }

    /* ==================== 崩溃与恢复 ==================== */

    private handleCrash(reason: string, exitCode: number): void {
        const now = Date.now();
        this.crashTimes = this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS);
        this.crashTimes.push(now);
        this.state.crashCount++;

        const isOom = reason === 'oom';
        this.alert(
            'error',
            isOom ? 'oom' : 'crash',
            isOom
                ? `渲染进程 OOM 被杀（第 ${this.state.crashCount} 次）。webapp 内存越过了系统/V8 上限。`
                : `渲染进程退出：reason=${reason} exitCode=${exitCode}（第 ${this.state.crashCount} 次）`,
        );
        this.pushState();

        if (this.crashTimes.length >= CRASH_GIVE_UP) {
            this.alert(
                'error',
                'crash-loop',
                `${CRASH_WINDOW_MS / 1000}s 内崩溃 ${this.crashTimes.length} 次，停止自动重建。修好问题后手动 reload。`,
            );
            return;
        }
        if (this.cli.smoke) return;

        const backoff = 300 * this.crashTimes.length;
        setTimeout(() => {
            if (this.target) void this.openTarget(this.target.value);
        }, backoff);
    }

    /* ==================== 采样与告警 ==================== */

    private startSampling(): void {
        this.stopSampling();
        this.sampleTimer = setInterval(() => this.tickSampling(), this.settings.sampleIntervalMs);
    }

    private stopSampling(): void {
        if (this.sampleTimer) clearInterval(this.sampleTimer);
        this.sampleTimer = null;
    }

    private tickSampling(): void {
        const appPid = this.viewIsAlive() ? safePid(this.view!.webContents) : null;
        const shellPid = this.inspector ? safePid(this.inspector.webContents) : null;
        const sys = sampleSystem({ app: appPid, shell: shellPid });
        this.lastSystem = sys;
        this.onSystemSample?.(sys);
        this.inspector?.webContents.send(CH.system, sys);
        this.pushTitlebarMetrics();

        if (sys.appRendererMB > this.settings.rssLimitMB) {
            if (!this.rssCrossed) {
                this.rssCrossed = true;
                this.alert(
                    'warn',
                    'rss',
                    `webapp 渲染进程 RSS ${sys.appRendererMB.toFixed(0)}MB 越过告警线 ${this.settings.rssLimitMB}MB`,
                );
            }
        } else if (sys.appRendererMB < this.settings.rssLimitMB * 0.9) {
            this.rssCrossed = false;
        }
    }

    /** preload 上报的采样。 */
    handleProbeSample(sample: ProbeSample): void {
        this.lastSample = sample;
        this.onSample?.(sample);
        this.inspector?.webContents.send(CH.sample, sample);
        this.pushTitlebarMetrics();

        const vramMB = sample.vram.total / (1024 * 1024);
        if (vramMB > this.settings.vramLimitMB) {
            if (!this.vramCrossed) {
                this.vramCrossed = true;
                this.alert(
                    'error',
                    'vram',
                    `显存记账 ${vramMB.toFixed(1)}MB 越过 ${this.settings.vramLimitMB}MB 告警线。` +
                        `记账值是下界，真实占用只会更高 —— 移动端浏览器越过 400MB 通常直接崩溃重启。`,
                );
            }
        } else if (vramMB < this.settings.vramLimitMB * 0.9) {
            this.vramCrossed = false;
        }

        for (const e of sample.glErrors) this.alert('warn', 'gl', e);
    }

    /** preload 装好探针就下发配置，比 did-finish-load 更早。 */
    handlePageReady(): void {
        this.pushProbeConfig();
    }

    private pushProbeConfig(): void {
        if (!this.viewIsAlive() || this.viewMode !== 'app') return;
        const display = this.win
            ? screen.getDisplayMatching(this.win.getBounds())
            : screen.getPrimaryDisplay();
        const hz = display.displayFrequency || 60;
        this.view!.webContents.send(CH.probeConfig, {
            enabled: this.settings.probeEnabled,
            intervalMs: this.settings.sampleIntervalMs,
            budgetMs: 1000 / hz,
            profile: this.settings.profile,
            deskappVersion: app.getVersion(),
        });
    }

    alert(level: HostAlert['level'], code: string, message: string): void {
        const a: HostAlert = { level, code, message, t: Date.now() };
        this.alerts.push(a);
        if (this.alerts.length > 200) this.alerts.shift();
        const tag = level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN ' : 'INFO ';
        console.log(`[deskapp][${tag}][${code}] ${message}`);
        this.inspector?.webContents.send(CH.alert, a);
    }

    getAlerts(): HostAlert[] {
        return this.alerts;
    }

    getLastSample(): ProbeSample | null {
        return this.lastSample;
    }

    getLastSystem(): SystemSample | null {
        return this.lastSystem;
    }

    getLoadStartedAt(): number {
        return this.loadStartedAt;
    }

    getState(): HostState {
        this.state.settings = this.settings;
        this.state.panelVisible = this.inspector !== null;
        this.state.fullscreen = this.win?.isFullScreen() ?? false;
        return this.state;
    }

    private pushState(): void {
        this.inspector?.webContents.send(CH.state, this.getState());
        if (this.viewMode === 'launcher' && this.viewIsAlive()) {
            this.view!.webContents.send(CH.state, this.getState());
        }
        this.pushTitlebar();
    }

    /** shell 侧（Inspector / 启动器 / 标题栏）就绪时补齐一次全量数据。 */
    handleShellReady(sender: WebContents): void {
        sender.send(CH.state, this.getState());
        sender.send(CH.titlebar, this.titlebarState());
        if (this.lastSample) sender.send(CH.sample, this.lastSample);
        if (this.lastSystem) sender.send(CH.system, this.lastSystem);
        for (const a of this.alerts.slice(-40)) sender.send(CH.alert, a);
        this.pushTitlebarMetrics();
    }

    private sendPageEvent(ev: PageEvent): void {
        if (this.viewMode === 'app' && this.viewIsAlive()) {
            this.view!.webContents.send(CH.pageEvent, ev);
        }
    }

    private viewIsAlive(): boolean {
        return this.view !== null && !this.view.webContents.isDestroyed();
    }

    /** 窗口是否仍然存在（HostManager 用）。 */
    isAlive(): boolean {
        return this.win !== null && !this.win.isDestroyed();
    }

    /** IPC 路由用：这个 WebContents 是否属于本 Host。 */
    owns(wc: WebContents): boolean {
        return (
            this.view?.webContents === wc ||
            this.inspector?.webContents === wc ||
            this.titlebar?.webContents === wc
        );
    }

    /* ==================== 命令 ==================== */

    reload(hard: boolean): void {
        if (!this.viewIsAlive()) return;
        if (hard) this.view!.webContents.reloadIgnoringCache();
        else this.view!.webContents.reload();
    }

    /**
     * purge —— 彻底销毁渲染进程再重建。
     * 与 reload 的区别：reload 复用渲染进程，GPU 侧资源与 V8 堆的碎片都留着；
     * purge 把整个进程扔掉，是唯一能真正把显存与堆归零的手段。
     */
    async purge(): Promise<void> {
        if (!this.target) return;
        this.sendPageEvent({ type: 'before-purge' });
        this.alert('info', 'purge', '销毁渲染进程并重建（彻底释放 GPU 与堆）');
        const value = this.target.value;
        this.destroyView();
        // 给渲染进程一点时间走完卸载
        await new Promise((r) => setTimeout(r, 120));
        await this.openTarget(value);
    }

    async collectGarbage(): Promise<void> {
        if (!this.viewIsAlive()) return;
        try {
            const ok = (await this.view!.webContents.executeJavaScript(
                'typeof gc === "function" ? (gc(), true) : false',
            )) as boolean;
            this.alert(
                ok ? 'info' : 'warn',
                'gc',
                ok ? '已触发一次 V8 GC' : 'gc() 不可用（--expose-gc 未生效）',
            );
        } catch (err) {
            this.alert('warn', 'gc', `GC 失败：${String(err)}`);
        }
    }

    toggleFullscreen(): void {
        if (!this.win) return;
        this.win.setFullScreen(!this.win.isFullScreen());
    }

    toggleInspector(force?: boolean): void {
        const want = force ?? this.inspector === null;
        if (!want) {
            this.inspector?.close();
            return;
        }
        if (this.inspector) {
            this.inspector.focus();
            return;
        }
        const appBounds = this.win?.getBounds();
        const display = appBounds
            ? screen.getDisplayMatching(appBounds)
            : screen.getPrimaryDisplay();
        this.inspector = new BrowserWindow({
            width: 460,
            height: Math.min(900, display.workArea.height - 60),
            x: appBounds ? appBounds.x + appBounds.width + 12 : undefined,
            y: appBounds ? appBounds.y : undefined,
            title: 'Deskapp Inspector',
            backgroundColor: '#0e0f13',
            show: false,
            webPreferences: {
                preload: PRELOAD_SHELL,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: false,
            },
        });
        this.inspector.once('ready-to-show', () => this.inspector?.show());
        this.inspector.on('closed', () => {
            this.inspector = null;
            this.pushState();
        });
        void this.inspector.loadFile(SHELL_HTML, { query: { view: 'inspector' } });
        this.pushState();
    }

    openDevTools(): void {
        if (!this.viewIsAlive()) return;
        this.view!.webContents.openDevTools({ mode: 'detach' });
    }

    async pickDirectory(): Promise<void> {
        const res = await dialog.showOpenDialog({
            title: '选择项目目录（含 index.html，可选 deskapp.json）',
            properties: ['openDirectory'],
        });
        if (res.canceled || res.filePaths.length === 0) return;
        if (this.isLauncherHost && this.onOpenTargetRequest) {
            this.onOpenTargetRequest(res.filePaths[0]);
            return;
        }
        await this.openTarget(res.filePaths[0]);
    }

    /**
     * 网址模式：以 URL 为入口新建项目并打开。
     *
     * 只填网址、不填脚本时不落盘 —— 那就是"看一眼某个地址"，没必要留下一个项目目录。
     * 一旦填了启动/关闭脚本或名称，就必须持久化，否则那些声明下次就没了。
     */
    private async openUrlProject(input: {
        url: string;
        name?: string;
        startup?: string;
        shutdown?: string;
    }): Promise<void> {
        const url = input.url.trim();
        if (!/^https?:\/\//i.test(url)) {
            this.alert('error', 'target', `不是合法的网址：${url}`);
            return;
        }
        const persist = Boolean(
            input.name?.trim() || input.startup?.trim() || input.shutdown?.trim(),
        );
        if (!persist) {
            await this.openTarget(url);
            return;
        }
        try {
            const project = createUrlProject(join(app.getPath('userData'), 'projects'), input);
            this.alert('info', 'project', `已创建网址项目：${project.root}`);
            await this.teardownProject();
            if (!this.prepareProject(project)) return;
            this.applyManifest();
            await this.loadPrepared();
        } catch (err) {
            this.alert(
                'error',
                'project',
                err instanceof ManifestError ? err.message : String(err),
            );
        }
    }

    /**
     * 导出项目为独立桌面应用。dir 省略则导当前打开的项目。
     * 让用户选输出目录，完成后在 Finder / 文件管理器里指出产物。
     */
    async exportViaDialog(dir?: string): Promise<void> {
        let project: LoadedProject | null = null;
        if (dir) {
            try {
                project = loadProjectAt(dir);
            } catch (err) {
                this.alert(
                    'error',
                    'export',
                    err instanceof ManifestError ? err.message : String(err),
                );
                return;
            }
        } else {
            project = this.project;
        }
        if (!project || !project.manifestPath) {
            // 没清单也能导，但必须有个本地根目录 —— URL 项目导不出（没有文件可打包）
            if (!project || !existsSync(join(project.root, 'index.html'))) {
                this.alert(
                    'error',
                    'export',
                    '只能导出本地项目（目录里要有 index.html 或 deskapp.json）。URL 目标没有文件可打包。',
                );
                return;
            }
        }

        const suggested = project.manifest.name ?? basename(project.root);
        const pickOpts = {
            title: `导出「${suggested}」为独立应用 —— 选择输出目录`,
            // 默认落在项目内的 apps/<设备>/，与 pnpm dist:* 的产物同处
            defaultPath: defaultExportDir(),
            properties: ['openDirectory', 'createDirectory'] as Array<
                'openDirectory' | 'createDirectory'
            >,
            buttonLabel: '导出到这里',
        };
        const picked = this.win
            ? await dialog.showOpenDialog(this.win, pickOpts)
            : await dialog.showOpenDialog(pickOpts);
        if (picked.canceled || picked.filePaths.length === 0) return;

        const res = this.exportProjectTo(project, {
            outDir: picked.filePaths[0],
            overwrite: true,
        });

        if (res.ok && res.output) {
            const detail = res.caveats.length
                ? `注意：\n${res.caveats.map((c) => `· ${c}`).join('\n')}`
                : '双击即可运行，不需要任何参数。';
            const done = await this.messageBox({
                type: 'info',
                title: '导出完成',
                message: `${res.appName} 已导出`,
                detail: `${res.output}\n\n${detail}`,
                buttons: ['在文件管理器中显示', '好'],
                defaultId: 0,
                noLink: true,
            });
            if (done.response === 0) electronShell.showItemInFolder(res.output);
        } else {
            await this.messageBox({
                type: 'error',
                title: '导出失败',
                message: res.error ?? '未知错误',
                buttons: ['好'],
            });
        }
    }

    /**
     * 把一个临时网址晋升成 URL 项目，并走导出对话框。
     * 与 openUrlProject 的区别：这里不是为了装载，而是为了让它变成可导出的应用。
     */
    async exportUrlProject(url: string): Promise<void> {
        const clean = url.trim();
        if (!/^https?:\/\//i.test(clean)) {
            this.alert('error', 'project', `不是合法的网址：${clean}`);
            return;
        }
        try {
            const project = createUrlProject(join(app.getPath('userData'), 'projects'), {
                url: clean,
            });
            this.alert('info', 'project', `已将临时网址晋升为项目：${project.root}`);
            await this.exportViaDialog(project.root);
        } catch (err) {
            this.alert(
                'error',
                'project',
                err instanceof ManifestError ? err.message : String(err),
            );
        }
    }

    async captureScreenshot(): Promise<Buffer | null> {
        if (!this.viewIsAlive()) return null;
        try {
            const img = await this.view!.webContents.capturePage();
            return img.isEmpty() ? null : img.toPNG();
        } catch {
            return null;
        }
    }

    async captureTitlebar(): Promise<Buffer | null> {
        if (!this.titlebar || this.titlebar.webContents.isDestroyed()) return null;
        try {
            const img = await this.titlebar.webContents.capturePage();
            return img.isEmpty() ? null : img.toPNG();
        } catch {
            return null;
        }
    }

    async captureInspector(): Promise<Buffer | null> {
        if (!this.inspector || this.inspector.isDestroyed()) return null;
        try {
            const img = await this.inspector.webContents.capturePage();
            return img.isEmpty() ? null : img.toPNG();
        } catch {
            return null;
        }
    }

    applySettings(patch: Partial<HostSettings>): void {
        const prev = this.settings;
        this.settings = { ...prev, ...patch };
        // 走 saveConfig 而不是直接改缓存：否则只有在别的写入顺带 flush 时才落盘
        saveConfig({ settings: { ...loadConfig().settings, ...patch } });
        setCrossOriginIsolated(this.settings.crossOriginIsolated);

        if (patch.sampleIntervalMs && patch.sampleIntervalMs !== prev.sampleIntervalMs) {
            this.startSampling();
        }
        if (patch.zoomFactor !== undefined && this.viewIsAlive()) {
            this.view!.webContents.setZoomFactor(patch.zoomFactor);
        }
        this.pushProbeConfig();

        const needsRelaunch =
            (patch.profile !== undefined && patch.profile !== prev.profile) ||
            (patch.angle !== undefined && patch.angle !== prev.angle);
        if (needsRelaunch) {
            this.alert(
                'info',
                'profile',
                'GPU 档位与 ANGLE 后端是 Chromium 进程级开关，需要重启 Deskapp 才生效（下次启动自动应用）。',
            );
        }
        this.pushState();
    }

    handlePageCommand(cmd: PageCommand): unknown {
        switch (cmd.type) {
            case 'info':
                return {
                    version: app.getVersion(),
                    profile: this.settings.profile,
                    platform: process.platform,
                };
            case 'set-fullscreen':
                this.win?.setFullScreen(cmd.value);
                return undefined;
            case 'set-window-size':
                this.win?.setContentSize(Math.round(cmd.width), Math.round(cmd.height));
                return undefined;
            case 'set-title':
                this.win?.setTitle(cmd.title);
                return undefined;
            case 'mark':
                this.onPageMark?.(cmd.name, Date.now());
                this.alert('info', 'mark', `页面标记：${cmd.name}`);
                return undefined;
            case 'request-reload':
                this.reload(false);
                return undefined;
            case 'request-quit':
                app.quit();
                return undefined;
            case 'open-external':
                if (/^https?:/i.test(cmd.url)) void electronShell.openExternal(cmd.url);
                return undefined;
            case 'log':
                this.alert(cmd.level, 'page', cmd.message);
                return undefined;
            default:
                return undefined;
        }
    }

    async handleShellCommand(cmd: ShellCommand): Promise<unknown> {
        switch (cmd.type) {
            case 'get-state':
                return this.getState();
            case 'open-dir':
            case 'open-project':
                await this.pickDirectory();
                return undefined;
            case 'export-project':
                await this.exportViaDialog(cmd.dir);
                return undefined;
            case 'export-url-project':
                await this.exportUrlProject(cmd.url);
                return undefined;
            case 'create-url-project':
                if (this.isLauncherHost && this.onOpenUrlProjectRequest) {
                    this.onOpenUrlProjectRequest({
                        url: cmd.url,
                        name: cmd.name,
                        startup: cmd.startup,
                        shutdown: cmd.shutdown,
                    });
                } else {
                    await this.openUrlProject(cmd);
                }
                return undefined;
            case 'open-url':
                if (this.isLauncherHost && this.onOpenTargetRequest) {
                    this.onOpenTargetRequest(cmd.url);
                } else {
                    await this.openTarget(cmd.url);
                }
                return undefined;
            case 'open-target':
                if (this.isLauncherHost && this.onOpenTargetRequest) {
                    this.onOpenTargetRequest(cmd.target.value);
                } else {
                    await this.openTarget(cmd.target.value);
                }
                return undefined;
            case 'return-launcher':
                this.onReturnLauncher?.();
                return undefined;
            case 'reload':
                this.reload(cmd.hard === true);
                return undefined;
            case 'purge':
                await this.purge();
                return undefined;
            case 'gc':
                await this.collectGarbage();
                return undefined;
            case 'devtools':
                this.openDevTools();
                return undefined;
            case 'shell-devtools':
                this.inspector?.webContents.openDevTools({ mode: 'detach' });
                return undefined;
            case 'toggle-fullscreen':
                this.toggleFullscreen();
                return undefined;
            case 'toggle-panel':
                this.toggleInspector();
                return undefined;
            case 'set-settings':
                this.applySettings(cmd.patch);
                return undefined;
            case 'clear-recents':
                this.state.recents = clearRecents();
                this.pushState();
                return undefined;
            case 'screenshot': {
                const png = await this.captureScreenshot();
                if (!png) {
                    this.alert('warn', 'screenshot', '截图失败：没有可截的页面');
                    return undefined;
                }
                const res = await dialog.showSaveDialog({
                    title: '保存截图',
                    defaultPath: `deskapp-${Date.now()}.png`,
                    filters: [{ name: 'PNG', extensions: ['png'] }],
                });
                if (res.canceled || !res.filePath) return undefined;
                const { writeFileSync } = await import('node:fs');
                writeFileSync(res.filePath, png);
                this.alert('info', 'screenshot', `已保存到 ${res.filePath}`);
                return undefined;
            }
            default:
                return undefined;
        }
    }

    /* ==================== 关闭 ==================== */

    /**
     * 退出前的完整收尾：跑项目的 shutdown 脚本，再收掉一切。
     * 与 close() 分开是因为脚本是异步的 —— 调用方要 preventDefault 再等它。
     */
    async shutdown(): Promise<void> {
        await this.teardownProject();
        this.close();
    }

    close(): void {
        this.dispose();
        if (this.win) {
            this.win.close();
        } else {
            this.onClosed?.();
        }
    }

    private dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        // 先收后端：它是我们拉起来的，不能留成孤儿占着端口
        this.sidecar?.stop();
        this.stopSampling();
        this.inspector?.close();
        this.inspector = null;
        this.destroyView();
        if (this.titlebar && !this.titlebar.webContents.isDestroyed()) {
            this.titlebar.webContents.close();
        }
        this.titlebar = null;
        flushConfig();
    }
}

function safePid(wc: WebContents): number | null {
    try {
        return wc.getOSProcessId();
    } catch {
        return null;
    }
}

/** 后端启动期间显示的状态页。窗口底色已由 manifest 设对，所以这里只放一行字。 */
function statusPageUrl(message: string): string {
    const html = `<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: dark }
  body { margin:0; height:100vh; display:grid; place-items:center; background:${FALLBACK_BG};
         color:#8b8e9a; font:12px/1.6 "Helvetica Neue", Helvetica, system-ui, sans-serif;
         letter-spacing:.09em; text-transform:uppercase; user-select:none }
  .bar { width:180px; height:2px; background:#23262f; margin-top:14px; overflow:hidden }
  .bar i { display:block; width:60px; height:100%; background:#e30613;
           animation:slide 1.1s linear infinite }
  @keyframes slide { from { transform:translateX(-60px) } to { transform:translateX(180px) } }
  .box { text-align:center }
</style>
<div class="box">${escapeHtml(message)}<div class="bar"><i></i></div></div>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function errorPageUrl(message: string, url: string): string {
    const html = `<!doctype html><meta charset="utf-8">
<style>
  :root { color-scheme: dark }
  body { margin:0; height:100vh; display:grid; place-items:center; background:${FALLBACK_BG};
         color:#e6e6ea; font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif }
  .box { max-width:560px; padding:32px }
  h1 { font-size:16px; margin:0 0 12px; font-weight:600 }
  code { display:block; margin-top:12px; padding:12px; border-radius:8px;
         background:#1a1b21; color:#f2a; font-size:12px; word-break:break-all }
  p { color:#9a9aa4; margin:0 }
</style>
<div class="box">
  <h1>加载失败</h1>
  <p>${escapeHtml(message)}</p>
  <code>${escapeHtml(url)}</code>
</div>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
    );
}
