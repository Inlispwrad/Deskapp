/** 配置持久化：窗口位置、最近打开、运行期设置。存在 userData 目录下。 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import type { AppTarget, HostSettings } from '../shared/types';

export interface WindowBounds {
    width: number;
    height: number;
    x?: number;
    y?: number;
    maximized?: boolean;
}

/** 某个项目的命令执行授权。fingerprint 变了要重新确认。 */
export interface ConsentRecord {
    fingerprint: string;
    decision: 'run' | 'page-only';
}

export interface PersistedConfig {
    version: 1;
    /** 按目标 key 记住各自的窗口尺寸 —— 不同应用该有不同窗口 */
    windows: Record<string, WindowBounds>;
    recents: AppTarget[];
    settings: Partial<HostSettings>;
    panelVisible: boolean;
    /** 项目根目录 → 执行授权 */
    consents?: Record<string, ConsentRecord>;
}

const MAX_RECENTS = 12;

const DEFAULTS: PersistedConfig = {
    version: 1,
    windows: {},
    recents: [],
    settings: {},
    panelVisible: false,
    consents: {},
};

let cache: PersistedConfig | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function configPath(): string {
    return join(app.getPath('userData'), 'config.json');
}

export function loadConfig(): PersistedConfig {
    if (cache) return cache;
    try {
        const raw = readFileSync(configPath(), 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistedConfig>;
        cache = {
            ...DEFAULTS,
            ...parsed,
            windows: parsed.windows ?? {},
            recents: Array.isArray(parsed.recents) ? parsed.recents : [],
            settings: parsed.settings ?? {},
        };
    } catch {
        // 首次运行或文件损坏：用默认值，不打扰用户
        cache = { ...DEFAULTS, windows: {}, recents: [], settings: {} };
    }
    return cache;
}

/** 延迟合并写盘，避免拖动窗口时高频 IO。 */
export function saveConfig(patch: Partial<PersistedConfig>): void {
    const cfg = loadConfig();
    Object.assign(cfg, patch);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushConfig, 400);
}

export function flushConfig(): void {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (!cache) return;
    try {
        const p = configPath();
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8');
    } catch (err) {
        console.error('[deskapp] 配置写盘失败:', err);
    }
}

/** 目标的稳定标识，用来分别记住各应用的窗口尺寸。 */
export function targetKey(target: AppTarget | null): string {
    if (!target) return '__launcher__';
    return `${target.kind}:${target.value}`;
}

export function rememberWindow(target: AppTarget | null, bounds: WindowBounds): void {
    const cfg = loadConfig();
    cfg.windows[targetKey(target)] = bounds;
    saveConfig({ windows: cfg.windows });
}

export function recallWindow(target: AppTarget | null): WindowBounds | null {
    return loadConfig().windows[targetKey(target)] ?? null;
}

export function addRecent(target: AppTarget): AppTarget[] {
    const cfg = loadConfig();
    const key = targetKey(target);
    const next = [target, ...cfg.recents.filter((r) => targetKey(r) !== key)].slice(
        0,
        MAX_RECENTS,
    );
    saveConfig({ recents: next });
    return next;
}

export function clearRecents(): AppTarget[] {
    saveConfig({ recents: [] });
    return [];
}
