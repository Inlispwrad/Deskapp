/**
 * WebGL / WebGPU 格式 → 每像素字节数。
 *
 * 口径说明（README 也会写）：这是**记账估算**，不是驱动实际分配量。
 * 已知偏差来源：
 *   - 三通道格式（RGB8 / RGB16F / RGB32F）在绝大多数 GPU 上按四通道存储，这里按四通道算；
 *   - 驱动会按 tile / 对齐规则再补齐，实际占用 ≥ 记账值；
 *   - 压缩纹理按上传的 byteLength 计，与实际一致。
 * 结论：记账值是**下界**，用于"离 400MB 死线还有多远"的判断足够，不能当精确显存读数。
 */

/* WebGL 枚举（避免依赖上下文实例取常量） */
const GL = {
    ALPHA: 0x1906,
    RGB: 0x1907,
    RGBA: 0x1908,
    LUMINANCE: 0x1909,
    LUMINANCE_ALPHA: 0x190a,
    RED: 0x1903,
    RG: 0x8227,
    RED_INTEGER: 0x8d94,
    RG_INTEGER: 0x8228,
    RGB_INTEGER: 0x8d98,
    RGBA_INTEGER: 0x8d99,
    DEPTH_COMPONENT: 0x1902,
    DEPTH_STENCIL: 0x84f9,

    UNSIGNED_BYTE: 0x1401,
    BYTE: 0x1400,
    UNSIGNED_SHORT: 0x1403,
    SHORT: 0x1402,
    UNSIGNED_INT: 0x1405,
    INT: 0x1404,
    FLOAT: 0x1406,
    HALF_FLOAT: 0x140b,
    HALF_FLOAT_OES: 0x8d61,
    UNSIGNED_SHORT_4_4_4_4: 0x8033,
    UNSIGNED_SHORT_5_5_5_1: 0x8034,
    UNSIGNED_SHORT_5_6_5: 0x8363,
    UNSIGNED_INT_24_8: 0x84fa,
    UNSIGNED_INT_2_10_10_10_REV: 0x8368,
    UNSIGNED_INT_10F_11F_11F_REV: 0x8c3b,
    UNSIGNED_INT_5_9_9_9_REV: 0x8c3e,
    FLOAT_32_UNSIGNED_INT_24_8_REV: 0x8dad,
} as const;

/** 有明确尺寸的 internalformat → 字节/像素。 */
const SIZED_FORMAT_BYTES: Record<number, number> = {
    /* 8 位 */
    0x8229: 1, // R8
    0x8f94: 1, // R8_SNORM
    0x8232: 1, // R8UI
    0x8231: 1, // R8I
    0x8d48: 1, // STENCIL_INDEX8
    /* 16 位 */
    0x822b: 2, // RG8
    0x8f95: 2, // RG8_SNORM
    0x8238: 2, // RG8UI
    0x8237: 2, // RG8I
    0x822d: 2, // R16F
    0x8234: 2, // R16UI
    0x8233: 2, // R16I
    0x8056: 2, // RGBA4
    0x8057: 2, // RGB5_A1
    0x8d62: 2, // RGB565
    0x81a5: 2, // DEPTH_COMPONENT16
    /* 32 位 */
    0x8058: 4, // RGBA8
    0x8f97: 4, // RGBA8_SNORM
    0x8c43: 4, // SRGB8_ALPHA8
    0x8d7c: 4, // RGBA8UI
    0x8d8e: 4, // RGBA8I
    0x8051: 4, // RGB8   —— 实际按 RGBA8 存
    0x8f96: 4, // RGB8_SNORM
    0x8c41: 4, // SRGB8  —— 同上
    0x8059: 4, // RGB10_A2
    0x906f: 4, // RGB10_A2UI
    0x8c3a: 4, // R11F_G11F_B10F
    0x8c3d: 4, // RGB9_E5
    0x822e: 4, // R32F
    0x822f: 4, // RG16F
    0x8236: 4, // R32UI
    0x8235: 4, // R32I
    0x823a: 4, // RG16UI
    0x8239: 4, // RG16I
    0x81a6: 4, // DEPTH_COMPONENT24
    0x8cac: 4, // DEPTH_COMPONENT32F
    0x88f0: 4, // DEPTH24_STENCIL8
    /* 64 位 */
    0x881a: 8, // RGBA16F
    0x881b: 8, // RGB16F —— 按 RGBA16F 存
    0x8d76: 8, // RGBA16UI
    0x8d88: 8, // RGBA16I
    0x8230: 8, // RG32F
    0x823c: 8, // RG32UI
    0x823b: 8, // RG32I
    0x8cad: 8, // DEPTH32F_STENCIL8
    /* 128 位 */
    0x8814: 16, // RGBA32F
    0x8815: 16, // RGB32F —— 按 RGBA32F 存
    0x8d70: 16, // RGBA32UI
    0x8d82: 16, // RGBA32I
};

function componentsOf(format: number): number {
    switch (format) {
        case GL.ALPHA:
        case GL.LUMINANCE:
        case GL.RED:
        case GL.RED_INTEGER:
        case GL.DEPTH_COMPONENT:
            return 1;
        case GL.LUMINANCE_ALPHA:
        case GL.RG:
        case GL.RG_INTEGER:
            return 2;
        case GL.RGB:
        case GL.RGB_INTEGER:
            return 3;
        default:
            return 4;
    }
}

