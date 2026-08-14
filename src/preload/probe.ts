/**
 * 页面内插桩探针 —— 运行在被装载页面的**主世界**（contextIsolation: false）。
 *
 * 为什么必须在主世界：显存记账要挂 `WebGLRenderingContext.prototype` 上的方法。
 * 隔离世界拿到的是另一份原型链，挂不上；CDP 注入又会和 DevTools 抢 debugger 客户端。
 * 所以 Deskapp 对被装载页面统一用 `contextIsolation: false` + `nodeIntegration: false`
 * ——它是给自己人用的调试宿主，不是浏览器沙箱。
 *
 * 三类插桩：
 *   ① 帧时序：包 requestAnimationFrame，取帧间隔与回调自身耗时
 *   ② 显存记账：影子绑定状态 + 包所有会分配 GPU 内存的调用（按上下文分账）
 *   ③ draw call 计数：包 draw* 系列
 */

import {
    HIST_BUCKETS,
    HIST_BUCKET_MS,
    type FrameStats,
    type GlContextInfo,
    type GlObjectCounts,
    type ProbeSample,
    type VramBreakdown,
} from '../shared/types';
import {
    mipChainBytes,
    renderbufferBytesPerPixel,
    texBytesPerPixel,
    wgpuTextureBytes,
} from './gl-format-size';

type AnyGL = WebGLRenderingContext | WebGL2RenderingContext;
type Fn = (...args: never[]) => unknown;

const TEXTURE0 = 0x84c0;
const TEXTURE_CUBE_MAP = 0x8513;
const CUBE_FACE_FIRST = 0x8515;
const CUBE_FACE_LAST = 0x851a;
const UNSIGNED_BYTE = 0x1401;

/** 采样窗口内保留的帧间隔上限；超出后丢最旧的（防止页面卡死时无限增长）。 */
const MAX_WINDOW_FRAMES = 2048;
/** 回传给 UI 画图的帧间隔条数上限。 */
const MAX_GRAPH_POINTS = 240;
/** 保留的 GL 事件/错误条数。 */
const MAX_GL_ERRORS = 16;

/* ============================ 帧时序 ============================ */

let budgetMs = 1000 / 60;
/** 采样窗口内的帧间隔（ms） */
let intervals: number[] = [];
/** 采样窗口内每帧的 rAF 回调总耗时（ms） */
let scriptMs: number[] = [];

/** 当前帧的 rAF 时间戳；-1 = 还没开始 */
let curFrameTs = -1;
/** 当前帧累计的回调耗时 */
let curFrameScript = 0;
/** 当前帧起始时的累计 draw call 数 */
let curFrameDrawStart = 0;

let drawCallsTotal = 0;
/** 采样窗口内的逐帧 draw call */
let frameDrawCalls: number[] = [];
/** 页面第一个 rAF 回调的绝对时间（epoch ms）；0 = 没调过 rAF */
let firstFrameAt = 0;

/**
 * 首次内容绘制的绝对时间（epoch ms）。
 *
 * 为什么需要它：rAF 只能证明"页面在做动画"，证明不了"页面画出来了"。
 * 一个完全静态的 HTML 从不调 rAF，但画面早就在屏幕上 —— 只看 rAF 会误判成"没渲染"。
 * Paint Timing 与是否使用 rAF 无关，是判渲染的唯一可靠信号。
 */
function firstPaintAt(): number {
    try {
        const entries = performance.getEntriesByType('paint');
        const fcp = entries.find((e) => e.name === 'first-contentful-paint') ?? entries[0];
        return fcp ? performance.timeOrigin + fcp.startTime : 0;
    } catch {
        return 0;
    }
}

/** 一帧结束时结算上一帧的累计量。 */
function closeFrame(): void {
    if (curFrameTs < 0) return;
    scriptMs.push(curFrameScript);
    frameDrawCalls.push(drawCallsTotal - curFrameDrawStart);
    if (scriptMs.length > MAX_WINDOW_FRAMES) scriptMs.shift();
    if (frameDrawCalls.length > MAX_WINDOW_FRAMES) frameDrawCalls.shift();
}

