/**
 * 页面图标的缓存与采用。
 *
 * 目标：专属打包的应用用**被装载网页自己的图标**当启动图标，而不是打包时塞的占位图。
 * 三层，可行性依次递减，代码里也是分开的：
 *
 *   ① 运行中的 Dock / 任务栏图标 —— 全平台可行，立即生效
 *   ② 缓存到 userData，下次启动在页面加载**之前**就应用 —— 全平台可行
 *      （这就是"第一次运行以后才更新"的那个语义）
 *   ③ 改 .app 的 icon.icns，让 Finder 与未运行时的 Dock 也跟着变 —— **仅 macOS**
 *      Windows 的图标编在 exe 的 PE 资源里，运行时改不了；Linux 在 .desktop 里，另说
 *
 * 两个非平凡的实现点：
 *
 * **SVG / ICO 栅格化**：`nativeImage` 只认 PNG/JPEG，而 favicon 常见是 SVG 或 ICO。
 * 这里用一个隐藏的 Chromium 窗口把图画到指定尺寸再 capturePage —— 借 Chromium 自己的
 * 解码器，格式覆盖面等于浏览器，且零外部依赖。
 *
 * **签名**：改 .app 里的资源可能破坏代码签名（arm64 上签名坏了会拒绝启动）。
 * 所以只在签名**本来就没有封资源**时才动手（electron-builder 的 adhoc 签名就是这种），
 * 正式签名的包一律拒绝并说明原因 —— 不能为了换图标把人家的包搞坏。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BrowserWindow, app, nativeImage, type NativeImage } from 'electron';
import { buildIcns } from './icns';

export type IconLog = (level: 'info' | 'warn' | 'error', message: string) => void;

/** 栅格化用的边长。取 1024 是为了能填满 .icns 最大那一档。 */
const RASTER_SIZE = 1024;

/**
 * favicon 直接拿去当应用图标不行 —— 大量站点的 favicon 是**为深色 UI 画的纯白字形**
 * （白字 + 透明底），放到 Finder 的浅色背景上完全隐形。
 *
 * 所以合成到一块圆角底板上再用。这同时也让它更像正常的 macOS 应用图标：
 * macOS 不像 iOS 那样自动裁圆角，图标自己就该是带留白的圆角方形。
 */
const PLATE_RADIUS_RATIO = 0.225;
const PLATE_INSET_RATIO = 0.18;
/** 没有任何底色信息时的兜底底板色。 */
const DEFAULT_PLATE = '#16181f';

interface CacheIndex {
    /** key → { hash, file } */
    [key: string]: { hash: string; file: string; sourceUrl: string };
}

export class IconCache {
    private dir: string;
    private indexPath: string;
    /** 记录写进包里的 icns 的内容哈希 —— 重新打包后包内会变回占位图，靠它发现失同步 */
    private stampPath: string;
    private index: CacheIndex = {};

    constructor(
        private log: IconLog,
        baseDir = join(app.getPath('userData'), 'icons'),
    ) {
        this.dir = baseDir;
        this.indexPath = join(this.dir, 'index.json');
        this.stampPath = join(this.dir, 'bundle-icon.json');
        try {
            mkdirSync(this.dir, { recursive: true });
            if (existsSync(this.indexPath)) {
                this.index = JSON.parse(readFileSync(this.indexPath, 'utf8')) as CacheIndex;
            }
        } catch {
            this.index = {};
        }
    }

    /** 读取已缓存的图标。启动时调用 —— 早于页面加载，所以第二次运行就直接是对的图标。 */
    load(key: string): NativeImage | null {
        const entry = this.index[key];
        if (!entry) return null;
        const p = join(this.dir, entry.file);
        if (!existsSync(p)) return null;
        try {
            const img = nativeImage.createFromPath(p);
            return img.isEmpty() ? null : img;
        } catch {
            return null;
        }
    }

    /** 已缓存图标的内容哈希，用来判断页面图标有没有换。 */
    hashOf(key: string): string | null {
        return this.index[key]?.hash ?? null;
    }

    /**
     * 缓存一张已经解码好的图（例如 manifest / deskapp.json 的图标）。
     * 与 adopt() 的区别：这里不做网页栅格化，直接存 PNG。
     */
    store(key: string, img: NativeImage): void {
        if (img.isEmpty()) return;
        try {
            const png = img.resize({ width: 256, height: 256, quality: 'best' }).toPNG();
            const hash = createHash('sha256').update(png).digest('hex').slice(0, 16);
            const file = `${hash}.png`;
            writeFileSync(join(this.dir, file), png);
            this.index[key] = { hash, file, sourceUrl: '' };
            writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf8');
        } catch (err) {
            this.log('warn', `图标缓存写盘失败：${String(err)}`);
        }
    }

