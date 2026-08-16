/**
 * .ico 编码器。现代 Windows 接受 PNG 载荷的 ICO（Vista 起）。
 * 用 rcedit 给导出的 exe 换图标时，需要的就是这种 .ico 文件。
 */

import type { NativeImage } from 'electron';

const ICO_SIZES = [16, 32, 48, 64, 128, 256];

export function buildIco(img: NativeImage): Buffer {
    const dirs: Buffer[] = [];
    const datas: Buffer[] = [];
    let offset = 6 + ICO_SIZES.length * 16;

    for (const size of ICO_SIZES) {
        const png = img.resize({ width: size, height: size, quality: 'best' }).toPNG();
        const dir = Buffer.alloc(16);
        dir[0] = size >= 256 ? 0 : size; // 0 表示 256
        dir[1] = size >= 256 ? 0 : size;
        dir[2] = 0; // color count low
        dir[3] = 0; // color count high
        dir.writeUInt16LE(1, 4); // planes
        dir.writeUInt16LE(32, 6); // bpp
        dir.writeUInt32LE(png.length, 8);
        dir.writeUInt32LE(offset, 12);
        offset += png.length;
        dirs.push(dir);
        datas.push(png);
    }

    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(ICO_SIZES.length, 4);
    return Buffer.concat([header, ...dirs, ...datas]);
}
