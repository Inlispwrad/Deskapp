// 常驻命令行（服务）。再 spawn 一个孙子进程验证退出时整棵树被收掉。
//
// 孙子的存活由**服务端**代查再报给页面 —— 页面直接 fetch 3112 会被 CORS 挡掉，
// 因为 Deskapp 只放行清单里 readyUrl 声明的那个源（这是刻意收窄的范围，不是 bug）。
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const PORT = 3111;
const CHILD_PORT = 3112;

spawn(process.execPath, ['-e',
  `require('http').createServer((q,s)=>s.end('grandchild')).listen(${CHILD_PORT},()=>console.log('grandchild on ${CHILD_PORT}'))`,
], { stdio: 'inherit' });

const probeGrandchild = () => new Promise((resolve) => {
  const req = globalThis.fetch
    ? fetch(`http://127.0.0.1:${CHILD_PORT}/`).then(() => resolve(true)).catch(() => resolve(false))
    : resolve(false);
  return req;
});

createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  let prepared = null;
  try { prepared = JSON.parse(readFileSync(join(import.meta.dirname, 'generated.json'), 'utf8')).preparedAt; } catch {}
  const grandchild = await probeGrandchild();
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ prepared, grandchild, port: PORT }));
}).listen(PORT, () => console.log(`server on ${PORT}`));
