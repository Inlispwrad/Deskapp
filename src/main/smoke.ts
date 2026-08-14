/**
 * 无人值守压测模式。
 *
 * 用途有两层：
 *   ① 我（以及任何人）验证宿主本身能不能正确装载并跑起来一个 webapp；
 *   ② webapp 侧的性能回归门禁 —— 用阈值断言把「这次改动掉帧了 / 显存涨了」变成 CI 的红灯。
 *
 * 注意：它必须显示真实窗口。隐藏窗口不参与合成，帧数据是假的。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { HIST_BUCKETS, HIST_BUCKET_MS, type ProcMetric, type SmokeReport } from '../shared/types';
import type { CliOptions } from './cli';
import type { Host } from './host';

const MB = 1024 * 1024;

function percentileFromHist(hist: number[], p: number): number {
    let total = 0;
    for (const v of hist) total += v;
    if (total === 0) return 0;
    const target = Math.max(1, Math.ceil((total * p) / 100));
    let acc = 0;
    for (let i = 0; i < hist.length; i++) {
        acc += hist[i];
        if (acc >= target) {
            // 溢出桶只能给下界
            if (i === HIST_BUCKETS - 1) return (HIST_BUCKETS - 1) * HIST_BUCKET_MS;
            return (i + 0.5) * HIST_BUCKET_MS;
        }
    }
    return 0;
}

export async function runSmoke(host: Host, cli: CliOptions): Promise<number> {
    const outDir = cli.outDir
        ? isAbsolute(cli.outDir)
            ? cli.outDir
            : resolve(process.cwd(), cli.outDir)
        : resolve(process.cwd(), '.deskapp-out');
    mkdirSync(outDir, { recursive: true });

    const hist = new Array<number>(HIST_BUCKETS).fill(0);
    let totalFrames = 0;
    let longFrames = 0;
    let intervalSum = 0;
    let maxMs = 0;
    let vramPeak = 0;
    let vramFinal = 0;
    let drawCallsMax = 0;
    let rendererPeakRss = 0;
    let gpuPeakRss = 0;
    /** 预热期内不累计**稳态**帧统计，但预热本身的数据单独记进 startup */
    let counting = false;
    let startupMaxMs = 0;
    let startupLongFrames = 0;
    let firstFrameAt = 0;
    let firstPaintAt = 0;
    let custom: Record<string, number> = {};
    let procs: ProcMetric[] = [];
    const glErrors: string[] = [];
    const marks: Array<{ name: string; t: number }> = [];
    const t0 = Date.now();

    host.onSample = (s) => {
        // 显存与 draw call 是累积量，预热期也要算 —— 加载期的分配尖峰恰恰最该被抓到
        vramFinal = s.vram.total;
        if (s.vram.peak > vramPeak) vramPeak = s.vram.peak;
        if (s.drawCallsMax > drawCallsMax) drawCallsMax = s.drawCallsMax;
        if (Object.keys(s.custom).length > 0) custom = s.custom;
        if (firstFrameAt === 0 && s.firstFrameAt > 0) firstFrameAt = s.firstFrameAt;
        if (firstPaintAt === 0 && s.firstPaintAt > 0) firstPaintAt = s.firstPaintAt;
        for (const e of s.glErrors) if (!glErrors.includes(e)) glErrors.push(e);

        if (!counting) {
            if (s.frame.maxMs > startupMaxMs) startupMaxMs = s.frame.maxMs;
            startupLongFrames += s.frame.longFrames;
            return;
        }
        for (let i = 0; i < HIST_BUCKETS; i++) hist[i] += s.frame.hist[i] ?? 0;
        totalFrames += s.frame.frames;
        longFrames += s.frame.longFrames;
        intervalSum += s.frame.avgMs * s.frame.frames;
        if (s.frame.maxMs > maxMs) maxMs = s.frame.maxMs;
    };
    host.onSystemSample = (s) => {
        procs = s.procs;
        if (s.appRendererMB > rendererPeakRss) rendererPeakRss = s.appRendererMB;
        if (s.gpuProcessMB > gpuPeakRss) gpuPeakRss = s.gpuProcessMB;
    };
    host.onPageMark = (name, t) => marks.push({ name, t: t - t0 });

    // 不给目标时 smoke 退化成「宿主自检」：只验证 Deskapp 自己能起来、启动器能挂上、
    // shell UI 没有报错。这条路径不涉及任何 webapp，所以帧与显存断言全部不适用。
    //
    // 判据用**实际装载的目标**而不是命令行参数：导出的独立应用目标来自内嵌清单，
    // 命令行是空的，只看 cli.target 会把它误判成宿主自检。
    const hasTarget = host.getState().target !== null;

    console.log(`[smoke] 目标 = ${host.getState().target?.value ?? '(无 —— 宿主自检模式，装载启动器)'}`);
    console.log(
        `[smoke] 档位 = ${cli.profile}，预热 ${cli.warmupSec}s + 统计 ${cli.durationSec}s`,
    );

    if (cli.warmupSec > 0) await sleep(cli.warmupSec * 1000);
    counting = true;

    let elapsed = 0;
    while (elapsed < cli.durationSec) {
        await sleep(1000);
        elapsed++;
        if (elapsed % 5 === 0 || elapsed === cli.durationSec) {
            const s = host.getLastSample();
            console.log(
                `[smoke] ${elapsed}/${cli.durationSec}s  fps=${(s?.frame.fps ?? 0).toFixed(1)}` +
                    `  vram=${((s?.vram.total ?? 0) / MB).toFixed(1)}MB` +
                    `  rss=${rendererPeakRss.toFixed(0)}MB`,
            );
        }
    }

    // GPU 进程崩掉之后 capturePage() 不会返回 —— 必须限时，否则整个 smoke 永不退出，
    // 报告也就永远写不出来。恰恰是最该拿到报告的那种失败被卡死了。
    const png = await withTimeout(host.captureScreenshot(), 5000, null);
    let screenshot: string | null = null;
    if (png) {
        screenshot = join(outDir, 'screen.png');
        writeFileSync(screenshot, png);
    } else {
        console.log('[smoke] 截图失败或超时（GPU 进程可能已崩溃）');
    }
    // 自绘标题栏是独立视图，app 的截图里没有它，单独存一张
    const titlebarPng = await withTimeout(host.captureTitlebar(), 5000, null);
    if (titlebarPng) writeFileSync(join(outDir, 'titlebar.png'), titlebarPng);
    // 配 --dev 一起用时把 Inspector 也存一张，CI 可以直接归档
    const inspectorPng = await withTimeout(host.captureInspector(), 5000, null);
    if (inspectorPng) writeFileSync(join(outDir, 'inspector.png'), inspectorPng);

    const gpu = host.getState().gpu;
    const failures: string[] = [];
    const avgMs = totalFrames > 0 ? intervalSum / totalFrames : 0;
    const fps = avgMs > 0 ? 1000 / avgMs : 0;
    const p50 = percentileFromHist(hist, 50);
    const p95 = percentileFromHist(hist, 95);
    const p99 = percentileFromHist(hist, 99);
    const vramPeakMB = vramPeak / MB;

    if (!screenshot) {
        failures.push('截不到画面 —— 窗口没有内容或 GPU 进程已崩溃');
    }
    // 自检模式下报错来自 Deskapp 自己的 shell UI，那是无条件的失败；
    // 装载第三方 webapp 时 console.error 未必致命（很多游戏会打无害的错误日志），
    // 所以只在显式要求时才判失败 —— 但无论如何都会打进报告。
    if (host.consoleErrors.length > 0 && (!hasTarget || cli.assertNoConsoleErrors)) {
        failures.push(`产生了 ${host.consoleErrors.length} 条 console.error`);
    }
    // 判的是"页面到底有没有画出来"，用 Paint Timing 而不是 rAF：
    //   · 统计窗口内 0 帧 → 正常（事件驱动的应用静止时不请求 rAF）
    //   · 一次 rAF 都没有 → 也可能正常（完全静态的页面从不调 rAF）
    //   · 连首次绘制都没有 → 才是真故障（白屏 / 探针没装上）
    if (hasTarget && firstPaintAt === 0 && firstFrameAt === 0) {
        failures.push('页面从未发生首次绘制 —— 白屏，或探针未安装');
    }
    if (gpu?.softwareRendering && cli.profile !== 'compat') {
        failures.push('落到了软件渲染（SwiftShader/llvmpipe），性能结论不成立');
    }
    if (host.getState().crashCount > 0) {
        failures.push(`渲染进程崩溃 ${host.getState().crashCount} 次`);
    }
    const gpuCrashes = host.getAlerts().filter((a) => a.code === 'gpu-crash').length;
    if (gpuCrashes > 0) {
        failures.push(
            `GPU 进程崩溃 ${gpuCrashes} 次 —— 当前档位/开关组合在这台机器上不可用`,
        );
    }
    if (cli.assertFps !== null && fps < cli.assertFps) {
        failures.push(`平均帧率 ${fps.toFixed(1)} < 断言值 ${cli.assertFps}`);
    }
    if (cli.assertP95Ms !== null && p95 > cli.assertP95Ms) {
        failures.push(`帧间隔 p95 ${p95.toFixed(2)}ms > 断言值 ${cli.assertP95Ms}ms`);
    }
    if (cli.assertVramMB !== null && vramPeakMB > cli.assertVramMB) {
        failures.push(`显存峰值 ${vramPeakMB.toFixed(1)}MB > 断言值 ${cli.assertVramMB}MB`);
    }
    // 约定：页面自报的 *Ok 指标为 0 视为自检失败（压测台用它汇报记账校验结果）
    for (const [k, v] of Object.entries(custom)) {
        if (/Ok$/.test(k) && v === 0) failures.push(`页面自检未通过：${k} = 0`);
    }

    const report: SmokeReport = {
        ok: failures.length === 0,
        target: host.getState().target?.value ?? '',
        profile: cli.profile,
        durationSec: cli.durationSec,
        warmupSec: cli.warmupSec,
        startup: {
            toFirstPaintMs:
                firstPaintAt > 0 && host.getLoadStartedAt() > 0
                    ? Math.round(firstPaintAt - host.getLoadStartedAt())
                    : -1,
            toFirstFrameMs:
                firstFrameAt > 0 && host.getLoadStartedAt() > 0
                    ? Math.round(firstFrameAt - host.getLoadStartedAt())
                    : -1,
            maxFrameMs: startupMaxMs,
            longFrames: startupLongFrames,
        },
        gpu,
        frame: {
            fps,
            avgMs,
            p50Ms: p50,
            p95Ms: p95,
            p99Ms: p99,
            maxMs,
            longFrames,
            totalFrames,
        },
        vramPeakMB,
        vramFinalMB: vramFinal / MB,
        rendererPeakRssMB: rendererPeakRss,
        gpuProcessPeakRssMB: gpuPeakRss,
        drawCallsMax,
        custom,
        procs,
        glErrors,
        consoleErrors: host.consoleErrors.slice(0, 50),
        alerts: host.getAlerts(),
        crashCount: host.getState().crashCount,
        failures,
        screenshot,
    };

    const reportPath = join(outDir, 'report.json');
    writeFileSync(reportPath, JSON.stringify({ ...report, marks }, null, 2), 'utf8');

    printSummary(report, marks, reportPath, hasTarget);
    return report.ok ? 0 : 1;
}

