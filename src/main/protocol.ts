/**
 * `app://local/...` —— 本地 webapp 的加载源。
 *
 * 不用 file:// 的三条硬理由：
 *   ① file:// 是不透明源（opaque origin）：localStorage / IndexedDB / SharedArrayBuffer 全部不可用；
 *   ② 构建产物里的 `/assets/index.js` 这类根绝对路径在 file:// 下解析到磁盘根，直接 404；
 *   ③ ES module 脚本在 file:// 下被 CORS 拒绝。
 * 注册成 standard + secure 的自定义协议后，页面拿到的是正常的安全源，行为与线上一致。
 */

import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';

export const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://local`;

let root: string | null = null;
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

export function setAppRoot(dir: string | null): void {
    root = dir ? normalize(dir) : null;
}

export function setCrossOriginIsolated(value: boolean): void {
    crossOriginIsolated = value;
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
        if (!root) return textResponse(503, 'Deskapp: 尚未装载任何应用');

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
