/**
 * sidecar 的回归测试用假后端。
 *
 * 刻意再 spawn 一个**孙子进程**并让它也占一个端口 ——
 * 用来验证退出时收掉的是整棵进程树，而不是只杀直接子进程。
 * 只杀直接子进程的话，孙子会变孤儿继续占端口，下次启动就冲突。
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.PORT ?? 3099);
const CHILD_PORT = PORT + 1;

const grandchild = spawn(
    process.execPath,
    [
        '-e',
        `require('http').createServer((q, s) => s.end('grandchild')).listen(${CHILD_PORT}, () => console.log('grandchild listening on ${CHILD_PORT}'))`,
    ],
    { stdio: 'inherit' },
);

const PAGE = `<!doctype html><meta charset="utf-8"><title>Sidecar Test</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%2300c853'/%3E%3C/svg%3E">
<style>
  :root{color-scheme:dark}
  body{margin:0;height:100vh;display:grid;place-items:center;background:#0b1410;
       color:#8ef0b8;font:13px/1.7 "Helvetica Neue",Helvetica,sans-serif;
       letter-spacing:.06em;text-align:center}
  b{display:block;font-size:20px;margin-bottom:8px;color:#3ddc84}
  code{color:#6f7a74;font-size:11px}
</style>
<b>SIDECAR OK</b>
由宿主拉起的后端正在服务这个页面
<code>parent :${PORT} &nbsp;·&nbsp; grandchild :${CHILD_PORT}</code>
<script>
  // 完全静止的页面：不请求 rAF。用来验证标题栏在"页面响应式但没在渲染"时
  // 显示的是刷新率上限 + MS 0，而不是误导人的 "—" 或被空闲拖低的均值。
</script>`;

createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
}).listen(PORT, () => console.log(`fake sidecar listening on ${PORT}`));

process.on('SIGTERM', () => {
    grandchild.kill('SIGTERM');
    process.exit(0);
});
