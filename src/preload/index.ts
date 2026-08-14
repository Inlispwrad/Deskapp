/**
 * 被装载 webapp 的 preload —— 运行在主世界。
 *
 * 做两件事：
 *   ① 安装插桩探针（probe），并按主进程下发的周期上报采样；
 *   ② 暴露 `window.deskapp` —— 被装载 webapp 与宿主对接的唯一接口面。
 *
 * 只在主 frame 生效：子 iframe 不装探针、不注入 API。
 */

import { ipcRenderer } from 'electron';
import { CH, type PageCommand, type PageEvent } from '../shared/channels';
import type { HostSettings, PerfProfile, ProbeSample } from '../shared/types';
import { probe } from './probe';

interface ProbeConfig {
    enabled: boolean;
    intervalMs: number;
    budgetMs: number;
    profile: PerfProfile;
    deskappVersion: string;
}

type EventName = PageEvent['type'];
type Listener = (payload: unknown) => void;

const listeners = new Map<EventName, Set<Listener>>();
let config: ProbeConfig = {
    enabled: true,
    intervalMs: 500,
    budgetMs: 1000 / 60,
    profile: 'balanced',
    deskappVersion: '0.0.0',
};
let timer: ReturnType<typeof setInterval> | null = null;

function emit(ev: PageEvent): void {
    const set = listeners.get(ev.type);
    if (!set) return;
    for (const fn of set) {
        try {
            fn(ev);
        } catch (err) {
            // 页面的回调抛错不能拖垮宿主上报
            console.error('[deskapp] listener threw', err);
        }
    }
}

function restartTimer(): void {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    if (!config.enabled) return;
    timer = setInterval(() => {
        try {
            ipcRenderer.send(CH.probeSample, probe.sample());
        } catch {
            /* 窗口正在销毁时 send 会失败，忽略 */
        }
    }, config.intervalMs);
}

/** 提供给页面的 API。 */
const api = {
    /** 恒为 true —— 页面用它判断"我跑在 Deskapp 里"。 */
    isDeskapp: true as const,
    get version(): string {
        return config.deskappVersion;
    },
    platform: process.platform as 'darwin' | 'win32' | 'linux',
    get profile(): PerfProfile {
        return config.profile;
    },

    /* ---- 指标 ---- */

    /**
     * 上报应用自己的指标，会并入面板与 smoke 报告。
     * 例：deskapp.report({ nodes: 1240, drawCalls: 86, frameProcessMs: 4.2 })
     */
    report(metrics: Record<string, number>): void {
        probe.report(metrics);
    },

    /**
     * 无副作用读取显存记账与 GL 对象数（无 IPC）。想每帧/每秒轮询显存就用这个。
     */
    peek(): ReturnType<typeof probe.peek> {
        return probe.peek();
    },

    /**
     * 完整采样（含帧统计）。
     * ⚠️ 有副作用：会清空采样窗口，宿主面板本周期就看不到数据了。诊断时偶尔调，别放进帧循环。
     */
    stats(): ProbeSample {
        return probe.sample();
    },

    /** 触发一次 V8 GC（依赖 --expose-gc，默认开启）。返回是否真的触发了。 */
    gc(): boolean {
        const g = (globalThis as { gc?: () => void }).gc;
        if (typeof g === 'function') {
            g();
            return true;
        }
        return false;
    },

    /* ---- 窗口 ---- */

    setFullscreen(value: boolean): Promise<void> {
        return send({ type: 'set-fullscreen', value });
    },
    setWindowSize(width: number, height: number): Promise<void> {
        return send({ type: 'set-window-size', width, height });
    },
    setTitle(title: string): Promise<void> {
        return send({ type: 'set-title', title });
    },

    /* ---- 生命周期 / 诊断 ---- */

    reload(): Promise<void> {
        return send({ type: 'request-reload' });
    },
    quit(): Promise<void> {
        return send({ type: 'request-quit' });
    },
    /** 在系统浏览器里打开外链。 */
    openExternal(url: string): Promise<void> {
        return send({ type: 'open-external', url });
    },
    /** 打一个时间点标记，落进 smoke 报告的时间轴（如 'assets-loaded'）。 */
    mark(name: string): Promise<void> {
        return send({ type: 'mark', name });
    },
    log(level: 'info' | 'warn' | 'error', message: string): Promise<void> {
        return send({ type: 'log', level, message });
    },

    /* ---- 宿主事件 ---- */

    on(event: EventName, fn: Listener): void {
        let set = listeners.get(event);
        if (!set) {
            set = new Set();
            listeners.set(event, set);
        }
        set.add(fn);
    },
    off(event: EventName, fn: Listener): void {
        listeners.get(event)?.delete(fn);
    },
};

function send(cmd: PageCommand): Promise<void> {
    return ipcRenderer.invoke(CH.pageCommand, cmd) as Promise<void>;
}

/* ============================ 安装 ============================ */

if (process.isMainFrame) {
    probe.install();

    ipcRenderer.on(CH.probeConfig, (_e, next: Partial<ProbeConfig>) => {
        const prevInterval = config.intervalMs;
        const prevEnabled = config.enabled;
        config = { ...config, ...next };
        probe.setBudgetMs(config.budgetMs);
        if (config.intervalMs !== prevInterval || config.enabled !== prevEnabled) restartTimer();
    });

    ipcRenderer.on(CH.probeFlush, () => {
        try {
            ipcRenderer.send(CH.probeSample, probe.sample());
        } catch {
            /* ignore */
        }
    });

    ipcRenderer.on(CH.pageEvent, (_e, ev: PageEvent) => {
        if (ev.type === 'before-purge') probe.reset();
        emit(ev);
    });

    // contextIsolation: false 时 contextBridge 是多余的（同一个世界），直接挂 window。
    // 保留 contextBridge 分支：将来若给不受信内容开隔离，API 仍然可用（此时 probe 不可用）。
    if (process.contextIsolated) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { contextBridge } = require('electron') as typeof import('electron');
        contextBridge.exposeInMainWorld('deskapp', api);
    } else {
        Object.defineProperty(window, 'deskapp', {
            value: api,
            writable: false,
            configurable: false,
            enumerable: true,
        });
    }

    restartTimer();
    ipcRenderer.send(CH.pageReady);
}

export type DeskappApi = typeof api;
export type { HostSettings };