function installFrameHooks(): void {
    const raw = window.requestAnimationFrame;
    if (typeof raw !== 'function') return;

    window.requestAnimationFrame = function deskappRaf(cb: FrameRequestCallback): number {
        return raw.call(window, (ts: number) => {
            if (firstFrameAt === 0) firstFrameAt = performance.timeOrigin + ts;
            // 同一帧里可能注册了多个 rAF 回调，时间戳相同 —— 只有时间戳变化才算新帧
            if (ts !== curFrameTs) {
                closeFrame();
                if (curFrameTs >= 0) {
                    intervals.push(ts - curFrameTs);
                    if (intervals.length > MAX_WINDOW_FRAMES) intervals.shift();
                }
                curFrameTs = ts;
                curFrameScript = 0;
                curFrameDrawStart = drawCallsTotal;
            }
            const t0 = performance.now();
            try {
                cb(ts);
            } finally {
                curFrameScript += performance.now() - t0;
            }
        });
    };
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

function downsample(src: number[], max: number): number[] {
    if (src.length <= max) return src.slice();
    const out: number[] = [];
    const step = src.length / max;
    for (let i = 0; i < max; i++) {
        // 取区间内最大值 —— 画图要看的是尖峰，不是平均后被抹平的曲线
        const from = Math.floor(i * step);
        const to = Math.min(src.length, Math.floor((i + 1) * step));
        let peak = src[from] ?? 0;
        for (let j = from + 1; j < to; j++) if (src[j] > peak) peak = src[j];
        out.push(peak);
    }
    return out;
}

function buildHistogram(values: number[]): number[] {
    const hist = new Array<number>(HIST_BUCKETS).fill(0);
    const overflow = HIST_BUCKETS - 1;
    for (const v of values) {
        const idx = Math.floor(v / HIST_BUCKET_MS);
        hist[idx >= overflow || idx < 0 ? overflow : idx]++;
    }
    return hist;
}

function takeFrameStats(): FrameStats {
    const ivs = intervals;
    const scripts = scriptMs;
    intervals = [];
    scriptMs = [];

    const sorted = ivs.slice().sort((a, b) => a - b);
    const sum = ivs.reduce((a, b) => a + b, 0);
    const longThreshold = budgetMs * 1.5;
    let longFrames = 0;
    for (const v of ivs) if (v > longThreshold) longFrames++;

    let scriptSum = 0;
    let scriptMax = 0;
    for (const v of scripts) {
        scriptSum += v;
        if (v > scriptMax) scriptMax = v;
    }

    return {
        fps: sum > 0 ? (ivs.length / sum) * 1000 : 0,
        frames: ivs.length,
        avgMs: ivs.length ? sum / ivs.length : 0,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
        maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
        longFrames,
        scriptAvgMs: scripts.length ? scriptSum / scripts.length : 0,
        scriptMaxMs: scriptMax,
        budgetMs,
        intervals: downsample(ivs, MAX_GRAPH_POINTS),
        hist: buildHistogram(ivs),
    };
}

/* ============================ 显存记账 ============================ */

/**
 * 记账**按 WebGL 上下文分开**，不是一本全局账。
 *
 * 原因是实测踩到的：Pixi（以及很多库）会先建一个临时上下文探测硬件能力，
 * 然后主动 `loseContext()` 丢掉它。如果记一本全局账、"任一上下文丢失就清零"，
 * 那次无害的临时丢弃会把真实上下文的账一起抹掉，显存读数直接变成假的。
 * 分账之后，丢失的上下文只带走它自己那部分。
 */
interface CtxAccount {
    textures: number;
    renderbuffers: number;
    buffers: number;
    counts: GlObjectCounts;
}

/** WebGPU 的账是全局的（没有"当前上下文"概念，设备生命周期由页面自己管） */
const wgpu = { textures: 0, buffers: 0 };
let vramPeak = 0;

function newAccount(): CtxAccount {
    return {
        textures: 0,
        renderbuffers: 0,
        buffers: 0,
        counts: { textures: 0, buffers: 0, renderbuffers: 0, framebuffers: 0, programs: 0 },
    };
}

interface CtxState {
    version: 1 | 2;
    activeUnit: number;
    /** 归一化 target → 各纹理单元上绑定的对象 */
    tex: Map<number, Array<WebGLTexture | null>>;
    buf: Map<number, WebGLBuffer | null>;
    rb: WebGLRenderbuffer | null;
    acc: CtxAccount;
    lost: boolean;
    info: GlContextInfo | null;
}

const ctxStates = new WeakMap<AnyGL, CtxState>();
/** 求和需要遍历，所以额外持一份强引用数组（页面里上下文只有个位数） */
const allCtx: CtxState[] = [];

function stateOf(gl: AnyGL): CtxState {
    let st = ctxStates.get(gl);
    if (!st) {
        const isV2 =
            typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
        st = {
            version: isV2 ? 2 : 1,
            activeUnit: 0,
            tex: new Map(),
            buf: new Map(),
            rb: null,
            acc: newAccount(),
            lost: false,
            info: null,
        };
        ctxStates.set(gl, st);
        allCtx.push(st);
    }
    return st;
}

function liveTotals(): { textures: number; renderbuffers: number; buffers: number } {
    let textures = 0;
    let renderbuffers = 0;
    let buffers = 0;
    for (const st of allCtx) {
        if (st.lost) continue;
        textures += st.acc.textures;
        renderbuffers += st.acc.renderbuffers;
        buffers += st.acc.buffers;
    }
    return { textures, renderbuffers, buffers };
}

function liveCounts(): GlObjectCounts {
    const out: GlObjectCounts = {
        textures: 0,
        buffers: 0,
        renderbuffers: 0,
        framebuffers: 0,
        programs: 0,
    };
    for (const st of allCtx) {
        if (st.lost) continue;
        out.textures += st.acc.counts.textures;
        out.buffers += st.acc.counts.buffers;
        out.renderbuffers += st.acc.counts.renderbuffers;
        out.framebuffers += st.acc.counts.framebuffers;
        out.programs += st.acc.counts.programs;
    }
    return out;
}

function vramTotal(): number {
    const s = liveTotals();
    return s.textures + s.renderbuffers + s.buffers + wgpu.textures + wgpu.buffers;
}

function touchPeak(): void {
    const t = vramTotal();
    if (t > vramPeak) vramPeak = t;
}

/** 一层纹理的几何信息，供 generateMipmap 精确推算 mip 链。 */
interface LevelDims {
    w: number;
    h: number;
    d: number;
    bpp: number;
}

/** 纹理对象的分层记账：key = `${target}:${level}`，重复上传同一层是替换而非累加。 */
interface TexRec {
    total: number;
    levels: Map<string, number>;
    /** 只记 level 0 —— mip 链是从它推出来的 */
    base: Map<string, LevelDims>;
    /** texStorage 分配的是不可变存储，generateMipmap 不会再额外分配 */
    immutable: boolean;
}

/**
 * level 0 之外完整 mip 链的**精确**字节数。
 *
 * 不用「level0 的 1/3」这个常见近似：那个值只在无穷级数下成立，
 * 实际链在 1×1 处终止，256² RGBA 就会差 2 字节。差 2 字节本身无害，
 * 但它意味着公式是错的 —— 换成非方形 / 非二次幂纹理误差会放大。
 */
function mipChainExtraBytes(dim: LevelDims): number {
    if (dim.w <= 0 || dim.h <= 0 || dim.d <= 0) return 0;
    if (dim.w === 1 && dim.h === 1 && dim.d === 1) return 0;
    let extra = 0;
    for (let i = 1; ; i++) {
        const w = Math.max(1, dim.w >> i);
        const h = Math.max(1, dim.h >> i);
        const d = Math.max(1, dim.d >> i);
        extra += dim.bpp * w * h * d;
        if (w === 1 && h === 1 && d === 1) break;
    }
    return extra;
}

const texRecs = new WeakMap<WebGLTexture, TexRec>();
const bufBytes = new WeakMap<WebGLBuffer, number>();
const rbBytes = new WeakMap<WebGLRenderbuffer, number>();

function normTexTarget(target: number): number {
    return target >= CUBE_FACE_FIRST && target <= CUBE_FACE_LAST ? TEXTURE_CUBE_MAP : target;
}

function boundTexture(st: CtxState, target: number): WebGLTexture | null {
    return st.tex.get(normTexTarget(target))?.[st.activeUnit] ?? null;
}

function setTexLevel(
    st: CtxState,
    tex: WebGLTexture | null,
    key: string,
    bytes: number,
    dims?: LevelDims,
    immutable?: boolean,
): void {
    if (!tex) return;
    let rec = texRecs.get(tex);
    if (!rec) {
        rec = { total: 0, levels: new Map(), base: new Map(), immutable: false };
        texRecs.set(tex, rec);
    }
    const prev = rec.levels.get(key) ?? 0;
    rec.levels.set(key, bytes);
    rec.total += bytes - prev;
    st.acc.textures += bytes - prev;
    if (dims) rec.base.set(key, dims);
    if (immutable) rec.immutable = true;
    touchPeak();
}

/** 从 texImage2D 的 6 参数重载里的 source 取尺寸。 */
function sourceSize(src: unknown): { w: number; h: number } {
    const o = src as Record<string, number> | null;
    if (!o) return { w: 0, h: 0 };
    const w = o.videoWidth || o.naturalWidth || o.width || 0;
    const h = o.videoHeight || o.naturalHeight || o.height || 0;
    return { w, h };
}

/* ============================ 上下文事件 ============================ */

const glErrors: string[] = [];
const seenContexts = new WeakSet<object>();

function pushGlError(msg: string): void {
    glErrors.push(msg);
    if (glErrors.length > MAX_GL_ERRORS) glErrors.shift();
}

/** 最近一个仍存活的上下文的信息。 */
function currentGlInfo(): GlContextInfo | null {
    let alive = 0;
    let last: GlContextInfo | null = null;
    for (const st of allCtx) {
        if (st.lost || !st.info) continue;
        alive++;
        last = st.info;
    }
    if (!last) return null;
    return { ...last, contexts: alive };
}

function registerContext(gl: AnyGL, canvas: HTMLCanvasElement | OffscreenCanvas | null): void {
    if (seenContexts.has(gl)) return;
    seenContexts.add(gl);
    const st = stateOf(gl);

    let renderer = '';
    let vendor = '';
    try {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info') as {
            UNMASKED_RENDERER_WEBGL: number;
            UNMASKED_VENDOR_WEBGL: number;
        } | null;
        if (dbg) {
            renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '');
            vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) ?? '');
        }
        if (!renderer) renderer = String(gl.getParameter(gl.RENDERER) ?? '');
        if (!vendor) vendor = String(gl.getParameter(gl.VENDOR) ?? '');
    } catch {
        /* 取不到就算了，主进程的 getGPUInfo 才是权威来源 */
    }

    st.info = {
        webglVersion: st.version,
        renderer,
        vendor,
        maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) ?? 0),
        contexts: 0,
    };

    if (canvas && typeof (canvas as HTMLCanvasElement).addEventListener === 'function') {
        const el = canvas as HTMLCanvasElement;
        el.addEventListener('webglcontextlost', () => {
            // 只清这一个上下文的账；它的资源已经全部作废
            st.lost = true;
            st.acc = newAccount();
            st.tex.clear();
            st.buf.clear();
            st.rb = null;
            pushGlError('context lost（该上下文的资源已作废，其记账已单独清零）');
        });
        el.addEventListener('webglcontextrestored', () => {
            st.lost = false;
            pushGlError('context restored（页面需重新上传全部资源，会被重新计入）');
        });
    }
}

