/**
 * `deskapp.json` —— 项目清单协议。
 *
 * **一种格式，三个位置**（这是整个抽象化的核心）：
 *   ① `<项目目录>/deskapp.json`      —— 用启动器打开一个项目时
 *   ② `<Resources>/deskapp.json`     —— 导出成独立应用后（entry 指向包内的 project/）
 *   ③ `--config <文件>`              —— 显式指定，优先级最高
 * 导出应用与本地项目走的是同一条代码路径，不存在"打包版特殊逻辑"。
 *
 * 最小协议只要一个 `index.html`：目录里连 deskapp.json 都没有也能打开，
 * 全部走默认值。其余字段都是渐进增强。
 *
 * ⚠️ `command` / `hooks` 是**磁盘上的数据**，直接执行等于"打开一个目录就跑任意 shell"。
 * 所以它们的执行受 consent.ts 的确认门控，不在本模块里自动展开。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { app } from 'electron';
import type { AngleBackend, PerfProfile } from '../shared/types';
import type { SidecarConfig } from './sidecar';
import type { AppManifest } from './target';

export const MANIFEST_NAME = 'deskapp.json';
/** 没有 entry 时的默认入口 —— 这就是"最基本的接口协议"。 */
export const DEFAULT_ENTRY = 'index.html';

export interface ProjectWindow {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    /** 窗口底色，消除启动白闪。形如 #rrggbb */
    background?: string;
    resizable?: boolean;
    /** 锁定宽高比，如 1.7777；0 或省略表示不锁 */
    aspectRatio?: number;
    fullscreen?: boolean;
    frameless?: boolean;
    /** 用平台原生标题栏，不用 Deskapp 自绘那条 */
    nativeTitlebar?: boolean;
}

export interface ProjectRuntime {
    profile?: PerfProfile;
    angle?: AngleBackend;
    webgpu?: boolean;
    zoom?: number;
    vramLimitMB?: number;
    rssLimitMB?: number;
    maxOldSpaceMB?: number;
    sampleIntervalMs?: number;
    /** 发 COOP/COEP 头，SharedArrayBuffer 需要 */
    crossOriginIsolated?: boolean;
    /** 用页面自己的 favicon 当应用图标（只对导出的独立应用有意义） */
    adoptPageIcon?: boolean;
}

/** 长期运行的命令行（服务 / dev server）。 */
export interface ProjectCommand {
    /** 原样交给登录 shell 的命令行，如 `npx vite` 这类 dev server 启动命令 */
    run?: string;
    /** 或显式给可执行文件与参数（不经 shell） */
    command?: string;
    args?: string[];
    /** 工作目录，相对项目根 */
    cwd?: string;
    env?: Record<string, string>;
    /** 就绪探测地址；给了就轮询到它有响应才加载页面 */
    readyUrl?: string;
    readyTimeoutMs?: number;
    /** 没有 readyUrl 时固定等待多久 */
    waitMs?: number;
    shutdownTimeoutMs?: number;
}

/** 一次性生命周期脚本。 */
export interface ProjectHooks {
    /** 装载前跑一次，跑完（成功）才继续 */
    startup?: string;
    /** 关闭时跑一次 */
    shutdown?: string;
    /** 钩子超时（ms），默认 120000 */
    timeoutMs?: number;
}

export interface ProjectManifest {
    /** 清单格式版本，当前 1。不填按 1 处理 */
    version?: number;
    /** 应用名：窗口标题 / Dock 名 / 导出应用名的来源 */
    name?: string;
    /** 本地入口（文件或目录，相对项目根），或 http(s) URL。默认 index.html */
    entry?: string;
    /** 图标路径，相对项目根 */
    icon?: string;
    window?: ProjectWindow;
    runtime?: ProjectRuntime;
    command?: ProjectCommand;
    hooks?: ProjectHooks;
}

/** 加载好的项目：清单 + 它所在的根目录。 */
export interface LoadedProject {
    manifest: ProjectManifest;
    /** 清单所在目录 —— entry / icon / cwd 全相对它解析 */
    root: string;
    /** 清单文件路径；目录里没有清单时为 null（走全默认） */
    manifestPath: string | null;
}

const EMPTY: ProjectManifest = {};

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 只保留认识的字段，形状不对的整块丢掉 —— 清单是外部数据，不能拿来当真。 */
function sanitize(raw: unknown): ProjectManifest {
    if (!isObject(raw)) return EMPTY;
    const out: ProjectManifest = {};
    if (typeof raw.version === 'number') out.version = raw.version;
    if (typeof raw.name === 'string') out.name = raw.name;
    if (typeof raw.entry === 'string') out.entry = raw.entry;
    if (typeof raw.icon === 'string') out.icon = raw.icon;
    if (isObject(raw.window)) out.window = raw.window as ProjectWindow;
    if (isObject(raw.runtime)) out.runtime = raw.runtime as ProjectRuntime;
    if (isObject(raw.command)) out.command = raw.command as ProjectCommand;
    if (isObject(raw.hooks)) out.hooks = raw.hooks as ProjectHooks;
    return out;
}

export class ManifestError extends Error {}

