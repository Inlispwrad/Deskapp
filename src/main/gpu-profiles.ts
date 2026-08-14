/**
 * Chromium 命令行开关档位。
 *
 * 关键约束：`--enable-features` / `--disable-features` / `--js-flags` 只能各出现一次，
 * 后写覆盖前写。所以这里先把各档位的诉求汇总成列表，最后一次性 append。
 */

import { app } from 'electron';
import type { AngleBackend, PerfProfile } from '../shared/types';

export interface SwitchPlan {
    /** 传给 app.commandLine.appendSwitch 的键值对 */
    switches: Array<[string, string | undefined]>;
    /** 人类可读的说明，写进日志和 dev 面板 */
    notes: string[];
}

export interface SwitchInput {
    profile: PerfProfile;
    angle: AngleBackend;
    /** 渲染进程 V8 老生代上限（MB）。webapp 侧内存的硬约束点。 */
    maxOldSpaceMB: number;
    /** 是否放开 WebGPU（部分平台需要 flag） */
    webgpu: boolean;
    /** 是否暴露 gc()，供 webapp 主动回收 */
    exposeGc: boolean;
    /** 强行加上在本平台已知会崩的解帧率锁开关（见下方注释） */
    unsafeUncap: boolean;
}

export function planSwitches(input: SwitchInput): SwitchPlan {
    const { profile, angle, maxOldSpaceMB, webgpu, exposeGc, unsafeUncap } = input;
    const switches: Array<[string, string | undefined]> = [];
    const notes: string[] = [];
    const enableFeatures: string[] = [];
    const disableFeatures: string[] = [];
    const jsFlags: string[] = [];

    /* ---------- 所有档位共有：让页面永远跑满，不被浏览器省电策略降频 ---------- */

    switches.push(['disable-background-timer-throttling', undefined]);
    switches.push(['disable-renderer-backgrounding', undefined]);
    switches.push(['disable-backgrounding-occluded-windows', undefined]);
    // 窗口被别的窗口盖住时 Chromium 会判定 occluded 并停止合成 —— 对游戏是灾难
    disableFeatures.push('CalculateNativeWinOcclusion');
    // 后台页 1 分钟后把定时器降到 1/min
    disableFeatures.push('IntensiveWakeUpThrottling');
    notes.push('已关闭后台节流 / 遮挡检测：窗口失焦或被盖住时仍按满帧运行');

    // 游戏通常在没有用户手势时就要播 BGM
    switches.push(['autoplay-policy', 'no-user-gesture-required']);
    // 触控板双指缩放会把画布缩掉 —— 桌面应用不该有这行为
    switches.push(['disable-pinch', undefined]);
    // 同一份内容在不同显示器色域下渲染结果一致
    switches.push(['force-color-profile', 'srgb']);

    if (exposeGc) jsFlags.push('--expose-gc');
    if (maxOldSpaceMB > 0) jsFlags.push(`--max-old-space-size=${maxOldSpaceMB}`);

    /* ---------- 档位差异 ---------- */

    if (profile === 'compat') {
        // 软件光栅化：管线形状不变，只把 GL 实现换成 SwiftShader。
        // 用途是三分排查 —— 画面在 compat 下正确说明是驱动/GPU 问题，不是 webapp 问题。
        switches.push(['use-gl', 'angle']);
        switches.push(['use-angle', 'swiftshader']);
        notes.push('compat 档：强制 SwiftShader 软件渲染，性能数据不具参考价值，仅用于排查 GPU/驱动问题');
    } else {
        switches.push(['ignore-gpu-blocklist', undefined]);
        switches.push(['enable-gpu-rasterization', undefined]);
        switches.push(['enable-zero-copy', undefined]);

        if (angle !== 'default') {
            switches.push(['use-angle', angle]);
            notes.push(`ANGLE 后端锁定为 ${angle}`);
        }

        if (profile === 'max-perf') {
            switches.push(['disable-gpu-vsync', undefined]);
            // 宁可起不来也不要静默退化成软渲染 —— 静默 SwiftShader 是「为什么只有 5 帧」的头号原因
            switches.push(['disable-software-rasterizer', undefined]);
            if (process.platform === 'darwin') {
                switches.push(['force_high_performance_gpu', undefined]);
            }

            // --disable-frame-rate-limit 是真正解掉帧率上限的那个开关（实测能到 600+ fps），
            // 但在 macOS / Metal 上会让 GPU 进程 SIGSEGV（实测 Apple M3 + macOS 26.5，
            // exit_code=11，稳定复现）。崩溃换来的高帧率没有意义，所以 macOS 默认不加。
            const uncapSafe = process.platform !== 'darwin';
            if (uncapSafe || unsafeUncap) {
                switches.push(['disable-frame-rate-limit', undefined]);
                notes.push(
                    'max-perf 档：关闭 vsync 与帧率上限（会撕裂，用于量真实帧成本）；禁止软渲染回退',
                );
                if (!uncapSafe) {
                    notes.push(
                        '⚠️ --unsafe-uncap 已生效：本平台上 --disable-frame-rate-limit 会崩 GPU 进程，随时可能中断',
                    );
                }
            } else {
                notes.push(
                    'max-perf 档：关闭 vsync、禁止软渲染回退。' +
                        'macOS 上**未**加 --disable-frame-rate-limit —— 它会让 GPU 进程 SIGSEGV，' +
                        '因此帧率仍受显示器刷新率限制。要强行解锁用 --unsafe-uncap（会崩）。',
                );
            }
        } else {
            notes.push('balanced 档：保留 vsync，行为最接近玩家实机');
        }
    }

    if (webgpu) {
        switches.push(['enable-unsafe-webgpu', undefined]);
        if (process.platform === 'linux') enableFeatures.push('Vulkan');
        notes.push('已放开 WebGPU');
    }

    /* ---------- 合并只能出现一次的开关 ---------- */

    if (enableFeatures.length) switches.push(['enable-features', enableFeatures.join(',')]);
    if (disableFeatures.length) switches.push(['disable-features', disableFeatures.join(',')]);
    if (jsFlags.length) switches.push(['js-flags', jsFlags.join(' ')]);

    return { switches, notes };
}

/** 必须在 app ready 之前调用。 */
export function applySwitches(plan: SwitchPlan): void {
    for (const [key, value] of plan.switches) {
        if (value === undefined) app.commandLine.appendSwitch(key);
        else app.commandLine.appendSwitch(key, value);
    }
}
