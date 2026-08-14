/** 命令行解析。零依赖，只认自己定义的开关，其余交给 Chromium。 */

import { app } from 'electron';
import type { AngleBackend, PerfProfile } from '../shared/types';

export interface CliOptions {
    /** 目标：目录 / index.html 路径 / URL。未给则进入启动器（空窗 + dev 覆盖层） */
    target: string | null;
    /** 是否默认显示开发者覆盖层 */
    dev: boolean;
    profile: PerfProfile;
    /** --profile 是否由命令行显式给出（决定它是否覆盖持久化设置） */
    profileExplicit: boolean;
    angle: AngleBackend;
    angleExplicit: boolean;
    width: number | null;
    height: number | null;
    fullscreen: boolean;
    frameless: boolean;
    kiosk: boolean;
    /** 用平台原生标题栏，不用 Deskapp 自绘的那条 */
    nativeTitlebar: boolean;
    vramLimitMB: number;
    rssLimitMB: number;
    maxOldSpaceMB: number;
    webgpu: boolean;
    /** 强行加上本平台已知会崩 GPU 进程的解帧率锁开关 */
    unsafeUncap: boolean;
    probe: boolean;
    crossOriginIsolated: boolean;
    webSecurity: boolean;
    sampleIntervalMs: number;
    zoomFactor: number;
    title: string | null;
    /** smoke 模式 */
    smoke: boolean;
    durationSec: number;
    /** 统计前的预热秒数（不计入帧统计） */
    warmupSec: number;
    outDir: string | null;
    assertFps: number | null;
    assertP95Ms: number | null;
    assertVramMB: number | null;
    assertNoConsoleErrors: boolean;
    /** --config 指定的清单文件路径 */
    configPath: string | null;
    /** 跳过项目命令的执行确认（无人值守/CI 用，等于声明"我已审阅过这份清单"） */
    trustProject: boolean;
    /** --export：把项目导出成独立桌面应用后退出。值是项目目录 */
    exportDir: string | null;
    /** 导出物的应用名（不给则取清单 name / 目录名） */
    exportName: string | null;
    /** 导出物的 bundle id */
    exportAppId: string | null;
    help: boolean;
    version: boolean;
    /**
     * 命令行上实际出现过的开关名。
     * 内嵌配置只能覆盖**没在命令行出现过**的项 —— 否则无法区分
     * "用户显式关掉了某个布尔开关" 和 "该开关就是默认 false"。
     */
    seen: Set<string>;
}

const PROFILES: PerfProfile[] = ['balanced', 'max-perf', 'compat'];
const ANGLES: AngleBackend[] = ['default', 'gl', 'd3d11', 'd3d9', 'metal', 'vulkan', 'swiftshader'];

