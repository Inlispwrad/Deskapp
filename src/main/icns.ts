/**
 * .icns 编码器。手写而不是调 `iconutil` / `sips`：
 * 不依赖外部命令、可在任意进程内完成，也免去建临时 iconset 目录。
 * 格式已用苹果自己的 `iconutil -c iconset` 反解验证过。
 *
 * 两个使用方：图标缓存（把页面 favicon 装进包）与项目导出（把项目图标装进导出物）。
 */

import type { NativeImage } from 'electron';

/** 尺寸与对应的 ICNS 类型码。现代 macOS 全部接受 PNG 载荷。 */
const ICNS_ENTRIES: Array<[type: string, size: number]> = [
    ['icp4', 16],
    ['icp5', 32],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
];

/** 组装 .icns：文件头 + 若干 (4字节类型 + 4字节长度 + PNG) 条目。 */
export function buildIcns(img: NativeImage): Buffer {
    const parts: Buffer[] = [];
    for (const [type, size] of ICNS_ENTRIES) {
        const png = img.resize({ width: size, height: size, quality: 'best' }).toPNG();
        const header = Buffer.alloc(8);
        header.write(type, 0, 4, 'ascii');
        header.writeUInt32BE(png.length + 8, 4);
        parts.push(header, png);
    }
    const body = Buffer.concat(parts);
    const head = Buffer.alloc(8);
    head.write('icns', 0, 4, 'ascii');
    head.writeUInt32BE(body.length + 8, 4);
    return Buffer.concat([head, body]);
}
