/**
 * Deskapp 主进程入口。
 *
 * 启动顺序有硬性要求，顺序错了开关就不生效：
 *   ① 解析命令行（决定档位）
 *   ② 注册 app:// 为特权 scheme      ← 必须在 ready 之前
 *   ③ 追加 Chromium 命令行开关        ← 必须在 ready 之前
 *   ④ ready 之后再挂协议处理器、建窗口
 */

import { app, ipcMain } from 'electron';
import { CH, type PageCommand, type ShellCommand } from '../shared/channels';
import type { ProbeSample } from '../shared/types';
import { defaultExportDir, exportProject } from './export-app';
import { loadEmbeddedProject, loadProjectAt, resolveEntry } from './project';
import { HELP, parseCli } from './cli';
import { loadConfig } from './config';
import { applySwitches, planSwitches } from './gpu-profiles';
import { Host } from './host';
import { installAppProtocol, registerAppScheme } from './protocol';
import { runSmoke } from './smoke';

const cli = parseCli();

if (cli.help) {
    process.stdout.write(HELP);
    app.exit(0);
}
if (cli.version) {
    process.stdout.write(
        `deskapp ${app.getVersion()}  (electron ${process.versions.electron}, chromium ${process.versions.chrome})\n`,
    );
    app.exit(0);
}
/* ---------- 内嵌清单：导出的独立应用靠它自我识别 ---------- */

const embedded = loadEmbeddedProject(cli.configPath);
if (embedded) {
    const m = embedded.manifest;
    const r = m.runtime ?? {};
    const w = m.window ?? {};
    // 只覆盖命令行没出现过的项 —— 命令行永远优先
    const unset = (flag: string): boolean => !cli.seen.has(flag);

    if (m.name) app.setName(m.name);
    if (r.profile && unset('--profile')) {
        cli.profile = r.profile;
        cli.profileExplicit = true;
    }
    if (r.angle && unset('--angle')) {
        cli.angle = r.angle;
        cli.angleExplicit = true;
    }
    if (r.webgpu !== undefined && unset('--webgpu')) cli.webgpu = r.webgpu;
    if (r.zoom !== undefined && unset('--zoom')) cli.zoomFactor = r.zoom;
    if (r.vramLimitMB !== undefined && unset('--vram-limit')) cli.vramLimitMB = r.vramLimitMB;
    if (r.rssLimitMB !== undefined && unset('--rss-limit')) cli.rssLimitMB = r.rssLimitMB;
    if (r.maxOldSpaceMB !== undefined && unset('--max-old-space')) {
        cli.maxOldSpaceMB = r.maxOldSpaceMB;
    }
    if (r.sampleIntervalMs !== undefined && unset('--sample-interval')) {
        cli.sampleIntervalMs = r.sampleIntervalMs;
    }
    if (r.crossOriginIsolated !== undefined && unset('--coi')) {
        cli.crossOriginIsolated = r.crossOriginIsolated;
    }
    if (w.frameless !== undefined && unset('--frameless')) cli.frameless = w.frameless;
    if (w.nativeTitlebar !== undefined && unset('--native-titlebar')) {
        cli.nativeTitlebar = w.nativeTitlebar;
    }
    // 窗口尺寸 / 全屏由 projectIdentity 走 manifest 那条路生效，这里不重复
}

/* ---------- ready 之前必须做完的事 ---------- */

registerAppScheme();

// 档位来源：命令行显式 > 上次持久化 > 默认。GPU 开关是进程级的，只能在这里定。
const persisted = loadConfig();
const effectiveProfile = cli.profileExplicit
    ? cli.profile
    : (persisted.settings.profile ?? cli.profile);
const effectiveAngle = cli.angleExplicit ? cli.angle : (persisted.settings.angle ?? cli.angle);

const plan = planSwitches({
    profile: effectiveProfile,
    angle: effectiveAngle,
    maxOldSpaceMB: cli.maxOldSpaceMB,
    webgpu: cli.webgpu,
    exposeGc: true,
    unsafeUncap: cli.unsafeUncap,
});
applySwitches(plan);

cli.profile = effectiveProfile;
cli.angle = effectiveAngle;

/* ---------- 启动 ---------- */

let host: Host | null = null;

