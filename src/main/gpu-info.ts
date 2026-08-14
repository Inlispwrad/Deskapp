/**
 * GPU 能力探查。
 *
 * 最重要的一件事：**检测是否静默退化到软件渲染**。
 * Chromium 在驱动异常 / 黑名单命中 / 远程桌面等场景会悄悄换成 SwiftShader，
 * 表现是"画面完全正确但只有几帧"。不主动检测就会把几小时浪费在找 webapp 的性能 bug 上。
 */

import { app } from 'electron';
import type { GpuStatus } from '../shared/types';

interface GpuInfoShape {
    auxAttributes?: {
        glRenderer?: string;
        glVendor?: string;
        glVersion?: string;
        glImplementationParts?: string;
    };
}

const SOFTWARE_MARKERS = ['swiftshader', 'llvmpipe', 'software', 'softwarerasterizer'];

function looksSoftware(text: string): boolean {
    const t = text.toLowerCase();
    return SOFTWARE_MARKERS.some((m) => t.includes(m));
}

/** getGPUInfo 在 GPU 进程未就绪时可能久等，这里加超时兜底。 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise((res) => {
        const timer = setTimeout(() => res(fallback), ms);
        p.then(
            (v) => {
                clearTimeout(timer);
                res(v);
            },
            () => {
                clearTimeout(timer);
                res(fallback);
            },
        );
    });
}

export async function collectGpuStatus(): Promise<GpuStatus> {
    const info = (await withTimeout(
        app.getGPUInfo('complete') as Promise<GpuInfoShape>,
        4000,
        {},
    )) as GpuInfoShape;

    let featureStatus: Record<string, string> = {};
    try {
        featureStatus = app.getGPUFeatureStatus() as unknown as Record<string, string>;
    } catch {
        /* 极早期调用可能拿不到 */
    }

    const aux = info.auxAttributes ?? {};
    const glRenderer = aux.glRenderer ?? '';
    const glVendor = aux.glVendor ?? '';
    const glVersion = aux.glVersion ?? '';
    const angleBackend = aux.glImplementationParts ?? '';

    const warnings: string[] = [];
    const softwareRendering =
        looksSoftware(glRenderer) ||
        looksSoftware(glVendor) ||
        looksSoftware(String(featureStatus.webgl ?? '')) ||
        looksSoftware(String(featureStatus.gpu_compositing ?? ''));

    if (softwareRendering) {
        warnings.push(
            '正在使用软件渲染（SwiftShader/llvmpipe）——所有性能数据不具参考价值。' +
                '常见原因：GPU 驱动被 Chromium 黑名单命中、远程桌面会话、虚拟机无 GPU 直通。',
        );
    }
    const webglStatus = String(featureStatus.webgl ?? 'unknown');
    if (webglStatus !== 'enabled' && webglStatus !== 'enabled_on' && !softwareRendering) {
        warnings.push(`WebGL 特性状态为 "${webglStatus}"，不是 enabled`);
    }
    const compositing = String(featureStatus.gpu_compositing ?? 'unknown');
    if (compositing !== 'enabled' && !softwareRendering) {
        warnings.push(`GPU 合成状态为 "${compositing}"，画面提交会走 CPU 路径`);
    }
    if (!glRenderer) {
        warnings.push('拿不到 GL_RENDERER —— GPU 进程可能尚未就绪或已崩溃');
    }

    return {
        glRenderer,
        glVendor,
        glVersion,
        angleBackend,
        featureStatus,
        softwareRendering,
        warnings,
    };
}