/**
 * 以一个 URL 为入口新建项目。
 *
 * 「网址模式」和「本地项目模式」的唯一区别就是 `entry` 是 URL 而不是 index.html ——
 * 其余全都一样：启动/关闭脚本、窗口配置、最近列表、导出。所以这里不另立数据结构，
 * 老老实实在磁盘上写一份普通的 `deskapp.json`，之后一切走既有路径。
 *
 * 项目目录建在 userData 下：用户只想填个网址，不该被要求先选一个保存位置。
 *
 * @param startup 启动命令。写成 `command.run` 而不是 `hooks.startup`：
 *   服务是长期运行的，`hooks.startup` 的语义是"等它跑完"，套不上。
 *   配合 `readyUrl` = 入口地址，Deskapp 会等地址通了再加载页面。
 */
export function createUrlProject(
    baseDir: string,
    input: { url: string; name?: string; startup?: string; shutdown?: string },
): LoadedProject {
    const url = input.url.trim();
    let host = 'url';
    try {
        const u = new URL(url);
        host = `${u.hostname}${u.port ? `-${u.port}` : ''}`;
    } catch {
        throw new ManifestError(`不是合法的网址：${url}`);
    }

    const name = input.name?.trim() || host;
    // 目录名带上 URL 的短哈希：同名不同址不会互相覆盖
    const stamp = createHash('sha256').update(url).digest('hex').slice(0, 6);
    const slug = `${name.replace(/[^\w一-龥-]+/g, '-').replace(/^-+|-+$/g, '') || host}-${stamp}`;
    const root = join(baseDir, slug);
    mkdirSync(root, { recursive: true });

    const startup = input.startup?.trim();
    const shutdown = input.shutdown?.trim();
    const manifest: ProjectManifest = {
        version: 1,
        name,
        entry: url,
        ...(startup
            ? { command: { run: startup, readyUrl: url, readyTimeoutMs: 120_000 } }
            : {}),
        ...(shutdown ? { hooks: { shutdown } } : {}),
    };

    const manifestPath = join(root, MANIFEST_NAME);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
    return { manifest, root, manifestPath };
}

/** 读一个目录的清单。目录里没有 deskapp.json 不算错误 —— 走全默认。 */
export function loadProjectAt(dir: string): LoadedProject {
    const root = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
    const manifestPath = join(root, MANIFEST_NAME);
    if (!existsSync(manifestPath)) {
        return { manifest: EMPTY, root, manifestPath: null };
    }
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
        throw new ManifestError(`${MANIFEST_NAME} 不是合法 JSON：${String(err)}`);
    }
    return { manifest: sanitize(raw), root, manifestPath };
}

/** 从显式文件路径读清单（`--config`，或导出应用里的 Resources/deskapp.json）。 */
export function loadProjectFromFile(file: string): LoadedProject | null {
    const p = isAbsolute(file) ? file : resolve(process.cwd(), file);
    if (!existsSync(p)) return null;
    try {
        const manifest = sanitize(JSON.parse(readFileSync(p, 'utf8')));
        return { manifest, root: dirname(p), manifestPath: p };
    } catch (err) {
        process.stderr.write(`[deskapp] 清单解析失败 ${p}：${String(err)}\n`);
        return null;
    }
}

/**
 * 找内嵌清单：`--config` > 打包资源根目录 > 项目根（开发时）。
 * 导出出来的独立应用就靠第二条自我识别。
 */
export function loadEmbeddedProject(explicitPath: string | null): LoadedProject | null {
    const candidates: string[] = [];
    if (explicitPath) candidates.push(explicitPath);
    if (app.isPackaged) candidates.push(join(process.resourcesPath, MANIFEST_NAME));
    candidates.push(join(app.getAppPath(), MANIFEST_NAME));
    for (const c of candidates) {
        const loaded = loadProjectFromFile(c);
        if (loaded) return loaded;
    }
    return null;
}

/**
 * 把 entry 解析成可以交给 Host.openTarget 的字符串。
 * 目录 / 文件 → 绝对路径；URL → 原样。
 */
