/**
 * `app://<项目根哈希>/...` —— 本地 webapp 的加载源。
 *
 * 不用 file:// 的三条硬理由：
 *   ① file:// 是不透明源（opaque origin）：localStorage / IndexedDB / SharedArrayBuffer 全部不可用；
 *   ② 构建产物里的 `/assets/index.js` 这类根绝对路径在 file:// 下解析到磁盘根，直接 404；
 *   ③ ES module 脚本在 file:// 下被 CORS 拒绝。
 * 注册成 standard + secure 的自定义协议后，页面拿到的是正常的安全源，行为与线上一致。
 *
 * 每个项目根目录映射到独立主机名：多个本地项目可同时打开，存储/缓存互不污染。
 */

import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';

export const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://local`;

/**
 * 每个本地项目一个独立源：`app://p<根路径哈希>/...`。
 * 这样多个本地项目可以同时打开，而且各自有独立的 origin（localStorage 等互不污染）。
 */
const roots = new Map<string, string>();
let crossOriginIsolated = false;

/** 必须在 app ready 之前调用。 */
export function registerAppScheme(): void {
    protocol.registerSchemesAsPrivileged([
        {
            scheme: APP_SCHEME,
            privileges: {
                standard: true,
                secure: true,
                supportFetchAPI: true,
                stream: true,
                corsEnabled: true,
                allowServiceWorkers: true,
            },
        },
    ]);
}

/** 项目根目录 → 稳定的 app:// 主机名。根路径不变，主机名就不变（存储/缓存得以保留）。 */
export function appHostForRoot(root: string): string {
    return `p${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16)}`;
}

/** 注册项目根目录并返回该项目的 app:// 入口 URL。 */
export function appUrlForRoot(root: string, entry: string): string {
    const host = appHostForRoot(root);
    roots.set(host, normalize(root));
    const path = entry
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
    return `${APP_SCHEME}://${host}/${path}`;
}

export function setCrossOriginIsolated(value: boolean): void {
    crossOriginIsolated = value;
}

/** 把一个 app:// URL 解析回本地文件路径（不在任何 root 内则返回 null）。 */
export function filePathForAppUrl(url: string): string | null {
    try {
        const u = new URL(url);
        if (u.protocol !== `${APP_SCHEME}:`) return null;
        const root = roots.get(u.host);
        if (!root) return null;
        const pathname = decodeURIComponent(u.pathname);
        const p = normalize(join(root, pathname));
        return isInside(root, p) ? p : null;
    } catch {
        return null;
    }
}

export function appOrigin(): string {
    return APP_ORIGIN;
}

function isInside(base: string, candidate: string): boolean {
    const rel = relative(base, candidate);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
}

function textResponse(status: number, body: string): Response {
    return new Response(body, {
        status,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
}

/** 在 app ready 之后调用一次。 */
export function installAppProtocol(): void {
    protocol.handle(APP_SCHEME, async (request) => {
        let host: string;
        try {
            host = new URL(request.url).host;
        } catch {
            return textResponse(400, 'bad request url');
        }
        const root = roots.get(host);
        if (!root) return textResponse(503, 'Deskapp: 该应用已关闭或未装载');

        let pathname: string;
        try {
            pathname = decodeURIComponent(new URL(request.url).pathname);
        } catch {
            return textResponse(400, 'bad request url');
        }

        if (pathname === '' || pathname === '/') pathname = '/index.html';

        // 路径穿越防护：normalize 之后必须仍在 root 之内
        let filePath = normalize(join(root, pathname));
        if (!isInside(root, filePath)) return textResponse(403, 'forbidden');

        if (existsSync(filePath) && statSync(filePath).isDirectory()) {
            filePath = join(filePath, 'index.html');
        }

        if (!existsSync(filePath)) {
            // 无扩展名的路径按 SPA 前端路由处理，回落到入口
            if (extname(pathname) === '') {
                const fallback = join(root, 'index.html');
                if (existsSync(fallback)) filePath = fallback;
                else return textResponse(404, `not found: ${pathname}`);
            } else {
                return textResponse(404, `not found: ${pathname}`);
            }
        }

        // Range 透传：<video>/<audio> 的 seek 依赖它
        const init: { headers?: Record<string, string> } = {};
        const range = request.headers.get('range');
        if (range) init.headers = { range };

        let upstream: Response;
        try {
            upstream = await net.fetch(pathToFileURL(filePath).toString(), init);
        } catch (err) {
            return textResponse(500, `read failed: ${String(err)}`);
        }

        const isHtml = extname(filePath).toLowerCase() === '.html';
        if (!crossOriginIsolated && !isHtml) return upstream;

        const headers = new Headers(upstream.headers);
        if (crossOriginIsolated) {
            headers.set('cross-origin-opener-policy', 'same-origin');
            headers.set('cross-origin-embedder-policy', 'require-corp');
            headers.set('cross-origin-resource-policy', 'same-origin');
        }
        // 入口 HTML 永不缓存，保证改一行代码 reload 就能看到
        if (isHtml) headers.set('cache-control', 'no-store');

        return new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers,
        });
    });
}