function printSummary(
    r: SmokeReport,
    marks: Array<{ name: string; t: number }>,
    reportPath: string,
    hasTarget: boolean,
): void {
    const line = '─'.repeat(58);
    console.log(`\n${line}`);
    console.log(
        `  Deskapp ${hasTarget ? 'smoke' : '宿主自检'} ${r.ok ? '✅ PASS' : '❌ FAIL'}`,
    );
    console.log(line);
    console.log(`  目标            ${r.target || '(无 —— 只验证宿主与启动器)'}`);
    console.log(`  档位            ${r.profile}`);
    console.log(`  GPU             ${r.gpu?.glRenderer || '(未知)'}`);
    if (r.gpu?.softwareRendering) console.log('                  ⚠️ 软件渲染');
    console.log(line);

    // 自检模式没有 webapp，帧与显存数据全为 0，打出来只是噪音
    if (hasTarget) {
        console.log(
            `  启动到首绘      ${r.startup.toFirstPaintMs >= 0 ? `${r.startup.toFirstPaintMs}ms` : '未绘制'}`,
        );
        console.log(
            `  启动到首帧      ${r.startup.toFirstFrameMs >= 0 ? `${r.startup.toFirstFrameMs}ms` : '页面不使用 rAF'}`,
        );
        console.log(
            `  启动期最长帧    ${r.startup.maxFrameMs.toFixed(1)}ms（长帧 ${r.startup.longFrames}，预热 ${r.warmupSec}s 内）`,
        );
        console.log(line);
        if (r.frame.totalFrames === 0) {
            console.log('  稳态帧率        统计窗口内 0 帧 —— 页面已出过帧但当前静止（事件驱动，非持续渲染）');
            console.log('                  这类应用看「主线程 MS」与启动指标，帧率对它没有意义');
        } else {
            console.log(
                `  稳态帧率        ${r.frame.fps.toFixed(1)} fps（${r.frame.totalFrames} 帧，均值）`,
            );
            console.log(
                `  帧间隔          avg ${r.frame.avgMs.toFixed(2)}ms  p50 ${r.frame.p50Ms.toFixed(2)}` +
                    `  p95 ${r.frame.p95Ms.toFixed(2)}  p99 ${r.frame.p99Ms.toFixed(2)}  max ${r.frame.maxMs.toFixed(1)}`,
            );
            console.log(`  长帧            ${r.frame.longFrames}`);
        }
        console.log(
            `  显存记账        峰值 ${r.vramPeakMB.toFixed(1)}MB  结束时 ${r.vramFinalMB.toFixed(1)}MB`,
        );
    }
    console.log(
        `  进程 RSS        ${hasTarget ? 'webapp' : '启动器'} 峰值 ${r.rendererPeakRssMB.toFixed(0)}MB` +
            `  GPU 峰值 ${r.gpuProcessPeakRssMB.toFixed(0)}MB`,
    );
    if (hasTarget) console.log(`  单帧最大 draw   ${r.drawCallsMax}`);
    const customKeys = Object.keys(r.custom).sort();
    if (customKeys.length) {
        console.log(line);
        for (const k of customKeys) {
            const v = r.custom[k];
            console.log(`  ${`${k.padEnd(15)} `}${Number.isInteger(v) ? v : v.toFixed(3)}`);
        }
    }
    if (marks.length) {
        console.log(line);
        for (const m of marks) console.log(`  mark            ${m.name} @ ${m.t}ms`);
    }
    if (r.glErrors.length) {
        console.log(line);
        for (const e of r.glErrors.slice(0, 10)) console.log(`  GL              ${e}`);
    }
    if (r.consoleErrors.length) {
        console.log(line);
        for (const e of r.consoleErrors.slice(0, 10)) console.log(`  console.error   ${e}`);
    }
    if (r.failures.length) {
        console.log(line);
        for (const f of r.failures) console.log(`  ❌ ${f}`);
    }
    console.log(line);
    console.log(`  报告            ${reportPath}`);
    if (r.screenshot) console.log(`  截图            ${r.screenshot}`);
    console.log(`${line}\n`);
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(fallback), ms);
        p.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            () => {
                clearTimeout(timer);
                resolve(fallback);
            },
        );
    });
}
