/**
 * 把 electron-builder 在设备目录里再套的那一层压平。
 *
 * 起因：`directories.output` 设成 `apps/${os}-${arch}` 之后，builder 仍会在里面
 * 按自己的命名再建一层（`mac-arm64/` / `win-unpacked/` / `linux-unpacked/`），
 * 结果是 `apps/mac-arm64/mac-arm64/Deskapp.app` 这种重复路径。
 *
 * builder 没有关掉这层的选项，所以构建后压平一次。这样
 * `pnpm dist:*` 的产物与 `--export` 的产物落在同一层，apps/ 里看到的就是一排应用。
 *
 *   node scripts/flatten-apps.mjs [apps 目录]
 */

import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** electron-builder 自己那层的命名规律 */
const INNER = /^(mac|win|linux)(-[a-z0-9]+)*(-unpacked)?$/;

const appsDir = resolve(process.argv[2] ?? 'apps');
if (!existsSync(appsDir)) {
    console.log(`[flatten] ${appsDir} 不存在，跳过`);
    process.exit(0);
}

let moved = 0;
for (const device of readdirSync(appsDir)) {
    const deviceDir = join(appsDir, device);
    if (!statSync(deviceDir).isDirectory()) continue;

    for (const child of readdirSync(deviceDir)) {
        const inner = join(deviceDir, child);
        if (!INNER.test(child) || !statSync(inner).isDirectory()) continue;

        for (const item of readdirSync(inner)) {
            const from = join(inner, item);
            const to = join(deviceDir, item);
            // 同名已存在（重复构建）：以新的为准
            if (existsSync(to)) rmSync(to, { recursive: true, force: true });
            renameSync(from, to);
            moved++;
        }
        rmSync(inner, { recursive: true, force: true });
        console.log(`[flatten] ${device}/${child}/* → ${device}/`);
    }
}

// builder 会把调试文件与临时图标转换目录留在 output 附近，顺手清掉
rmSync(join(appsDir, 'builder-debug.yml'), { force: true });
for (const name of readdirSync(appsDir)) {
    const dir = join(appsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    rmSync(join(dir, '.icon-icns'), { recursive: true, force: true });
}

// 清掉 builder 在顶层留下的空壳目录（如 x64 构建留下的 `mac/`）。
// 只删空的 —— 设备目录本身也匹配 INNER，非空的绝不能碰。
for (const name of readdirSync(appsDir)) {
    const dir = join(appsDir, name);
    if (!INNER.test(name) || !statSync(dir).isDirectory()) continue;
    if (readdirSync(dir).length === 0) {
        rmSync(dir, { recursive: true, force: true });
        console.log(`[flatten] 清掉空壳 ${name}/`);
    }
}

console.log(moved > 0 ? `[flatten] 完成，移动 ${moved} 项` : '[flatten] 无需压平');