export const HELP = `Deskapp — 高性能 webapp 桌面宿主

用法:
  deskapp [目标] [选项]

目标:
  <项目目录>       含 index.html 的目录，经 app:// 安全源加载；有 deskapp.json 则用它增强
  <index.html>     指向入口文件，自动取其所在目录为项目根
  <URL>            http(s):// 开发服务器或线上地址
  省略             进入项目选择器（或读内嵌清单，见 --config）

项目清单 deskapp.json（全部可省略，最小协议只要一个 index.html）:
  name             应用名 —— 窗口标题 / Dock 名 / 导出应用名
  entry            入口，默认 index.html；也可写 http(s) URL
  icon             图标路径
  window           width/height/minWidth/minHeight/background/resizable/aspectRatio/
                   fullscreen/frameless/nativeTitlebar
  runtime          profile/angle/webgpu/zoom/vramLimitMB/rssLimitMB/maxOldSpaceMB/
                   sampleIntervalMs/crossOriginIsolated/adoptPageIcon
  command          常驻命令行：run（交给登录 shell）或 command+args；
                   cwd/env/readyUrl/readyTimeoutMs
  hooks            startup / shutdown 一次性脚本，timeoutMs
  ⚠️ command 与 hooks 首次执行前会弹确认框 —— 清单是磁盘数据，不默认执行

导出:
  --export <项目目录>      把项目导出成独立桌面应用后退出
  --out <目录>             输出目录。不给则落到项目内的 apps/<设备>/
                           （设备目录名同 electron-builder 的 \${os}-\${arch}）
  --export-name <名称>     覆盖应用名
  --export-app-id <id>     覆盖 bundle identifier

窗口:
  --dev                    启动即显示开发者覆盖层（工具栏 + 指标面板）
  --size <宽x高>            初始窗口内容尺寸，如 1280x720
  --fullscreen             全屏启动
  --frameless              无边框窗口
  --kiosk                  kiosk 模式（独占，无法退出全屏）
  --native-titlebar        用平台原生标题栏，不用自绘那条（没有图标与实时指标，
                           也没有毛玻璃；Linux 恒为此模式）
  --title <文本>            覆盖窗口标题（默认取 manifest.name / document.title）
  --zoom <倍数>             页面缩放，默认 1

性能:
  --profile <档位>          balanced（默认） | max-perf | compat
      balanced   保留 vsync，最接近玩家实机
      max-perf   关 vsync、禁止软渲染回退，用于量真实帧成本
                 （macOS 上不解帧率上限——那个开关会崩 GPU 进程，见 --unsafe-uncap）
      compat     强制 SwiftShader 软件渲染，用于三分排查 GPU/驱动问题
  --angle <后端>            default | gl | d3d11 | d3d9 | metal | vulkan | swiftshader
  --webgpu                 放开 WebGPU
  --unsafe-uncap           强行加 --disable-frame-rate-limit。macOS/Metal 上会让 GPU 进程
                           SIGSEGV（实测稳定复现），只在明知代价时用
  --max-old-space <MB>     渲染进程 V8 老生代上限，默认 2048
  --sample-interval <ms>   指标采样周期，默认 500

告警线:
  --vram-limit <MB>        显存记账告警线，默认 400
  --rss-limit <MB>         渲染进程 RSS 告警线，默认 1500

加载:
  --no-probe               关闭页面内插桩（同时开启 contextIsolation）
  --coi                    发送 COOP/COEP 头，启用跨源隔离（SharedArrayBuffer）
  --no-web-security        关闭同源策略（仅本地素材调试）

无人值守压测:
  --smoke                  加载目标、跑一段时间、导出报告后退出
                           不给目标时退化成「宿主自检」：只验证 Deskapp 自己能起来
  --duration <秒>           计入统计的压测时长，默认 15
  --warmup <秒>             预热时长，默认 3。预热期不计入稳态统计，但单独作为启动指标上报
  --out <目录>              报告与截图输出目录，默认 ./.deskapp-out
  --assert-fps <n>         平均帧率低于 n 则退出码 1
  --assert-p95 <ms>        帧间隔 p95 高于 ms 则退出码 1
  --assert-vram <MB>       显存峰值高于 MB 则退出码 1
  --assert-no-console-errors  页面出现任何 console.error 则退出码 1

其他:
  --config <文件>           显式指定 deskapp.json。导出的独立应用会自动读包内那份；
                           命令行参数优先级高于清单
  --trust-project          跳过项目命令的执行确认框（无人值守 / CI 用）。
                           等于声明"我已审阅过这份清单里的命令"
  -h, --help               显示本帮助
  -v, --version            显示版本
`;