/** WebGL1 风格的 (format, type) 组合 → 字节/像素。 */
function unsizedBytesPerPixel(format: number, type: number): number {
    const comps = componentsOf(format);
    switch (type) {
        case GL.UNSIGNED_SHORT_4_4_4_4:
        case GL.UNSIGNED_SHORT_5_5_5_1:
        case GL.UNSIGNED_SHORT_5_6_5:
            return 2;
        case GL.UNSIGNED_INT_24_8:
        case GL.UNSIGNED_INT_2_10_10_10_REV:
        case GL.UNSIGNED_INT_10F_11F_11F_REV:
        case GL.UNSIGNED_INT_5_9_9_9_REV:
            return 4;
        case GL.FLOAT_32_UNSIGNED_INT_24_8_REV:
            return 8;
        case GL.HALF_FLOAT:
        case GL.HALF_FLOAT_OES:
        case GL.UNSIGNED_SHORT:
        case GL.SHORT:
            return (comps === 3 ? 4 : comps) * 2;
        case GL.FLOAT:
        case GL.UNSIGNED_INT:
        case GL.INT:
            return (comps === 3 ? 4 : comps) * 4;
        case GL.UNSIGNED_BYTE:
        case GL.BYTE:
        default:
            return comps === 3 ? 4 : comps;
    }
}

/**
 * 求一次纹理层分配的字节/像素。
 * internalformat 命中 sized 表就用表；否则按 (format, type) 推。
 */
export function texBytesPerPixel(internalformat: number, format: number, type: number): number {
    const sized = SIZED_FORMAT_BYTES[internalformat];
    if (sized !== undefined) return sized;
    return unsizedBytesPerPixel(format || internalformat, type);
}

/** renderbuffer 的字节/像素（只吃 internalformat）。 */
export function renderbufferBytesPerPixel(internalformat: number): number {
    const sized = SIZED_FORMAT_BYTES[internalformat];
    if (sized !== undefined) return sized;
    // WebGL1 的 DEPTH_COMPONENT16 / STENCIL_INDEX8 / DEPTH_STENCIL 已在表里，
    // 剩下的按 4 字节兜底（RGBA8 类）。
    return 4;
}

/** texStorage2D/3D 一次分配完整 mip 链的总字节。 */
export function mipChainBytes(
    bytesPerPixel: number,
    levels: number,
    width: number,
    height: number,
    depth = 1,
): number {
    let total = 0;
    for (let i = 0; i < levels; i++) {
        const w = Math.max(1, width >> i);
        const h = Math.max(1, height >> i);
        const d = Math.max(1, depth >> i);
        total += bytesPerPixel * w * h * d;
    }
    return total;
}

/* ---------------- WebGPU ---------------- */

const WGPU_FORMAT_BYTES: Record<string, number> = {
    r8unorm: 1, r8snorm: 1, r8uint: 1, r8sint: 1, stencil8: 1,
    r16uint: 2, r16sint: 2, r16float: 2, r16unorm: 2, r16snorm: 2,
    rg8unorm: 2, rg8snorm: 2, rg8uint: 2, rg8sint: 2,
    'depth16unorm': 2,
    r32uint: 4, r32sint: 4, r32float: 4,
    rg16uint: 4, rg16sint: 4, rg16float: 4, rg16unorm: 4, rg16snorm: 4,
    rgba8unorm: 4, 'rgba8unorm-srgb': 4, rgba8snorm: 4, rgba8uint: 4, rgba8sint: 4,
    bgra8unorm: 4, 'bgra8unorm-srgb': 4,
    rgb9e5ufloat: 4, rgb10a2uint: 4, rgb10a2unorm: 4, rg11b10ufloat: 4,
    'depth24plus': 4, 'depth32float': 4, 'depth24plus-stencil8': 4,
    rg32uint: 8, rg32sint: 8, rg32float: 8,
    rgba16uint: 8, rgba16sint: 8, rgba16float: 8, rgba16unorm: 8, rgba16snorm: 8,
    'depth32float-stencil8': 8,
    rgba32uint: 16, rgba32sint: 16, rgba32float: 16,
};

export function wgpuFormatBytes(format: string): number {
    return WGPU_FORMAT_BYTES[format] ?? 4;
}

export function wgpuTextureBytes(desc: {
    size: unknown;
    format?: string;
    mipLevelCount?: number;
    sampleCount?: number;
}): number {
    let w = 1;
    let h = 1;
    let d = 1;
    const size = desc.size as
        | number[]
        | { width?: number; height?: number; depthOrArrayLayers?: number }
        | undefined;
    if (Array.isArray(size)) {
        w = size[0] ?? 1;
        h = size[1] ?? 1;
        d = size[2] ?? 1;
    } else if (size && typeof size === 'object') {
        w = size.width ?? 1;
        h = size.height ?? 1;
        d = size.depthOrArrayLayers ?? 1;
    }
    const bpp = wgpuFormatBytes(desc.format ?? 'rgba8unorm');
    const levels = Math.max(1, desc.mipLevelCount ?? 1);
    const samples = Math.max(1, desc.sampleCount ?? 1);
    // 数组层 / 3D 深度不参与 mip 缩减的差异忽略：按层各自走 mip 链计。
    return mipChainBytes(bpp, levels, w, h, 1) * d * samples;
}