export function resolveEntry(project: LoadedProject): string | null {
    const entry = project.manifest.entry?.trim() || DEFAULT_ENTRY;
    if (/^https?:\/\//i.test(entry)) return entry;
    const abs = isAbsolute(entry) ? entry : join(project.root, entry);
    return existsSync(abs) ? abs : null;
}

/**
 * **内容根** —— 项目文件真正所在的目录，命令与钩子的默认工作目录。
 *
 * 与 `root`（清单所在目录）的区别只在导出物里体现：导出后清单在 `Resources/`，
 * 而项目文件被搬到了 `Resources/project/`。用 entry 的所在目录做内容根，
 * 本地项目与导出应用就走同一套语义，不需要在导出时改写任何 cwd。
 */
export function contentRoot(project: LoadedProject): string {
    const entry = project.manifest.entry?.trim() || DEFAULT_ENTRY;
    if (/^https?:\/\//i.test(entry)) return project.root;
    const abs = isAbsolute(entry) ? entry : join(project.root, entry);
    try {
        return statSync(abs).isDirectory() ? abs : dirname(abs);
    } catch {
        return project.root;
    }
}

/** 目录看起来是不是一个可打开的项目。 */
export function looksLikeProject(dir: string): boolean {
    try {
        if (!statSync(dir).isDirectory()) return false;
    } catch {
        return false;
    }
    if (existsSync(join(dir, MANIFEST_NAME))) return true;
    return existsSync(join(dir, DEFAULT_ENTRY));
}

/** 清单里声明的图标的绝对路径（不存在则 null）。 */
export function iconPathOf(project: LoadedProject): string | null {
    const icon = project.manifest.icon;
    if (!icon) return null;
    if (/^https?:\/\//i.test(icon)) return null;
    const p = isAbsolute(icon) ? icon : join(project.root, icon);
    return existsSync(p) ? p : null;
}

/** 项目声明的长期命令 → Sidecar 配置。没声明返回 null。 */
export function toSidecarConfig(project: LoadedProject): SidecarConfig | null {
    const c = project.manifest.command;
    if (!c) return null;
    const hasRun = typeof c.run === 'string' && c.run.trim().length > 0;
    const hasCmd = typeof c.command === 'string' && c.command.trim().length > 0;
    if (!hasRun && !hasCmd) return null;
    return {
        ...(hasRun ? { shellLine: c.run } : {}),
        ...(hasCmd ? { command: c.command, args: c.args ?? [] } : {}),
        ...(c.cwd ? { cwd: c.cwd } : {}),
        ...(c.env ? { env: c.env } : {}),
        ...(c.readyUrl ? { readyUrl: c.readyUrl } : {}),
        ...(typeof c.readyTimeoutMs === 'number' ? { readyTimeoutMs: c.readyTimeoutMs } : {}),
        ...(typeof c.waitMs === 'number' ? { waitMs: c.waitMs } : {}),
        ...(typeof c.shutdownTimeoutMs === 'number'
            ? { shutdownTimeoutMs: c.shutdownTimeoutMs }
            : {}),
    };
}

/** 项目声明的全部可执行内容，用于执行确认与"有没有东西要跑"的判断。 */
export interface DeclaredExecution {
    startup: string | null;
    command: string | null;
    shutdown: string | null;
}

/**
 * 项目清单 → 窗口身份。
 * 复用 Web App Manifest 的内部结构（AppManifest），这样两个来源可以直接合并，
 * 不用为"deskapp.json 驱动窗口"再写一套窗口配置代码。
 */
export function projectIdentity(project: LoadedProject): AppManifest | null {
    const m = project.manifest;
    const w = m.window ?? {};
    const r = m.runtime ?? {};
    const hasAnything =
        m.name || m.icon || Object.keys(w).length > 0 || r.vramLimitMB !== undefined;
    if (!hasAnything) return null;
    return {
        name: m.name ?? null,
        shortName: null,
        backgroundColor: w.background ?? null,
        themeColor: null,
        // window.fullscreen 不再自动全屏（全屏是用户动作），display 保留为 null
        display: null,
        iconPath: iconPathOf(project),
        deskapp: {
            ...(w.width !== undefined ? { width: w.width } : {}),
            ...(w.height !== undefined ? { height: w.height } : {}),
            ...(w.minWidth !== undefined ? { minWidth: w.minWidth } : {}),
            ...(w.minHeight !== undefined ? { minHeight: w.minHeight } : {}),
            ...(w.resizable !== undefined ? { resizable: w.resizable } : {}),
            ...(w.aspectRatio !== undefined ? { aspectRatio: w.aspectRatio } : {}),
            ...(w.fullscreen !== undefined ? { fullscreen: w.fullscreen } : {}),
            ...(r.vramLimitMB !== undefined ? { vramLimitMB: r.vramLimitMB } : {}),
        },
    };
}

/** 逐字段合并：前者优先，缺的回落到后者。deskapp.json 压 Web App Manifest。 */
export function mergeIdentity(
    primary: AppManifest | null,
    fallback: AppManifest | null,
): AppManifest | null {
    if (!primary) return fallback;
    if (!fallback) return primary;
    return {
        name: primary.name ?? fallback.name,
        shortName: primary.shortName ?? fallback.shortName,
        backgroundColor: primary.backgroundColor ?? fallback.backgroundColor,
        themeColor: primary.themeColor ?? fallback.themeColor,
        display: primary.display ?? fallback.display,
        iconPath: primary.iconPath ?? fallback.iconPath,
        deskapp: { ...fallback.deskapp, ...primary.deskapp },
    };
}

export function declaredExecution(project: LoadedProject): DeclaredExecution | null {
    const hooks = project.manifest.hooks ?? {};
    const cmd = project.manifest.command;
    const commandLine = cmd
        ? (cmd.run?.trim() ||
          [cmd.command ?? '', ...(cmd.args ?? [])].join(' ').trim() ||
          null)
        : null;
    const startup = hooks.startup?.trim() || null;
    const shutdown = hooks.shutdown?.trim() || null;
    if (!startup && !commandLine && !shutdown) return null;
    return { startup, command: commandLine, shutdown };
}
