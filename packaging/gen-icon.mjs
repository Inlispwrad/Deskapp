/**
 * 生成占位应用图标（Swiss Style 几何构成）。零依赖，手写 PNG 编码。
 *
 * 存在的理由：仓库里不该躺着来历不明的二进制。图标是生成出来的，
 * 想改配色/构图就改这里重新生成，而不是"某个人某天丢进来的一张图"。
 *
 * 它是**占位符**，不是任何品牌的标识。有正式图标就直接替换掉 PNG。
 *
 *   node packaging/gen-icon.mjs <输出路径> [边长=512] [色板=red|slate]
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
const S = Number(process.argv[3] ?? 512);
const palette = process.argv[4] ?? 'red';

if (!out) {
    console.error('用法: node packaging/gen-icon.mjs <输出路径> [边长] [red|slate]');
    process.exit(2);
}

const PALETTES = {
    red: { bg: [10, 11, 14], mark: [227, 6, 19], rule: [240, 240, 242] },
    slate: { bg: [14, 15, 19], mark: [76, 156, 255], rule: [230, 231, 236] },
};
const P = PALETTES[palette] ?? PALETTES.red;

const px = Buffer.alloc(S * S * 4);
const set = (x, y, [r, g, b]) => {
    const i = (y * S + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
};
const rect = (x0, y0, x1, y1, color) => {
    for (let y = Math.max(0, y0); y < Math.min(S, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(S, x1); x++) set(x, y, color);
    }
};

// 构图按边长比例给，任意尺寸都成立。刻意不对称——Swiss 不做居中对称。
const u = S / 128;
rect(0, 0, S, S, P.bg);
rect(22 * u, 22 * u, 78 * u, 78 * u, P.mark); // 实心方块
rect(22 * u, 92 * u, 106 * u, 100 * u, P.rule); // 横向结构线
rect(98 * u, 22 * u, 100 * u, 100 * u, P.rule); // 竖向细线，打破对称

const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return (buf) => {
        let c = -1;
        for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
        return (c ^ -1) >>> 0;
    };
})();

const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(CRC(body));
    return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA

// 每行前置一个 filter byte 0（无过滤）
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
    const off = y * (S * 4 + 1);
    raw[off] = 0;
    px.copy(raw, off + 1, y * S * 4, (y + 1) * S * 4);
}

writeFileSync(
    out,
    Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]),
);
console.log(`wrote ${out} (${S}x${S}, ${palette})`);