function num(value: string | undefined, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function parseCli(rawArgv: string[] = process.argv): CliOptions {
    // 开发时 argv = [electron, '.', ...]；打包后 argv = [exe, ...]
    const argv = rawArgv.slice(app.isPackaged ? 1 : 2).filter((a) => a !== '.');

    const o: CliOptions = {
        target: null,
        dev: false,
        profile: 'balanced',
        profileExplicit: false,
        angle: 'default',
        angleExplicit: false,
        width: null,
        height: null,
        fullscreen: false,
        frameless: false,
        kiosk: false,
        nativeTitlebar: false,
        vramLimitMB: 400,
        rssLimitMB: 1500,
        maxOldSpaceMB: 2048,
        webgpu: false,
        unsafeUncap: false,
        probe: true,
        crossOriginIsolated: false,
        webSecurity: true,
        sampleIntervalMs: 500,
        zoomFactor: 1,
        title: null,
        smoke: false,
        durationSec: 15,
        warmupSec: 3,
        outDir: null,
        assertFps: null,
        assertP95Ms: null,
        assertVramMB: null,
        assertNoConsoleErrors: false,
        configPath: null,
        trustProject: false,
        exportDir: null,
        exportName: null,
        exportAppId: null,
        help: false,
        version: false,
        seen: new Set<string>(),
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a.startsWith('--')) o.seen.add(a);

        switch (a) {
            case '--config':
                o.configPath = next() ?? null;
                break;
            case '--trust-project':
                o.trustProject = true;
                break;
            case '--export':
                o.exportDir = next() ?? null;
                break;
            case '--export-name':
                o.exportName = next() ?? null;
                break;
            case '--export-app-id':
                o.exportAppId = next() ?? null;
                break;
            case '-h':
            case '--help':
                o.help = true;
                break;
            case '-v':
            case '--version':
                o.version = true;
                break;
            case '--dev':
                o.dev = true;
                break;
            case '--profile': {
                const v = next() as PerfProfile;
                if (PROFILES.includes(v)) {
                    o.profile = v;
                    o.profileExplicit = true;
                }
                break;
            }
            case '--angle': {
                const v = next() as AngleBackend;
                if (ANGLES.includes(v)) {
                    o.angle = v;
                    o.angleExplicit = true;
                }
                break;
            }
            case '--size': {
                const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(next() ?? '');
                if (m) {
                    o.width = Number(m[1]);
                    o.height = Number(m[2]);
                }
                break;
            }
            case '--fullscreen':
                o.fullscreen = true;
                break;
            case '--frameless':
                o.frameless = true;
                break;
            case '--kiosk':
                o.kiosk = true;
                break;
            case '--native-titlebar':
                o.nativeTitlebar = true;
                break;
            case '--title':
                o.title = next() ?? null;
                break;
            case '--zoom':
                o.zoomFactor = num(next(), 1);
                break;
            case '--webgpu':
                o.webgpu = true;
                break;
            case '--unsafe-uncap':
                o.unsafeUncap = true;
                break;
            case '--max-old-space':
                o.maxOldSpaceMB = num(next(), o.maxOldSpaceMB);
                break;
            case '--sample-interval':
                o.sampleIntervalMs = Math.max(50, num(next(), o.sampleIntervalMs));
                break;
            case '--vram-limit':
                o.vramLimitMB = num(next(), o.vramLimitMB);
                break;
            case '--rss-limit':
                o.rssLimitMB = num(next(), o.rssLimitMB);
                break;
            case '--no-probe':
                o.probe = false;
                break;
            case '--coi':
                o.crossOriginIsolated = true;
                break;
            case '--no-web-security':
                o.webSecurity = false;
                break;
            case '--smoke':
                o.smoke = true;
                break;
            case '--duration':
                o.durationSec = Math.max(1, num(next(), o.durationSec));
                break;
            case '--warmup':
                o.warmupSec = Math.max(0, num(next(), o.warmupSec));
                break;
            case '--out':
                o.outDir = next() ?? null;
                break;
            case '--assert-fps':
                o.assertFps = num(next(), 0);
                break;
            case '--assert-p95':
                o.assertP95Ms = num(next(), 0);
                break;
            case '--assert-vram':
                o.assertVramMB = num(next(), 0);
                break;
            case '--assert-no-console-errors':
                o.assertNoConsoleErrors = true;
                break;
            default:
                // 第一个非开关参数当作目标；其余（Chromium 自己的开关）忽略
                if (!a.startsWith('-') && o.target === null) o.target = a;
                break;
        }
    }

    return o;
}
