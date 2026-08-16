/**
 * 本地服务 CORS 放行桥。
 *
 * 页面跑在 `app://<project-host>`，而项目声明的 dev server 在 `http://127.0.0.1:PORT`
 * —— 这是跨源。这里按「服务源 → 允许读取它的页面源」白名单给响应补 CORS 头。
 *
 * 注意：响应头里的 `Access-Control-Allow-Origin` 必须精确等于**发起请求的那个页面源**，
 * 不能把多个页面源拼成一个列表。所以这里先记录 `webContentsId → 页面源`，
 * 收到响应时按 `details.webContentsId` 反查来源，再决定是否放行。
 */

import { session } from 'electron';

/** webContentsId → 页面源（app://<host> 或 http(s) 源） */
const pageOrigins = new Map<number, string>();
/** 服务源 → 被允许读取它的页面源集合 */
const serviceOrigins = new Map<string, Set<string>>();
let installed = false;

export function registerPageOrigin(webContentsId: number, origin: string): void {
    pageOrigins.set(webContentsId, origin);
}

export function unregisterPageOrigin(webContentsId: number): void {
    pageOrigins.delete(webContentsId);
}

export function allowApiOrigin(serviceUrl: string | undefined, pageOrigin: string): void {
    if (!serviceUrl) return;
    let service: string;
    try {
        service = new URL(serviceUrl).origin;
    } catch {
        return;
    }

    let pages = serviceOrigins.get(service);
    if (!pages) {
        pages = new Set();
        serviceOrigins.set(service, pages);
    }
    pages.add(pageOrigin);

    if (installed) return;
    installed = true;

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const page = pageOrigins.get(details.webContentsId ?? -1);
        if (!page) return callback({});

        let serviceOfResponse: string;
        try {
            serviceOfResponse = new URL(details.url).origin;
        } catch {
            return callback({});
        }
        const allowedPages = serviceOrigins.get(serviceOfResponse);
        if (!allowedPages || !allowedPages.has(page)) return callback({});

        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Access-Control-Allow-Origin': [page],
                'Access-Control-Allow-Credentials': ['true'],
                'Access-Control-Allow-Headers': ['*'],
                'Access-Control-Allow-Methods': ['GET,POST,PUT,PATCH,DELETE,OPTIONS'],
            },
        });
    });
}