    /**
     * 抓取页面图标并缓存。
     * @param plateColor 底板色，通常取 manifest 的 background_color
     * @returns 新图标（与已缓存内容相同时返回 null，表示无需再做任何事）
     */
    async adopt(key: string, url: string, plateColor?: string | null): Promise<NativeImage | null> {
        const plate = normalizeColor(plateColor) ?? DEFAULT_PLATE;
        const img = await rasterize(url, RASTER_SIZE, this.log, plate);
        if (!img) {
            this.log('warn', `页面图标栅格化失败，保留原图标：${url}`);
            return null;
        }
        const png = img.toPNG();
        // 哈希把底板色也算进去：换了底色应当视为换了图标
        const hash = createHash('sha256')
            .update(png)
            .update(plate)
            .digest('hex')
            .slice(0, 16);
        if (this.index[key]?.hash === hash && existsSync(join(this.dir, this.index[key].file))) {
            return null; // 没变
        }
        const file = `${hash}.png`;
        try {
            writeFileSync(join(this.dir, file), png);
            this.index[key] = { hash, file, sourceUrl: url };
            writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2), 'utf8');
        } catch (err) {
            this.log('warn', `图标缓存写盘失败：${String(err)}`);
            return img; // 盘写不进去，至少这次运行能用上
        }
        this.log('info', `已缓存页面图标（${hash}），下次启动即生效`);
        return img;
    }

    /**
     * 包里的启动图标是不是我们写进去的那一份。
     *
     * 为什么需要这个判断：重新打包会把 icon.icns 重置成占位图，而 userData 里的缓存还在。
     * 如果只在"抓到新 favicon"时才装图标，重新打包后就永远装不回去了 ——
     * 判据必须是"包内现状"，不是"本次运行有没有抓图标"。
     *
     * 平台不支持替换时返回 true（视为无事可做），避免每次启动都刷一条无用日志。
     */
    bundleIconInSync(): boolean {
        const target = this.resolveBundleIcns();
        if (!target) return true;
        try {
            const current = hashBytes(readFileSync(target.icnsPath));
            const stamp = JSON.parse(readFileSync(this.stampPath, 'utf8')) as { hash?: string };
            return stamp.hash === current;
        } catch {
            return false;
        }
    }

    /**
     * 把图标写进 .app 的 icon.icns，让 Finder 与未运行时的 Dock 也跟着变。
     * 拒绝的情形都会说明原因，不静默失败。
     */
    installBundleIcon(img: NativeImage): { ok: boolean; reason?: string } {
        if (process.platform !== 'darwin') {
            return {
                ok: false,
                reason:
                    process.platform === 'win32'
                        ? 'Windows 的启动图标编在 exe 的 PE 资源里，运行时无法替换（Dock/任务栏图标已更新）'
                        : 'Linux 的启动图标在 .desktop 条目里，不由 app 自身管理（任务栏图标已更新）',
            };
        }
        if (!app.isPackaged) {
            return { ok: false, reason: '未打包运行，没有 .app 包可改（Dock 图标已更新）' };
        }

        const target = this.resolveBundleIcns();
        if (!target) return { ok: false, reason: '定位不到包内的 .icns' };

        const guard = signatureGuard(target.appRoot);
        if (!guard.safe) return { ok: false, reason: guard.reason };

        const icns = buildIcns(img);
        try {
            writeFileSync(target.icnsPath, icns);
            writeFileSync(
                this.stampPath,
                JSON.stringify({ hash: hashBytes(icns), path: target.icnsPath }, null, 2),
                'utf8',
            );
        } catch (err) {
            return { ok: false, reason: `写入 ${target.icnsPath} 失败：${String(err)}` };
        }

        // macOS 的图标缓存很顽固：改 mtime 促使 LaunchServices 重新读取
        try {
            spawnSync('touch', [target.appRoot]);
        } catch {
            /* 无所谓 */
        }

        return { ok: true };
    }

    /** 仅在 macOS 且已打包时可定位。 */
    private resolveBundleIcns(): { appRoot: string; icnsPath: string } | null {
        if (process.platform !== 'darwin' || !app.isPackaged) return null;
        // process.resourcesPath = <App>.app/Contents/Resources
        const appRoot = dirname(dirname(process.resourcesPath));
        if (!appRoot.endsWith('.app')) return null;
        const icnsPath = this.findIcns(process.resourcesPath);
        return icnsPath ? { appRoot, icnsPath } : null;
    }

    private findIcns(resourcesDir: string): string | null {
        const preferred = join(resourcesDir, 'icon.icns');
        if (existsSync(preferred)) return preferred;
        try {
            const hit = readdirSync(resourcesDir).find((f) => f.endsWith('.icns'));
            return hit ? join(resourcesDir, hit) : null;
        } catch {
            return null;
        }
    }
}