/* ============================ 打桩 ============================ */

function patch(proto: object, name: string, make: (orig: Fn) => Fn): void {
    const orig = (proto as Record<string, unknown>)[name];
    if (typeof orig !== 'function') return;
    const wrapped = make(orig as Fn);
    Object.defineProperty(proto, name, {
        value: wrapped,
        writable: true,
        configurable: true,
        enumerable: false,
    });
}

function installGlHooks(proto: object): void {
    /* ---- 绑定影子状态 ---- */
    patch(proto, 'activeTexture', (orig) => function (this: AnyGL, unit: number) {
        stateOf(this).activeUnit = Math.max(0, (unit | 0) - TEXTURE0);
        return (orig as (u: number) => unknown).call(this, unit);
    } as Fn);

    patch(proto, 'bindTexture', (orig) => function (this: AnyGL, target: number, tex: WebGLTexture | null) {
        const st = stateOf(this);
        const key = normTexTarget(target);
        let arr = st.tex.get(key);
        if (!arr) {
            arr = [];
            st.tex.set(key, arr);
        }
        arr[st.activeUnit] = tex;
        return (orig as (t: number, x: WebGLTexture | null) => unknown).call(this, target, tex);
    } as Fn);

    patch(proto, 'bindBuffer', (orig) => function (this: AnyGL, target: number, buf: WebGLBuffer | null) {
        stateOf(this).buf.set(target, buf);
        return (orig as (t: number, b: WebGLBuffer | null) => unknown).call(this, target, buf);
    } as Fn);

    patch(proto, 'bindRenderbuffer', (orig) => function (this: AnyGL, target: number, rb: WebGLRenderbuffer | null) {
        stateOf(this).rb = rb;
        return (orig as (t: number, r: WebGLRenderbuffer | null) => unknown).call(this, target, rb);
    } as Fn);

    /* ---- 纹理分配 ---- */
    patch(proto, 'texImage2D', (orig) => function (this: AnyGL, ...args: unknown[]) {
        const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
        try {
            const st = stateOf(this);
            const target = args[0] as number;
            const level = args[1] as number;
            const internalformat = args[2] as number;
            let w: number;
            let h: number;
            let format: number;
            let type: number;
            if (args.length >= 8) {
                // (target, level, internalformat, width, height, border, format, type, ...)
                w = args[3] as number;
                h = args[4] as number;
                format = args[6] as number;
                type = args[7] as number;
            } else {
                // (target, level, internalformat, format, type, source)
                format = args[3] as number;
                type = args[4] as number;
                const s = sourceSize(args[5]);
                w = s.w;
                h = s.h;
            }
            const bpp = texBytesPerPixel(internalformat, format, type);
            setTexLevel(
                st,
                boundTexture(st, target),
                `${target}:${level}`,
                bpp * w * h,
                level === 0 ? { w, h, d: 1, bpp } : undefined,
            );
        } catch {
            /* 记账失败绝不能影响页面渲染 */
        }
        return r;
    } as Fn);

    patch(proto, 'texImage3D', (orig) => function (this: AnyGL, ...args: unknown[]) {
        const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
        try {
            const st = stateOf(this);
            const target = args[0] as number;
            const level = args[1] as number;
            const bpp = texBytesPerPixel(args[2] as number, args[7] as number, args[8] as number);
            const w = args[3] as number;
            const h = args[4] as number;
            const d = args[5] as number;
            setTexLevel(
                st,
                boundTexture(st, target),
                `${target}:${level}`,
                bpp * w * h * d,
                level === 0 ? { w, h, d, bpp } : undefined,
            );
        } catch {
            /* ignore */
        }
        return r;
    } as Fn);

    patch(proto, 'texStorage2D', (orig) => function (this: AnyGL, ...args: unknown[]) {
        const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
        try {
            const st = stateOf(this);
            const target = args[0] as number;
            const bpp = texBytesPerPixel(args[2] as number, 0, UNSIGNED_BYTE);
            const faces = normTexTarget(target) === TEXTURE_CUBE_MAP ? 6 : 1;
            const bytes =
                mipChainBytes(bpp, args[1] as number, args[3] as number, args[4] as number) *
                faces;
            setTexLevel(st, boundTexture(st, target), `${target}:storage`, bytes, undefined, true);
        } catch {
            /* ignore */
        }
        return r;
    } as Fn);

    patch(proto, 'texStorage3D', (orig) => function (this: AnyGL, ...args: unknown[]) {
        const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
        try {
            const st = stateOf(this);
            const target = args[0] as number;
            const bpp = texBytesPerPixel(args[2] as number, 0, UNSIGNED_BYTE);
            const bytes = mipChainBytes(
                bpp,
                args[1] as number,
                args[3] as number,
                args[4] as number,
                args[5] as number,
            );
            setTexLevel(st, boundTexture(st, target), `${target}:storage`, bytes, undefined, true);
        } catch {
            /* ignore */
        }
        return r;
    } as Fn);

    patch(proto, 'copyTexImage2D', (orig) => function (this: AnyGL, ...args: unknown[]) {
        const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
        try {
            const st = stateOf(this);
            const target = args[0] as number;
            const level = args[1] as number;
            const internalformat = args[2] as number;
            const bpp = texBytesPerPixel(internalformat, internalformat, UNSIGNED_BYTE);
            const w = args[5] as number;
            const h = args[6] as number;
            setTexLevel(
                st,
                boundTexture(st, target),
                `${target}:${level}`,
                bpp * w * h,
                level === 0 ? { w, h, d: 1, bpp } : undefined,
            );
        } catch {
            /* ignore */
        }
        return r;
    } as Fn);

    const compressed = (dataIndex: number) => (orig: Fn) =>
        function (this: AnyGL, ...args: unknown[]) {
            const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
            try {
                const st = stateOf(this);
                const target = args[0] as number;
                const level = args[1] as number;
                const d = args[dataIndex];
                // 压缩纹理按实际上传的字节数计，与驱动占用一致
                const bytes =
                    typeof d === 'number' ? d : ((d as ArrayBufferView | null)?.byteLength ?? 0);
                setTexLevel(st, boundTexture(st, target), `${target}:${level}`, bytes);
            } catch {
                /* ignore */
            }
            return r;
        } as Fn;
    patch(proto, 'compressedTexImage2D', compressed(6));
    patch(proto, 'compressedTexImage3D', compressed(7));

    patch(proto, 'generateMipmap', (orig) => function (this: AnyGL, target: number) {
        const r = (orig as (t: number) => unknown).call(this, target);
        try {
            const st = stateOf(this);
            const tex = boundTexture(st, target);
            const rec = tex ? texRecs.get(tex) : undefined;
            // texStorage 分配的是不可变存储，mip 链在分配时已全部计入
            if (tex && rec && !rec.immutable) {
                let extra = 0;
                for (const [k, dim] of rec.base) {
                    if (k.endsWith(':0')) extra += mipChainExtraBytes(dim);
                }
                setTexLevel(st, tex, `${target}:mipchain`, extra);
            }
        } catch {
            /* ignore */
        }
        return r;
    } as Fn);

    /* ---- renderbuffer ---- */
    const rbStorage = (samplesIndex: number, fmtIndex: number, wIndex: number) => (orig: Fn) =>
        function (this: AnyGL, ...args: unknown[]) {
            const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
            try {
                const st = stateOf(this);
                const rb = st.rb;
                if (rb) {
                    const samples =
                        samplesIndex >= 0 ? Math.max(1, args[samplesIndex] as number) : 1;
                    const bpp = renderbufferBytesPerPixel(args[fmtIndex] as number);
                    const bytes =
                        bpp * (args[wIndex] as number) * (args[wIndex + 1] as number) * samples;
                    const prev = rbBytes.get(rb) ?? 0;
                    rbBytes.set(rb, bytes);
                    st.acc.renderbuffers += bytes - prev;
                    touchPeak();
                }
            } catch {
                /* ignore */
            }
            return r;
        } as Fn;
    patch(proto, 'renderbufferStorage', rbStorage(-1, 1, 2));
    patch(proto, 'renderbufferStorageMultisample', rbStorage(1, 2, 3));

    /* ---- buffer ---- */
    patch(proto, 'bufferData', (orig) => function (this: AnyGL, ...args: unknown[]) {
        const r = (orig as (...a: unknown[]) => unknown).apply(this, args);
        try {
            const st = stateOf(this);
            const buf = st.buf.get(args[0] as number) ?? null;
            if (buf) {
                const src = args[1];
                let bytes = 0;
                if (typeof src === 'number') {
                    bytes = src;
                } else if (src) {
                    const view = src as ArrayBufferView;
                    if (args.length >= 5 && typeof args[4] === 'number') {
                        // WebGL2 的 (srcData, usage, srcOffset, length)：length 以元素计
                        const elem =
                            (view as unknown as { BYTES_PER_ELEMENT?: number })
                                .BYTES_PER_ELEMENT ?? 1;
                        bytes = (args[4] as number) * elem;
                    } else {
                        bytes = view.byteLength ?? 0;
                    }
                }
                const prev = bufBytes.get(buf) ?? 0;
                bufBytes.set(buf, bytes);
                st.acc.buffers += bytes - prev;
                touchPeak();
            }
        } catch {
            /* ignore */
        }
        return r;
    } as Fn);

    /* ---- 对象生命周期计数 ---- */
    const createCounter = (field: keyof GlObjectCounts) => (orig: Fn) =>
        function (this: AnyGL, ...args: unknown[]) {
            const obj = (orig as (...a: unknown[]) => unknown).apply(this, args);
            if (obj) stateOf(this).acc.counts[field]++;
            return obj;
        } as Fn;
    patch(proto, 'createTexture', createCounter('textures'));
    patch(proto, 'createBuffer', createCounter('buffers'));
    patch(proto, 'createRenderbuffer', createCounter('renderbuffers'));
    patch(proto, 'createFramebuffer', createCounter('framebuffers'));
    patch(proto, 'createProgram', createCounter('programs'));

    patch(proto, 'deleteTexture', (orig) => function (this: AnyGL, tex: WebGLTexture | null) {
        try {
            if (tex) {
                const st = stateOf(this);
                const rec = texRecs.get(tex);
                if (rec) {
                    st.acc.textures -= rec.total;
                    texRecs.delete(tex);
                }
                st.acc.counts.textures--;
                // 清掉影子绑定，避免后续 texImage2D 误记到已删对象上
                for (const arr of st.tex.values()) {
                    for (let i = 0; i < arr.length; i++) if (arr[i] === tex) arr[i] = null;
                }
            }
        } catch {
            /* ignore */
        }
        return (orig as (t: WebGLTexture | null) => unknown).call(this, tex);
    } as Fn);

    patch(proto, 'deleteBuffer', (orig) => function (this: AnyGL, buf: WebGLBuffer | null) {
        try {
            if (buf) {
                const st = stateOf(this);
                st.acc.buffers -= bufBytes.get(buf) ?? 0;
                bufBytes.delete(buf);
                st.acc.counts.buffers--;
                for (const [k, v] of st.buf) if (v === buf) st.buf.set(k, null);
            }
        } catch {
            /* ignore */
        }
        return (orig as (b: WebGLBuffer | null) => unknown).call(this, buf);
    } as Fn);

    patch(proto, 'deleteRenderbuffer', (orig) => function (this: AnyGL, rb: WebGLRenderbuffer | null) {
        try {
            if (rb) {
                const st = stateOf(this);
                st.acc.renderbuffers -= rbBytes.get(rb) ?? 0;
                rbBytes.delete(rb);
                st.acc.counts.renderbuffers--;
                if (st.rb === rb) st.rb = null;
            }
        } catch {
            /* ignore */
        }
        return (orig as (r: WebGLRenderbuffer | null) => unknown).call(this, rb);
    } as Fn);

    patch(proto, 'deleteFramebuffer', (orig) => function (this: AnyGL, fb: WebGLFramebuffer | null) {
        if (fb) stateOf(this).acc.counts.framebuffers--;
        return (orig as (f: WebGLFramebuffer | null) => unknown).call(this, fb);
    } as Fn);

    patch(proto, 'deleteProgram', (orig) => function (this: AnyGL, p: WebGLProgram | null) {
        if (p) stateOf(this).acc.counts.programs--;
        return (orig as (p: WebGLProgram | null) => unknown).call(this, p);
    } as Fn);

    /* ---- draw call 计数 ---- */
    for (const name of [
        'drawArrays',
        'drawElements',
        'drawArraysInstanced',
        'drawElementsInstanced',
        'drawRangeElements',
    ]) {
        patch(proto, name, (orig) => function (this: AnyGL, ...args: unknown[]) {
            drawCallsTotal++;
            return (orig as (...a: unknown[]) => unknown).apply(this, args);
        } as Fn);
    }

    /* ---- getError：页面自己观察到的错误顺手记下 ---- */
    patch(proto, 'getError', (orig) => function (this: AnyGL) {
        const e = (orig as () => number).call(this) as number;
        if (e !== 0) pushGlError(`gl.getError = 0x${e.toString(16)}`);
        return e;
    } as Fn);

    /* ---- WebGL1 的实例化绘制走扩展对象 ---- */
    const wrappedExts = new WeakSet<object>();
    patch(proto, 'getExtension', (orig) => function (this: AnyGL, name: string) {
        const ext = (orig as (n: string) => unknown).call(this, name) as Record<
            string,
            unknown
        > | null;
        if (!ext || wrappedExts.has(ext)) return ext;
        let touched = false;
        for (const dn of [
            'drawArraysInstancedANGLE',
            'drawElementsInstancedANGLE',
            'multiDrawArraysWEBGL',
            'multiDrawElementsWEBGL',
            'multiDrawArraysInstancedWEBGL',
            'multiDrawElementsInstancedWEBGL',
        ]) {
            if (typeof ext[dn] === 'function') {
                patch(ext, dn, (o) => function (this: unknown, ...args: unknown[]) {
                    drawCallsTotal++;
                    return (o as (...a: unknown[]) => unknown).apply(this, args);
                } as Fn);
                touched = true;
            }
        }
        if (touched) wrappedExts.add(ext);
        return ext;
    } as Fn);
}

