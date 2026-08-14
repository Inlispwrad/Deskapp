// shutdown 钩子：关闭时跑一次。删掉 startup 生成的东西。
import { rmSync } from 'node:fs';
import { join } from 'node:path';
rmSync(join(import.meta.dirname, 'generated.json'), { force: true });
console.log('cleanup: 已清理 generated.json');
