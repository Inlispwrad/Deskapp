import { createServer } from 'node:http';
createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>脱离式服务</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23ffb84c'/%3E%3C/svg%3E">
<style>:root{color-scheme:dark}body{margin:0;height:100vh;display:grid;place-items:center;
background:#14100b;color:#ffd9a3;font:13px/1.7 "Helvetica Neue",Helvetica,sans-serif;letter-spacing:.06em;text-align:center}
b{display:block;font-size:20px;color:#ffb84c;margin-bottom:8px}</style>
<div><b>DETACHED OK</b>启动脚本已退出，服务由它派生的后台进程提供<br><code>pid ${process.pid}</code></div>`);
}).listen(3120, () => console.log('detached server on 3120'));
