// 启动脚本：把真正的服务丢到后台，自己立刻退出。
// 这是很常见的写法（docker compose up -d / ./start.sh &），
// 用来验证 sidecar 的就绪判据是"地址通不通"而不是"我们 spawn 的进程还在不在"。
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const child = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], {
    detached: true,          // 脱离本进程的进程组 —— Deskapp 收不到它
    stdio: 'ignore',
});
child.unref();
writeFileSync(join(import.meta.dirname, 'server.pid'), String(child.pid));
console.log(`started detached server pid=${child.pid}, exiting now`);
