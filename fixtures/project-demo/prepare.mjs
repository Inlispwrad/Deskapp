// startup 钩子：装载前跑一次，跑完（成功）才继续。
// 这里写一个"构建产物"证明它确实在页面加载之前执行了。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const stamp = new Date().toISOString();
writeFileSync(join(import.meta.dirname, 'generated.json'), JSON.stringify({ preparedAt: stamp }, null, 2));
console.log(`prepare: 已生成 generated.json（${stamp}）`);
