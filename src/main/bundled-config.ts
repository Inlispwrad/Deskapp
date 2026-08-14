/**
 * 内嵌应用配置 —— 把 Deskapp 打成"某个特定 webapp 的专属应用"。
 *
 * 打包后的 app 是被双击启动的，没有命令行可用，所以默认装载目标必须内嵌。
 * 配置文件放在打包资源根目录下（`Contents/Resources/deskapp.json`），
 * 启动时读一次，命令行显式给的参数优先级更高。
 *
 * 远端 URL 目标读不到 Web App Manifest（要等页面加载完），
 * 所以这里的字段会**合成一份 manifest** 交给既有的窗口配置流程 ——
 * 不另开一条"配置窗口"的代码路径。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { app } from 'electron';
import type { AngleBackend, PerfProfile } from '../shared/types';
import type { SidecarConfig } from './sidecar';
import type { AppManifest } from './target';

export interface BundledConfig {
    /** 默认装载目标：URL，或相对于本配置文件的目录 */
    target?: string;
    /** 应用名（窗口标题 / Dock 名称的兜底） */
    productName?: string;
    /** 窗口底色 —— 远端目标读不到 manifest，靠这个消除启动白闪 */
    backgroundColor?: string;
    /** 图标路径，相对于本配置文件 */
    icon?: string;
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    resizable?: boolean;
    fullscreen?: boolean;
    frameless?: boolean;
    nativeTitlebar?: boolean;
    profile?: PerfProfile;
    angle?: AngleBackend;
    webgpu?: boolean;
    zoomFactor?: number;
    vramLimitMB?: number;
    rssLimitMB?: number;
    maxOldSpaceMB?: number;
    sampleIntervalMs?: number;
    crossOriginIsolated?: boolean;
    /**
     * 宿主托管的后端进程。装载前拉起、退出时连同整棵进程树关掉。
     * 已经有人在跑（readyUrl 有响应）时沿用现有实例，退出时不去动它。
     */
    server?: SidecarConfig;
    /**
     * 采用被装载页面自己的图标（favicon）作为本应用的图标：
     * 缓存到 userData → 下次启动在页面加载前就应用 → macOS 上还会改 .app 的 icon.icns。
     *
     * 只对**专属打包**有意义。通用 Deskapp 会来回切换不同应用，
     * 跟着改自己的图标是错的，所以默认关闭。
     */
    adoptPageIcon?: boolean;
}

export interface LoadedBundle {
    config: BundledConfig;
    /** 配置文件所在目录，用于解析 target / icon 的相对路径 */
    dir: string;
    path: string;
}

const FILENAME = 'deskapp.json';

/**
 * 查找顺序：`--config` 显式指定 > 打包资源根目录 > 项目根目录（开发时）。
 */
export function loadBundledConfig(explicitPath: string | null): LoadedBundle | null {
    const candidates: string[] = [];
    if (explicitPath) {
        candidates.push(isAbsolute(explicitPath) ? explicitPath : resolve(process.cwd(), explicitPath));
    }
    if (app.isPackaged) candidates.push(join(process.resourcesPath, FILENAME));
    candidates.push(join(app.getAppPath(), FILENAME));

    for (const p of candidates) {
        if (!existsSync(p)) continue;
        try {
            const config = JSON.parse(readFileSync(p, 'utf8')) as BundledConfig;
            if (config && typeof config === 'object') {
                return { config, dir: dirname(p), path: p };
            }
        } catch (err) {
            process.stderr.write(`[deskapp] 内嵌配置解析失败 ${p}: ${String(err)}\n`);
        }
    }
    return null;
}

/** 把目标解析成绝对路径 / 原样 URL。 */
export function resolveBundledTarget(bundle: LoadedBundle): string | null {
    const t = bundle.config.target;
    if (!t) return null;
    if (/^https?:\/\//i.test(t)) return t;
    return isAbsolute(t) ? t : resolve(bundle.dir, t);
}

/**
 * 合成一份 manifest，喂给既有的窗口配置流程。
 * 只在目标本身没有 manifest 时用作兜底（本地目录的真 manifest 优先）。
 */
export function bundledManifest(bundle: LoadedBundle): AppManifest | null {
    const c = bundle.config;
    const hasAnything =
        c.productName ||
        c.backgroundColor ||
        c.icon ||
        c.width ||
        c.height ||
        c.fullscreen !== undefined;
    if (!hasAnything) return null;

    const iconPath = c.icon
        ? isAbsolute(c.icon)
            ? c.icon
            : join(bundle.dir, c.icon)
        : null;

    return {
        name: c.productName ?? null,
        shortName: null,
        backgroundColor: c.backgroundColor ?? null,
        themeColor: null,
        display: c.fullscreen ? 'fullscreen' : null,
        iconPath: iconPath && existsSync(iconPath) ? iconPath : null,
        deskapp: {
            ...(c.width !== undefined ? { width: c.width } : {}),
            ...(c.height !== undefined ? { height: c.height } : {}),
            ...(c.minWidth !== undefined ? { minWidth: c.minWidth } : {}),
            ...(c.minHeight !== undefined ? { minHeight: c.minHeight } : {}),
            ...(c.resizable !== undefined ? { resizable: c.resizable } : {}),
            ...(c.fullscreen !== undefined ? { fullscreen: c.fullscreen } : {}),
            ...(c.vramLimitMB !== undefined ? { vramLimitMB: c.vramLimitMB } : {}),
        },
    };
}