/**
 * 只在签名不封资源时才允许改包内文件。
 *
 * electron-builder 的 adhoc 签名（`Sealed Resources=none`）改资源不会让签名失效；
 * 而正式签名会把资源一起封进去，改了之后 Gatekeeper 会拒绝启动 —— 那种包必须放过。
 */
function signatureGuard(appRoot: string): { safe: boolean; reason?: string } {
    let out = '';
    try {
        const r = spawnSync('codesign', ['-dvvv', appRoot], { encoding: 'utf8' });
        out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    } catch {
        // 没有 codesign（极少见）：无法判断，保守放弃
        return { safe: false, reason: '无法执行 codesign 判断签名状态，已跳过改包' };
    }

    if (/code object is not signed at all/.test(out)) return { safe: true };
    if (/Sealed Resources=none/.test(out)) return { safe: true };
    if (/Signature=adhoc/.test(out) && !/Sealed Resources=/.test(out)) return { safe: true };
    return {
        safe: false,
        reason:
            'app 带正式代码签名且封了资源，替换 icon.icns 会让签名失效导致无法启动 —— 已跳过。' +
            '若要用页面图标，请在打包时把它作为 build 图标。',
    };
}

function hashBytes(buf: Buffer): string {
    return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/** 只接受形如 #rgb / #rrggbb / #rrggbbaa 的颜色 —— 它要进 CSS，不能是任意字符串。 */
function normalizeColor(value: string | null | undefined): string | null {
    if (!value) return null;
    const v = value.trim();
    return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : null;
}

/**
 * 用隐藏的 Chromium 窗口把任意格式的图标栅格化成指定尺寸。
 *
 * 为什么不直接 nativeImage.createFromBuffer：它只认 PNG / JPEG，
 * 而 favicon 常见是 SVG（DSH 就是）或 ICO，都解不了。
 * 交给 Chromium 渲染，格式覆盖面等于浏览器，且不引入任何依赖。
 */
async function rasterize(
    url: string,
    size: number,
    log: IconLog,
    plateColor: string,
): Promise<NativeImage | null> {
    let win: BrowserWindow | null = null;
    try {
        win = new BrowserWindow({
            width: size,
            height: size,
            show: false,
            frame: false,
            transparent: true,
            // 首帧不画就 capturePage 会拿到空图
            paintWhenInitiallyHidden: true,
            webPreferences: {
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
                backgroundThrottling: false,
            },
        });

        const radius = Math.round(size * PLATE_RADIUS_RATIO);
        const inset = Math.round(size * PLATE_INSET_RATIO);
        const html =
            `<!doctype html><meta charset="utf-8"><style>` +
            `html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:transparent;overflow:hidden}` +
            `.plate{box-sizing:border-box;width:100%;height:100%;padding:${inset}px;` +
            `background:${plateColor};border-radius:${radius}px;` +
            `display:flex;align-items:center;justify-content:center}` +
            `img{width:100%;height:100%;object-fit:contain;display:block}` +
            `</style><div class="plate"><img id="i"></div>`;
        await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

        // URL 经 JSON.stringify 注入，避免引号截断
        const ok = (await win.webContents.executeJavaScript(
            `new Promise((resolve) => {
                const img = document.getElementById('i');
                const done = (v) => resolve(v);
                img.onload = () => done(img.naturalWidth > 0 || img.naturalHeight > 0);
                img.onerror = () => done(false);
                img.src = ${JSON.stringify(url)};
                setTimeout(() => done(false), 5000);
            })`,
        )) as boolean;

        if (!ok) {
            log('warn', `图标加载失败：${url}`);
            return null;
        }
        // 让解码后的内容真的画上去
        await new Promise((r) => setTimeout(r, 120));

        const shot = await win.webContents.capturePage();
        return shot.isEmpty() ? null : shot;
    } catch (err) {
        log('warn', `图标栅格化异常：${String(err)}`);
        return null;
    } finally {
        win?.destroy();
    }
}
