/**
 * 主进程 / preload / shell UI 三方共享的数据契约。
 * 这里只放纯类型，不引入任何运行时依赖（三方的打包目标不同）。
 */

/** 性能档位 —— 决定 Chromium 命令行开关集合。 */
export type PerfProfile = 'balanced' | 'max-perf' | 'compat';

/** ANGLE 后端覆盖（不填走平台默认）。 */
export type AngleBackend = 'default' | 'gl' | 'd3d11' | 'd3d9' | 'metal' | 'vulkan' | 'swiftshader';

/** 显存记账明细（字节）。 */
export interface VramBreakdown {
    /** WebGL 纹理（含各 mip level 与 generateMipmap 推算量） */
    textures: number;
    /** WebGL renderbuffer（深度 / 模板 / MSAA color） */
    renderbuffers: number;
    /** WebGL buffer（VBO / IBO / UBO） */
    buffers: number;
    /** WebGPU 纹理 */
    gpuTextures: number;
    /** WebGPU buffer */
    gpuBuffers: number;
    /** 以上合计 */
    total: number;
    /** 历史峰值 */
    peak: number;
}

/** 帧时序统计（毫秒）。 */
export interface FrameStats {
    /** 采样窗口内的实际帧率 */
    fps: number;
    /** 采样窗口内的帧数 */
    frames: number;
    /** 帧间隔均值 */
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    maxMs: number;
    /** 帧间隔超过 1.5 × 目标帧预算的帧数（卡顿计数） */
    longFrames: number;
    /** rAF 回调自身耗时（= 游戏逻辑 + 提交渲染命令的主线程开销）均值 */
    scriptAvgMs: number;
    scriptMaxMs: number;
    /** 目标帧预算（ms），由显示器刷新率推算 */
    budgetMs: number;
    /** 最近若干帧的帧间隔，供 UI 画图（峰值优先降采样）；每次采样后清空 */
    intervals: number[];
    /**
     * 帧间隔直方图，桶宽 {@link HIST_BUCKET_MS}，最后一个桶是溢出桶。
     * 降采样后的 intervals 偏向峰值，不能用来算分位数；跨采样窗口求全局分位数必须用这个。
     */
    hist: number[];
}

/** 帧间隔直方图桶宽（ms）。 */
export const HIST_BUCKET_MS = 0.5;
/** 直方图桶数（含最后的溢出桶）：0~64ms + 溢出。 */
export const HIST_BUCKETS = 129;

/** 被装载页面的 WebGL 上下文信息。 */
export interface GlContextInfo {
    webglVersion: 1 | 2;
    renderer: string;
    vendor: string;
    maxTextureSize: number;
    /** 页面创建过的 WebGL 上下文数量（>1 通常是泄漏或多 canvas） */
    contexts: number;
}

/** 页面内 GPU 资源对象存活数量 —— 用于抓泄漏。 */
export interface GlObjectCounts {
    textures: number;
    buffers: number;
    renderbuffers: number;
    framebuffers: number;
    programs: number;
}

/** preload 探针每个采样周期上报一次。 */
export interface ProbeSample {
    /** performance.timeOrigin + now，用于对齐主进程时间轴 */
    t: number;
    /**
     * 页面第一个 rAF 回调的绝对时间（epoch ms）；没调过 rAF 就是 0。
     * ⚠️ 它**不能**用来判断"页面有没有渲染"：完全静态的页面从不调 rAF，
     * 但画面早就画出来了。判渲染要用 {@link firstPaintAt}。
     */
    firstFrameAt: number;
    /**
     * 首次内容绘制的绝对时间（epoch ms），来自 Paint Timing API；未绘制则为 0。
     * 这才是"页面到底有没有画出来"的权威信号 —— 与是否使用 rAF 无关。
     */
    firstPaintAt: number;
    frame: FrameStats;
    vram: VramBreakdown;
    /** 采样窗口内每帧平均 draw call */
    drawCallsAvg: number;
    /** 采样窗口内单帧最大 draw call */
    drawCallsMax: number;
    gl: GlContextInfo | null;
    counts: GlObjectCounts;
    /** performance.memory（仅 Chromium 提供） */
    heap: { usedMB: number; totalMB: number; limitMB: number } | null;
    /** 页面通过 deskapp.report() 上报的自定义指标 */
    custom: Record<string, number>;
    /** 页面 WebGL 报错（gl.getError 非零 / context lost 等），最多保留最近若干条 */
    glErrors: string[];
}

/** 单个 Chromium 进程的资源占用。 */
export interface ProcMetric {
    pid: number;
    /** Electron 的进程类型：Browser / Tab / GPU / Utility ... */
    type: string;
    /** Deskapp 赋予的可读角色 */
    role: 'browser' | 'app' | 'shell' | 'gpu' | 'other';
    name: string;
    cpuPercent: number;
    memoryMB: number;
}

/** 主进程侧的系统采样。 */
export interface SystemSample {
    t: number;
    procs: ProcMetric[];
    /** 被装载 webapp 渲染进程的 RSS */
    appRendererMB: number;
    /** GPU 进程 RSS（VRAM 的粗略交叉验证参考，非 VRAM 本身） */
    gpuProcessMB: number;
    /** 所有 Deskapp 进程合计 */
    totalMB: number;
}

/** GPU 能力与软渲染检测结果。 */
export interface GpuStatus {
    glRenderer: string;
    glVendor: string;
    glVersion: string;
    angleBackend: string;
    featureStatus: Record<string, string>;
    /** true = 落到了 SwiftShader / 软件光栅化，性能结论全部不可信 */
    softwareRendering: boolean;
    warnings: string[];
}