function installCanvasHooks(): void {
    const hook = (proto: object) => {
        patch(proto, 'getContext', (orig) => function (
            this: HTMLCanvasElement | OffscreenCanvas,
            ...args: unknown[]
        ) {
            const ctx = (orig as (...a: unknown[]) => unknown).apply(this, args);
            const kind = args[0];
            if (ctx && (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl')) {
                try {
                    registerContext(ctx as AnyGL, this);
                } catch {
                    /* ignore */
                }
            }
            return ctx;
        } as Fn);
    };
    if (typeof HTMLCanvasElement !== 'undefined') hook(HTMLCanvasElement.prototype);
    if (typeof OffscreenCanvas !== 'undefined') hook(OffscreenCanvas.prototype);
}

/* ============================ WebGPU ============================ */

function installWebGpuHooks(): void {
    const GPUDeviceCtor = (globalThis as Record<string, unknown>).GPUDevice as
        | { prototype: object }
        | undefined;
    if (!GPUDeviceCtor) return;

    const sizes = new WeakMap<object, number>();

    /**
     * WebGPU 没有集中的 delete 入口，destroy 挂在对象自身上。
     * 覆盖写在**实例**上，避免污染原型（所有 GPUTexture 共享同一原型）。
     */
    const patchDestroy = (obj: object, field: 'textures' | 'buffers'): void => {
        const proto = Object.getPrototypeOf(obj) as Record<string, unknown>;
        const origDestroy = proto?.destroy;
        if (typeof origDestroy !== 'function') return;
        Object.defineProperty(obj, 'destroy', {
            value: function deskappDestroy(this: object) {
                const bytes = sizes.get(this);
                if (bytes !== undefined) {
                    wgpu[field] -= bytes;
                    sizes.delete(this);
                }
                return (origDestroy as () => unknown).call(this);
            },
            writable: true,
            configurable: true,
            enumerable: false,
        });
    };

    patch(GPUDeviceCtor.prototype, 'createTexture', (orig) => function (
        this: unknown,
        desc: Record<string, unknown>,
    ) {
        const tex = (orig as (d: unknown) => object).call(this, desc);
        try {
            const bytes = wgpuTextureBytes(desc as never);
            sizes.set(tex, bytes);
            wgpu.textures += bytes;
            touchPeak();
            patchDestroy(tex, 'textures');
        } catch {
            /* ignore */
        }
        return tex;
    } as Fn);

    patch(GPUDeviceCtor.prototype, 'createBuffer', (orig) => function (
        this: unknown,
        desc: Record<string, unknown>,
    ) {
        const buf = (orig as (d: unknown) => object).call(this, desc);
        try {
            const bytes = Number(desc?.size ?? 0);
            sizes.set(buf, bytes);
            wgpu.buffers += bytes;
            touchPeak();
            patchDestroy(buf, 'buffers');
        } catch {
            /* ignore */
        }
        return buf;
    } as Fn);
}

/* ============================ 对外接口 ============================ */

const custom: Record<string, number> = {};

function heap(): ProbeSample['heap'] {
    const m = (performance as unknown as {
        memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    if (!m) return null;
    const MB = 1024 * 1024;
    return {
        usedMB: m.usedJSHeapSize / MB,
        totalMB: m.totalJSHeapSize / MB,
        limitMB: m.jsHeapSizeLimit / MB,
    };
}

function takeVram(): VramBreakdown {
    const s = liveTotals();
    return {
        textures: s.textures,
        renderbuffers: s.renderbuffers,
        buffers: s.buffers,
        gpuTextures: wgpu.textures,
        gpuBuffers: wgpu.buffers,
        total: vramTotal(),
        peak: vramPeak,
    };
}

let installed = false;

export const probe = {
    install(): void {
        if (installed) return;
        installed = true;
        installFrameHooks();
        installCanvasHooks();
        if (typeof WebGLRenderingContext !== 'undefined') {
            installGlHooks(WebGLRenderingContext.prototype);
        }
        if (typeof WebGL2RenderingContext !== 'undefined') {
            installGlHooks(WebGL2RenderingContext.prototype);
        }
        installWebGpuHooks();
    },

    /** 由主进程按显示器刷新率下发。 */
    setBudgetMs(ms: number): void {
        if (Number.isFinite(ms) && ms > 0) budgetMs = ms;
    },

    /** 页面通过 deskapp.report() 上报的自定义指标。 */
    report(metrics: Record<string, number>): void {
        for (const [k, v] of Object.entries(metrics)) {
            if (typeof v === 'number' && Number.isFinite(v)) custom[k] = v;
        }
    },

    /**
     * 无副作用读取显存记账与对象数 —— 不清空采样窗口。
     * 页面想每秒看一眼显存就用这个；用 sample() 会把宿主的采样窗口吃掉。
     */
    peek(): { vram: VramBreakdown; counts: GlObjectCounts; gl: GlContextInfo | null } {
        return { vram: takeVram(), counts: liveCounts(), gl: currentGlInfo() };
    },

    /** 取一次采样并清空窗口累计量。 */
    sample(): ProbeSample {
        const dcWindow = frameDrawCalls;
        frameDrawCalls = [];
        let dcSum = 0;
        let dcMax = 0;
        for (const v of dcWindow) {
            dcSum += v;
            if (v > dcMax) dcMax = v;
        }
        const errs = glErrors.slice();
        glErrors.length = 0;

        return {
            t: performance.timeOrigin + performance.now(),
            firstFrameAt,
            firstPaintAt: firstPaintAt(),
            frame: takeFrameStats(),
            vram: takeVram(),
            drawCallsAvg: dcWindow.length ? dcSum / dcWindow.length : 0,
            drawCallsMax: dcMax,
            gl: currentGlInfo(),
            counts: liveCounts(),
            heap: heap(),
            custom: { ...custom },
            glErrors: errs,
        };
    },

    /** purge / reload 之后清空历史峰值。 */
    reset(): void {
        vramPeak = 0;
        intervals = [];
        scriptMs = [];
        frameDrawCalls = [];
        curFrameTs = -1;
        for (const k of Object.keys(custom)) delete custom[k];
        glErrors.length = 0;
    },
};
