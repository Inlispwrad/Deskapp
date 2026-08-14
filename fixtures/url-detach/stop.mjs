// 关闭脚本：Deskapp 收不到脱离出去的进程，必须由项目自己停。
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const f = join(import.meta.dirname, 'server.pid');
try {
    const pid = Number(readFileSync(f, 'utf8'));
    process.kill(pid, 'SIGTERM');
    console.log(`stopped detached server pid=${pid}`);
} catch (e) { console.log(`nothing to stop: ${e.code ?? e}`); }
rmSync(f, { force: true });