/** 被装载目标的描述。 */
export interface AppTarget {
    kind: 'dir' | 'url';
    /** kind=dir 时是本地绝对路径；kind=url 时是完整 URL */
    value: string;
    /** 实际交给 Chromium 的 URL */
    resolvedUrl: string;
    label: string;
}

/** 运行期可变的宿主设置。 */
export interface HostSettings {
    profile: PerfProfile;
    angle: AngleBackend;
    /** 显存告警线（MB）—— 默认 400 */
    vramLimitMB: number;
    /** 渲染进程 RSS 告警线（MB） */
    rssLimitMB: number;
    /** 页面缩放（devicePixelRatio 覆盖）；1 = 不缩放 */
    zoomFactor: number;
    /** 探针采样周期（ms） */
    sampleIntervalMs: number;
    /** 是否启用页面内插桩 */
    probeEnabled: boolean;
    /** 是否开启跨源隔离（COOP/COEP，SharedArrayBuffer 需要） */
    crossOriginIsolated: boolean;
    /** 是否关闭 web security（本地素材调试用逃生门） */
    webSecurityDisabled: boolean;
}

/** 自绘标题栏需要的全部信息。 */
export interface TitlebarState {
    title: string;
    /**
     * 标题栏图标。优先是页面自己的 favicon URL（http(s)/data/file），
     * 没有才退回 manifest / 内嵌配置图标转成的 data URL。都没有时前端画红方块占位。
     */
    iconUrl: string | null;
    platform: 'darwin' | 'win32' | 'linux';
    /** 左侧要让开的像素 —— macOS 原生红绿灯占的位置 */
    insetLeft: number;
    /** 右侧要让开的像素 —— Windows 原生窗口控件叠加层占的位置 */
    insetRight: number;
    /** 当前 GPU 档位，flush-right 的数据位 */
    profile: PerfProfile;
    /** 有未消解的告警（显存越线 / 崩溃过）时底边换成红色实条 */
    alert: boolean;
}

/**
 * 标题栏右侧的实时指标（约 2Hz 推送，全部是**被装载 app 自己**的数据）。
 * 与 {@link TitlebarState} 分开：那个是身份信息（低频），这个是数据（高频）。
 */
export interface TitlebarMetrics {
    /**
     * 帧率。三种来源，见 Host.pushTitlebarMetrics：
     *   有帧 → 帧间隔中位数推算；完全静止 → 显示器刷新率上限；主线程被堵 → 0。
     */
    fps: number | null;
    /**
     * 主线程每帧脚本耗时（ms）。
     * 这才是"响应性"的真实读数 —— CPU% 高不一定卡，主线程被长任务堵住才卡。
     * 页面完全静止时为 0（没有工作要做，也就没有任何阻塞）。
     */
    mainThreadMs: number | null;
    /** webapp 渲染进程 CPU 占用 % */
    cpuPercent: number | null;
    /** webapp 渲染进程 RSS（MB） */
    memoryMB: number | null;
}

/** 一次告警。 */
export interface HostAlert {
    level: 'info' | 'warn' | 'error';
    code: string;
    message: string;
    t: number;
}

/** 宿主状态（shell UI 的唯一数据源）。 */
export interface HostState {
    target: AppTarget | null;
    loading: boolean;
    /** 页面加载失败信息 */
    loadError: string | null;
    settings: HostSettings;
    gpu: GpuStatus | null;
    /** 渲染进程崩溃/重建次数 */
    crashCount: number;
    recents: AppTarget[];
    fullscreen: boolean;
    panelVisible: boolean;
    version: { deskapp: string; electron: string; chrome: string; node: string };
}

/** smoke 模式的报告结构。 */
export interface SmokeReport {
    ok: boolean;
    target: string;
    profile: PerfProfile;
    durationSec: number;
    /**
     * 排除在稳态统计之外的预热时长。
     * 预热期的数据不是被丢掉了 —— 它单独进 {@link SmokeReport.startup}：
     * "启动多久出第一帧"和"稳定后掉不掉帧"是两个问题，混在一个平均值里两个都看不清。
     */
    warmupSec: number;
    /** 启动阶段（预热期内）的指标 */
    startup: {
        /** 从发起加载到首次内容绘制的毫秒数（静态页面也有这个值） */
        toFirstPaintMs: number;
        /** 从发起加载到第一个 rAF 回调的毫秒数；页面不用 rAF 时为 -1 */
        toFirstFrameMs: number;
        /** 预热期内最长的一帧（ms）——资源解码 / shader 编译的真实代价 */
        maxFrameMs: number;
        /** 预热期内的长帧数 */
        longFrames: number;
    };
    gpu: GpuStatus | null;
    frame: {
        fps: number;
        avgMs: number;
        p50Ms: number;
        p95Ms: number;
        p99Ms: number;
        maxMs: number;
        longFrames: number;
        totalFrames: number;
    };
    vramPeakMB: number;
    vramFinalMB: number;
    rendererPeakRssMB: number;
    gpuProcessPeakRssMB: number;
    drawCallsMax: number;
    /** 页面通过 deskapp.report() 自报的指标（取最后一次采样） */
    custom: Record<string, number>;
    /** 最后一次采样时各进程的资源占用 */
    procs: ProcMetric[];
    glErrors: string[];
    consoleErrors: string[];
    alerts: HostAlert[];
    crashCount: number;
    failures: string[];
    screenshot: string | null;
}