app.whenReady()
    .then(async () => {
        installAppProtocol();

        // --export 是纯文件操作，不需要开窗口
        if (cli.exportDir) {
            const code = runExport();
            app.exit(code);
            return;
        }

        host = new Host(cli, embedded);
        const h = host;

        for (const note of plan.notes) h.alert('info', 'switches', note);

        ipcMain.on(CH.probeSample, (_e, sample: ProbeSample) => h.handleProbeSample(sample));
        ipcMain.on(CH.pageReady, () => h.handlePageReady());
        ipcMain.handle(CH.pageCommand, (_e, cmd: PageCommand) => h.handlePageCommand(cmd));
        ipcMain.handle(CH.command, (_e, cmd: ShellCommand) => h.handleShellCommand(cmd));
        ipcMain.on(CH.shellReady, (e) => h.handleShellReady(e.sender));

        await h.start();

        if (cli.smoke) {
            // 看门狗：GPU 进程崩溃、页面死循环等情况下 smoke 可能永远走不完。
            // CI 里挂死比失败更糟（占着 runner 直到超时），所以给一个硬上限。
            const budgetMs = (cli.warmupSec + cli.durationSec) * 1000 + 30_000;
            const watchdog = setTimeout(() => {
                process.stderr.write(
                    `[deskapp] smoke 超过 ${Math.round(budgetMs / 1000)}s 未完成，强制退出\n`,
                );
                app.exit(1);
            }, budgetMs);
            watchdog.unref?.();

            const code = await runSmoke(h, cli);
            clearTimeout(watchdog);
            // 必须 await：项目的 shutdown 脚本是异步的，直接 app.exit 会把它腰斩
            await h.shutdown();
            app.exit(code);
        }
    })
    .catch((err) => {
        process.stderr.write(`[deskapp] 启动失败：${String(err)}\n`);
        if (err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
        app.exit(1);
    });

/** `--export`：把项目导出成独立应用，打印结果，返回退出码。 */
function runExport(): number {
    const dir = cli.exportDir as string;
    let project;
    try {
        project = loadProjectAt(dir);
    } catch (err) {
        process.stderr.write(`[deskapp] ${String(err)}\n`);
        return 1;
    }
    if (!resolveEntry(project)) {
        process.stderr.write(
            `[deskapp] ${dir} 里找不到入口（${project.manifest.entry ?? 'index.html'}）\n`,
        );
        return 1;
    }

    const res = exportProject(
        project,
        {
            outDir: cli.outDir ?? defaultExportDir(),
            ...(cli.exportName ? { name: cli.exportName } : {}),
            ...(cli.exportAppId ? { appId: cli.exportAppId } : {}),
            overwrite: true,
        },
        (message) => process.stdout.write(`[export] ${message}\n`),
    );

    for (const c of res.caveats) process.stdout.write(`[export][注意] ${c}\n`);
    if (!res.ok) {
        process.stderr.write(`[export] 失败：${res.error}\n`);
        return 1;
    }
    process.stdout.write(`\n✅ ${res.appName} → ${res.output}\n`);
    return 0;
}

app.on('window-all-closed', () => {
    // 单应用宿主：窗口关了就退出（包含 macOS —— 它不是一个多文档应用）
    app.quit();
});

// 项目的 shutdown 脚本是异步的：必须挡住这次退出、跑完再真退。
// 只挡一次，否则 app.exit 触发的 before-quit 会绕成死循环。
let quitting = false;
app.on('before-quit', (event) => {
    if (quitting || !host) return;
    quitting = true;
    event.preventDefault();
    void host.shutdown().finally(() => app.exit(0));
});

// 从终端跑时 Ctrl+C / kill 不会走 before-quit，托管的后端进程就会留成孤儿占着端口。
// 这里补上信号兜底 —— 只有被 SIGKILL 才拦不住（那种情况谁也拦不住）。
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
        host?.close();
        app.exit(sig === 'SIGINT' ? 130 : 143);
    });
}

// GPU 进程挂掉是这个工具最该大声喊的事情之一
app.on('child-process-gone', (_e, details) => {
    if (details.type === 'GPU') {
        host?.alert(
            'error',
            'gpu-crash',
            `GPU 进程退出：reason=${details.reason} exitCode=${details.exitCode}。` +
                `画面会短暂黑屏后由 Chromium 重建上下文；WebGL 资源全部丢失，页面需要处理 webglcontextlost。`,
        );
    } else if (details.reason !== 'clean-exit') {
        host?.alert(
            'warn',
            'child-gone',
            `子进程退出：type=${details.type} reason=${details.reason}`,
        );
    }
});
