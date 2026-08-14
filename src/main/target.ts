/**
 * 目标解析 + Web App Manifest 读取。
 *
 * Manifest 是「这是一个应用而不是一个网页」最自然的声明源：
 * 窗口标题、Dock 名称、启动底色、图标、初始显示模式全部由它决定。
 * 本地目录在**加载前**就能读到它，因此能在首帧之前把窗口底色设对 —— 这是消除启动白闪的关键。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { AppTarget, PerfProfile } from '../shared/types';

/** manifest 里 Deskapp 私有扩展字段。 */
export interface DeskappManifestExt {
    width?: number;
    height?: number;
    minWidth?: number;
    minHeight?: number;
    profile?: PerfProfile;
    fullscreen?: boolean;
    frameless?: boolean;
    vramLimitMB?: number;
    /** 窗口是否可缩放，默认 true */
    resizable?: boolean;
    /** 是否锁定宽高比（如 16/9）；0 = 不锁 */
    aspectRatio?: number;
}

export interface AppManifest {
    name: string | null;
    shortName: string | null;
    backgroundColor: string | null;
    themeColor: string | null;
    display: string | null;
    /** 绝对路径（本地目标）或绝对 URL（远端目标） */
    iconPath: string | null;
    deskapp: DeskappManifestExt;
}

export interface ResolvedTarget extends AppTarget {
    /** kind=dir 时的文件系统根目录 */
    root: string | null;
    /** kind=dir 时的入口文件相对路径 */
    entry: string;
}

export class TargetError extends Error {}

/** 把用户输入（目录 / html 文件 / URL）解析成可加载的目标。 */
export function resolveTarget(input: string): ResolvedTarget {
    if (/^https?:\/\//i.test(input)) {
        let label: string;
        try {
            label = new URL(input).host;
        } catch {
            throw new TargetError(`不是合法的 URL：${input}`);
        }
        return { kind: 'url', value: input, resolvedUrl: input, label, root: null, entry: '' };
    }

    const abs = isAbsolute(input) ? input : resolve(process.cwd(), input);
    if (!existsSync(abs)) throw new TargetError(`路径不存在：${abs}`);

    const st = statSync(abs);
    let root: string;
    let entry: string;
    if (st.isDirectory()) {
        root = abs;
        entry = 'index.html';
        if (!existsSync(join(root, entry))) {
            throw new TargetError(`目录里没有 index.html：${root}`);
        }
    } else {
        root = dirname(abs);
        entry = basename(abs);
    }

    return {
        kind: 'dir',
        value: abs,
        // 走自定义标准协议而不是 file://：file:// 是不透明源，
        // IndexedDB / SharedArrayBuffer / 模块脚本 / fetch 都会出问题，
        // 而且构建产物里的 /assets/... 绝对路径在 file:// 下直接失效。
        resolvedUrl: `app://local/${entry}`,
        label: basename(root),
        root,
        entry,
    };
}

const EMPTY_EXT: DeskappManifestExt = {};

function pickIcon(
    icons: unknown,
    base: (rel: string) => string,
): string | null {
    if (!Array.isArray(icons)) return null;
    let best: { size: number; src: string } | null = null;
    for (const icon of icons) {
        const src = (icon as { src?: unknown })?.src;
        if (typeof src !== 'string') continue;
        const sizes = String((icon as { sizes?: unknown })?.sizes ?? '');
        // "512x512 256x256" → 取最大边
        let size = 0;
        for (const m of sizes.matchAll(/(\d+)x(\d+)/g)) {
            size = Math.max(size, Number(m[1]), Number(m[2]));
        }
        if (!best || size > best.size) best = { size, src };
    }
    return best ? base(best.src) : null;
}

function parseManifestJson(
    raw: string,
    base: (rel: string) => string,
): AppManifest | null {
    let data: Record<string, unknown>;
    try {
        data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return null;
    }
    const str = (k: string): string | null => {
        const v = data[k];
        return typeof v === 'string' && v.length > 0 ? v : null;
    };
    const ext = (data.deskapp ?? EMPTY_EXT) as DeskappManifestExt;
    return {
        name: str('name'),
        shortName: str('short_name'),
        backgroundColor: str('background_color'),
        themeColor: str('theme_color'),
        display: str('display'),
        iconPath: pickIcon(data.icons, base),
        deskapp: typeof ext === 'object' && ext !== null ? ext : EMPTY_EXT,
    };
}

/** 从 index.html 里找 <link rel="manifest" href="..."> —— 只做正则扫描，不引 HTML 解析器。 */
function manifestHrefFromHtml(html: string): string | null {
    const linkRe = /<link\b[^>]*>/gi;
    for (const tag of html.match(linkRe) ?? []) {
        if (!/rel\s*=\s*["']?\s*manifest\s*["']?/i.test(tag)) continue;
        const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
        if (href) return href[1];
    }
    return null;
}

/**
 * 读取本地目标的 manifest。顺序：index.html 里声明的 → 根目录 manifest.json → 无。
 * 读不到不算错误，退化用目录名当应用名。
 */
export function readLocalManifest(target: ResolvedTarget): AppManifest | null {
    if (target.kind !== 'dir' || !target.root) return null;
    const root = target.root;
    const candidates: string[] = [];
    const entryPath = join(root, target.entry);
    if (existsSync(entryPath)) {
        try {
            const declared = manifestHrefFromHtml(readFileSync(entryPath, 'utf8'));
            if (declared && !/^https?:\/\//i.test(declared)) {
                candidates.push(join(root, declared.replace(/^\.?\//, '')));
            }
        } catch {
            /* 读不了入口文件也没关系 */
        }
    }
    candidates.push(join(root, 'manifest.json'));
    candidates.push(join(root, 'manifest.webmanifest'));

    for (const p of candidates) {
        if (!existsSync(p)) continue;
        try {
            const m = parseManifestJson(readFileSync(p, 'utf8'), (rel) => {
                if (/^https?:\/\//i.test(rel)) return rel;
                return join(dirname(p), rel.replace(/^\.?\//, ''));
            });
            if (m) return m;
        } catch {
            /* 下一个候选 */
        }
    }
    return null;
}

/** 解析远端目标的 manifest（在页面加载完成后由主进程注入脚本抓取）。 */
export function parseRemoteManifest(raw: string, pageUrl: string): AppManifest | null {
    return parseManifestJson(raw, (rel) => {
        try {
            return new URL(rel, pageUrl).toString();
        } catch {
            return rel;
        }
    });
}

/** manifest.display 是否要求全屏起。 */
export function manifestWantsFullscreen(m: AppManifest | null): boolean {
    if (!m) return false;
    if (m.deskapp.fullscreen) return true;
    return m.display === 'fullscreen';
}
