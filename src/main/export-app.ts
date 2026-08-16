/**
 * 把一个项目导出成独立桌面应用。
 *
 * **不依赖 electron-builder** —— 这是关键设计取舍：打包后的 Deskapp 里没有 builder，
 * 也不该在用户机器上现下载 Electron 运行时。所以导出的做法是
 * **拿一个已经存在的 Electron 骨架，往里注入东西**：
 *
 *   骨架来源：已打包运行时 = Deskapp 自己的 .app / 安装目录
 *             从源码运行时 = node_modules/electron/dist
 *   注入内容：① Deskapp 的应用代码（零运行时依赖，只要 build/** + package.json）
 *             ② 项目文件本体（拷进 Resources/project/）
 *             ③ deskapp.json（entry 指向 project/，于是导出应用与本地项目走同一条代码路径）
 *   改身份：  Info.plist（名称/标识/可执行名）、可执行文件改名、icon.icns
 *
 * 这样导出是纯文件操作，离线可用、秒级完成，且导出物与"专属打包"完全同构。
 *
 * 实测状态：macOS 与 Windows 两条路径都跑通过（导出物能自我识别内嵌清单、
 * 启动钩子 / 常驻命令行 / 关闭钩子全部生效）。Linux 用与 Windows 同一套拷贝注入逻辑，
 * 但**未在实机验证过**。各平台的已知局限写在返回结果的 caveats 里，不假装它完整。
 */

import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    lstatSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { app, nativeImage } from 'electron';
import { MANIFEST_NAME, iconPathOf, type LoadedProject, type ProjectManifest } from './project';
import { buildIcns } from './icns';
import { buildIco } from './ico';
import { IconCache } from './icon-cache';

/**
 * 原始 fs（不经过 Electron 的 asar 补丁）。
 * 打包后导出时，`app.asar` 必须按普通文件复制；用被补丁过的 fs 会被当成目录读，抛出 ENOENT。
 */
const originalFs = require('original-fs') as typeof import('node:fs');

export interface ExportOptions {
    /** 输出目录（导出物放进它里面） */
    outDir: string;
    /** 覆盖应用名；不给则用清单的 name，再退回项目目录名 */
    name?: string;
    /** 覆盖 bundle id；不给则由应用名推导 */
    appId?: string;
    /** 目标已存在时是否覆盖 */
    overwrite?: boolean;
}

export interface ExportResult {
    ok: boolean;
    /** 导出物路径（.app / 目录） */
    output?: string;
    appName?: string;
    /** 平台相关的已知局限，原样告诉用户 */
    caveats: string[];
    error?: string;
}

export type ExportLog = (message: string) => void;

/**
 * 当前设备的目录名，与 electron-builder 的 `${os}-${arch}` 宏保持一致。
 * 两边必须同名，否则同一台机器上「构建的」和「导出的」应用会散在两个地方。
 */
export function deviceDirName(): string {
    const os =
        process.platform === 'darwin'
            ? 'mac'
            : process.platform === 'win32'
              ? 'win'
              : process.platform;
    return `${os}-${process.arch}`;
}

/**
 * 不给 `--out` 时的默认输出目录：项目内的 `apps/<设备>/`。
 *
 * 打包后运行时没有源码目录可写（而且往自己的 .app 旁边写东西也不合适），
 * 这种情况退回当前工作目录 —— 由调用方决定要不要显式指定。
 */
export function defaultExportDir(): string {
    if (app.isPackaged) return join(process.cwd(), deviceDirName());
    return join(app.getAppPath(), 'apps', deviceDirName());
}

/** 项目里不该被打进导出物的东西。 */
const EXCLUDE = new Set([
    'node_modules',
    '.git',
    '.DS_Store',
    '.deskapp-out',
    'release',
    'dist-electron',
]);

/* ============================ 骨架定位 ============================ */

interface Skeleton {
    /** macOS：.app 目录；其他平台：安装目录 */
    root: string;
    /** 骨架里现有的可执行文件名 */
    executable: string;
    /** 从哪来的，写进日志 */
    origin: string;
}

function locateSkeleton(): Skeleton | null {
    if (app.isPackaged) {
        if (process.platform === 'darwin') {
            // process.resourcesPath = <App>.app/Contents/Resources
            const root = dirname(dirname(process.resourcesPath));
            if (root.endsWith('.app')) {
                return { root, executable: basename(process.execPath), origin: '当前运行的应用' };
            }
            return null;
        }
        // Win/Linux：可执行文件与 resources/ 同级
        return {
            root: dirname(process.execPath),
            executable: basename(process.execPath),
            origin: '当前运行的应用',
        };
    }

    // 从源码运行：借 node_modules 里的 Electron 预编译包
    const dist = join(app.getAppPath(), 'node_modules', 'electron', 'dist');
    if (!existsSync(dist)) return null;
    if (process.platform === 'darwin') {
        const appDir = readdirSync(dist).find((f) => f.endsWith('.app'));
        if (!appDir) return null;
        return {
            root: join(dist, appDir),
            executable: 'Electron',
            origin: 'node_modules/electron/dist',
        };
    }
    return {
        root: dist,
        executable: process.platform === 'win32' ? 'electron.exe' : 'electron',
        origin: 'node_modules/electron/dist',
    };
}

/* ============================ 应用代码 ============================ */

/**
 * Deskapp 自己的代码。打包后是 Resources/app.asar；从源码跑是 build/** + package.json。
 * 之所以这么简单，是因为 Deskapp 有**零运行时依赖** —— 不用搬 node_modules。
 */
function copyAppCode(resourcesDir: string, log: ExportLog): void {
    if (app.isPackaged) {
        const asar = join(process.resourcesPath, 'app.asar');
        if (originalFs.existsSync(asar)) {
            originalFs.cpSync(asar, join(resourcesDir, 'app.asar'));
            const unpacked = join(process.resourcesPath, 'app.asar.unpacked');
            if (originalFs.existsSync(unpacked)) {
                originalFs.cpSync(unpacked, join(resourcesDir, 'app.asar.unpacked'), {
                    recursive: true,
                });
            }
            log('已注入应用代码（app.asar）');
            return;
        }
        // 没用 asar 打包的情况
        const appDir = join(process.resourcesPath, 'app');
        if (originalFs.existsSync(appDir)) {
            originalFs.cpSync(appDir, join(resourcesDir, 'app'), { recursive: true });
            log('已注入应用代码（Resources/app）');
            return;
        }
        throw new Error('定位不到当前应用的代码（既无 app.asar 也无 Resources/app）');
    }

    const projectRoot = app.getAppPath();
    const dest = join(resourcesDir, 'app');
    mkdirSync(dest, { recursive: true });
    const build = join(projectRoot, 'build');
    if (!existsSync(build)) {
        throw new Error('build/ 不存在 —— 先跑 pnpm build 再导出');
    }
    cpSync(build, join(dest, 'build'), { recursive: true });

    // 只留运行必需的字段，devDependencies 之类不带进导出物
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as Record<
        string,
        unknown
    >;
    writeFileSync(
        join(dest, 'package.json'),
        JSON.stringify(
            { name: pkg.name, version: pkg.version, main: pkg.main, author: pkg.author },
            null,
            2,
        ),
        'utf8',
    );
    log('已注入应用代码（build/ + 精简 package.json）');
}

/* ============================ 项目与清单 ============================ */

function copyProject(project: LoadedProject, resourcesDir: string, log: ExportLog): void {
    const dest = join(resourcesDir, 'project');
    mkdirSync(dest, { recursive: true });
    let skipped = 0;
    for (const name of readdirSync(project.root)) {
        if (EXCLUDE.has(name)) {
            skipped++;
            continue;
        }
        cpSync(join(project.root, name), join(dest, name), { recursive: true });
    }
    log(`已注入项目文件${skipped > 0 ? `（跳过 ${skipped} 项：node_modules/.git 等）` : ''}`);
}

/**
 * 写导出物的 deskapp.json。
 * 与原清单同构，只把 entry / icon 重指到包内的 project/ 下 ——
 * 于是导出应用启动时读到的就是一份普通项目清单，没有任何"打包版专属"分支。
 */
function writeEmbeddedManifest(
    project: LoadedProject,
    resourcesDir: string,
    appName: string,
): void {
    const src = project.manifest;
    const entry = src.entry?.trim() || 'index.html';
    const isUrl = /^https?:\/\//i.test(entry);

    const out: ProjectManifest = {
        version: 1,
        name: appName,
        entry: isUrl ? entry : join('project', entry),
        ...(src.icon ? { icon: join('project', src.icon) } : {}),
        ...(src.window ? { window: src.window } : {}),
        ...(src.runtime ? { runtime: src.runtime } : {}),
        // command / hooks 的 cwd 不用改写：它们相对**内容根**（entry 所在目录）解析，
        // 导出后 entry 指向 project/，内容根自然跟着走
        ...(src.command ? { command: src.command } : {}),
        ...(src.hooks ? { hooks: src.hooks } : {}),
    };

    writeFileSync(join(resourcesDir, MANIFEST_NAME), `${JSON.stringify(out, null, 4)}\n`, 'utf8');
}

/* ============================ 平台身份 ============================ */

/**
 * bundle id 只能用 ASCII。名字里没有可用字符时（例如纯中文名）不能退回一个固定字面量 ——
 * 那会让所有中文名应用撞同一个 id，macOS 的 LaunchServices 会把它们当成同一个应用
 * （图标、默认打开方式、单实例语义全乱）。用名字的哈希兜底，保证互不相同且稳定。
 */
function sanitizeAppId(name: string): string {
    const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (slug) return `com.deskapp.${slug}`;
    const hash = createHash('sha256').update(name).digest('hex').slice(0, 10);
    return `com.deskapp.x${hash}`;
}

/** 应用名 → 可安全用于文件名/可执行名的字符串。 */
function sanitizeFileName(name: string): string {
    const cleaned = name
        .replace(/[<>:"/\|?*\u0000-\u001f]/g, '-')
        .replace(/[. ]+$/g, '')
        .trim();
    return cleaned || 'Deskapp';
}

/** 极小的 plist 值替换：只改我们自己认识的那几个键。 */
function patchPlist(plistPath: string, values: Record<string, string>): void {
    let text = readFileSync(plistPath, 'utf8');
    for (const [key, value] of Object.entries(values)) {
        const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const re = new RegExp(
            `(<key>${key}</key>\\s*<string>)[^<]*(</string>)`,
            'i',
        );
        if (re.test(text)) {
            text = text.replace(re, `$1${escaped}$2`);
        } else {
            // 键不存在就补一个
            text = text.replace(
                /<dict>/,
                `<dict>\n\t<key>${key}</key>\n\t<string>${escaped}</string>`,
            );
        }
    }
    writeFileSync(plistPath, text, 'utf8');
}

function brandMac(
    output: string,
    skeleton: Skeleton,
    executableName: string,
    appId: string,
    iconPath: string | null,
    log: ExportLog,
    displayName: string,
): string[] {
    const caveats: string[] = [];
    const contents = join(output, 'Contents');
    const macos = join(contents, 'MacOS');
    const resourcesDir = join(contents, 'Resources');

    // 可执行文件改名 —— 它决定 Dock 上显示的进程名，必须与 CFBundleExecutable 一致
    const from = join(macos, skeleton.executable);
    const to = join(macos, executableName);
    if (existsSync(from) && from !== to) {
        renameSync(from, to);
        chmodSync(to, 0o755);
    }

    patchPlist(join(contents, 'Info.plist'), {
        CFBundleName: displayName,
        CFBundleDisplayName: displayName,
        CFBundleExecutable: executableName,
        CFBundleIdentifier: appId,
        CFBundleIconFile: 'icon.icns',
    });

    if (iconPath) {
        const img = nativeImage.createFromPath(iconPath);
        if (!img.isEmpty()) {
            writeFileSync(join(resourcesDir, 'icon.icns'), buildIcns(img));
            log('已写入应用图标');
        } else {
            caveats.push(`图标 ${basename(iconPath)} 解不出来（PNG/JPEG 之外的格式需先转换），已保留默认图标`);
        }
    } else {
        caveats.push('项目没声明 icon，导出物用的是 Deskapp 的默认图标');
    }

    // 改过包内文件，adhoc 重签一次让 CDHash 自洽；失败不致命（源骨架本来也是 adhoc）
    const signed = spawnSync('codesign', ['--force', '--sign', '-', output], { encoding: 'utf8' });
    if (signed.status !== 0) {
        caveats.push('adhoc 重签名失败，首次打开可能需要在「系统设置 → 隐私与安全性」里放行');
    }
    return caveats;
}

function brandGeneric(
    output: string,
    skeleton: Skeleton,
    executableName: string,
    displayName: string,
    icon: Electron.NativeImage | null,
    log: ExportLog,
): string[] {
    const caveats: string[] = process.platform === 'win32' ? [] : ['Linux 导出未在实机验证过'];
    const ext = process.platform === 'win32' ? '.exe' : '';
    const from = join(output, skeleton.executable);
    const to = join(output, `${executableName}${ext}`);
    if (existsSync(from) && from !== to) {
        renameSync(from, to);
        if (process.platform !== 'win32') chmodSync(to, 0o755);
        log(`可执行文件已改名为 ${basename(to)}`);
    }
    if (process.platform === 'win32') {
        const rcedit = locateRcedit();
        if (rcedit && existsSync(rcedit)) {
            // rcedit 对非 ASCII 路径和刚拷出来的 exe 都不稳定：统一放到 ASCII 临时目录
            // 处理，成功后再拷回输出目录。失败可能是 Defender/索引器短暂锁住，稍等重试。
            const asciiTemp = tmpdir();
            const tempExe = join(asciiTemp, `.deskapp-rcedit-${process.pid}.exe`);
            rmSync(tempExe, { force: true });
            cpSync(to, tempExe);
            const args = [
                tempExe,
                '--set-version-string',
                'ProductName',
                displayName,
                '--set-version-string',
                'FileDescription',
                displayName,
            ];
            let icoPath: string | null = null;
            if (icon && !icon.isEmpty()) {
                icoPath = join(asciiTemp, `.deskapp-icon-${process.pid}.ico`);
                try {
                    writeFileSync(icoPath, buildIco(icon));
                    args.push('--set-icon', icoPath);
                } catch {
                    icoPath = null;
                }
            }
            let res = spawnSync(rcedit, args, { encoding: 'utf8', windowsHide: true });
            for (let attempt = 0; res.status !== 0 && attempt < 5; attempt++) {
                sleepSync(400);
                res = spawnSync(rcedit, args, { encoding: 'utf8', windowsHide: true });
            }
            if (res.status === 0) {
                cpSync(tempExe, to);
            }
            rmSync(tempExe, { force: true });
            if (icoPath) rmSync(icoPath, { force: true });
            if (res.status !== 0) {
                caveats.push(
                    `rcedit 更新 exe 资源失败（${res.status}）：${res.stderr ?? res.stdout ?? ''}`.slice(0, 300),
                );
            } else {
                log(
                    icon && !icon.isEmpty()
                        ? '已用缓存/清单图标更新 exe 图标与产品名'
                        : '已更新 exe 产品名（无图标可写）',
                );
            }
        } else {
            caveats.push('找不到 rcedit.exe，Windows exe 的图标与产品名未修改');
        }
    } else {
        caveats.push('Linux 的图标需要自行写 .desktop 条目');
    }
    return caveats;
}

function sleepSync(ms: number): void {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {
        /* SharedArrayBuffer 不可用就立即重试 */
    }
}

function locateRcedit(): string | null {
    if (app.isPackaged) return join(process.resourcesPath, 'rcedit.exe');
    return join(app.getAppPath(), 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
}

/* ============================ 主流程 ============================ */

/**
 * 拷贝运行时骨架。只拷运行一个 Electron 应用所需的文件：
 * 跳过安装包 / zip / blockmap / 其他导出物，避免把构建目录里的非运行时垃圾一起带走。
 */
function copySkeleton(skeleton: Skeleton, output: string): void {
    mkdirSync(output, { recursive: true });
    for (const name of readdirSync(skeleton.root)) {
        const from = join(skeleton.root, name);
        const to = join(output, name);
        if (name === 'locales' || name === 'resources') {
            cpSync(from, to, { recursive: true, verbatimSymlinks: true });
            continue;
        }
        if (name === skeleton.executable) {
            cpSync(from, to);
            continue;
        }
        let st;
        try {
            st = lstatSync(from);
        } catch {
            continue;
        }
        if (st.isDirectory()) continue; // 例如 apps/<device>/ 里的其他导出物
        const lower = name.toLowerCase();
        if (lower.endsWith('.zip') || lower.endsWith('.blockmap')) continue;
        if (lower === 'latest.yml' || lower === 'builder-debug.yml') continue;
        if (lower.endsWith('.exe')) continue; // 安装器/卸载器
        cpSync(from, to);
    }
}


export function exportProject(
    project: LoadedProject,
    options: ExportOptions,
    log: ExportLog = () => undefined,
): ExportResult {
    const caveats: string[] = [];
    try {
        const skeleton = locateSkeleton();
        if (!skeleton) {
            return {
                ok: false,
                caveats,
                error:
                    '找不到 Electron 骨架。从源码运行需先 pnpm install（要有 node_modules/electron/dist）',
            };
        }

        const appName =
            options.name?.trim() || project.manifest.name?.trim() || basename(project.root);
        const appId = options.appId?.trim() || sanitizeAppId(appName);
        const fsName = sanitizeFileName(appName);
        const outDir = resolve(options.outDir);
        mkdirSync(outDir, { recursive: true });

        const output =
            process.platform === 'darwin' ? join(outDir, `${fsName}.app`) : join(outDir, fsName);

        if (existsSync(output)) {
            if (!options.overwrite) {
                return { ok: false, caveats, error: `目标已存在：${output}（要覆盖请开 overwrite）` };
            }
            rmSync(output, { recursive: true, force: true });
        }

        log(`骨架来源：${skeleton.origin}`);
        log(`拷贝运行时骨架 → ${output}`);
        copySkeleton(skeleton, output);

        // 骨架若是"当前运行的应用"，它 Resources 里可能带着上一次注入的东西，清掉
        const resourcesDir =
            process.platform === 'darwin'
                ? join(output, 'Contents', 'Resources')
                : join(output, 'resources');
        mkdirSync(resourcesDir, { recursive: true });
        for (const stale of ['app', 'app.asar', 'app.asar.unpacked', 'project', MANIFEST_NAME]) {
            rmSync(join(resourcesDir, stale), { recursive: true, force: true });
        }

        copyAppCode(resourcesDir, log);
        copyProject(project, resourcesDir, log);
        writeEmbeddedManifest(project, resourcesDir, appName);
        log('已写入 deskapp.json（entry 指向包内 project/）');

        const iconPath = iconPathOf(project);
        // 导出应用图标：清单图标优先，其次用 Deskapp 之前缓存的页面/项目图标。
        // 这样临时网址/没有 manifest icon 的项目，导出的 exe 也能拿到自己的图标。
        let exportIcon: Electron.NativeImage | null = iconPath
            ? nativeImage.createFromPath(iconPath)
            : null;
        if (!exportIcon || exportIcon.isEmpty()) {
            try {
                const cache = new IconCache(() => undefined);
                exportIcon = cache.load(`dir:${project.root}`);
            } catch {
                exportIcon = null;
            }
        }
        if (exportIcon?.isEmpty()) exportIcon = null;

        caveats.push(
            ...(process.platform === 'darwin'
                ? brandMac(output, skeleton, fsName, appId, iconPath, log, appName)
                : brandGeneric(output, skeleton, fsName, appName, exportIcon, log)),
        );

        const sizeMB = dirSizeMB(output);
        log(`完成：${output}（约 ${sizeMB} MB）`);
        return { ok: true, output, appName, caveats };
    } catch (err) {
        return { ok: false, caveats, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * 统计磁盘占用。
 *
 * 必须用 lstat 且跳过符号链接：macOS 的 framework 结构里
 * `Versions/Current` 是指向 `Versions/A` 的符号链接，顶层还有一堆指进去的链接。
 * 用 stat（跟随链接）会把同一份 270MB 的二进制重复计三四遍 —— 实测报出 823MB
 * 而真实占用是 277MB。
 */
function dirSizeMB(dir: string): number {
    let total = 0;
    const walk = (p: string): void => {
        let st;
        try {
            st = lstatSync(p);
        } catch {
            return;
        }
        if (st.isSymbolicLink()) return;
        if (st.isDirectory()) {
            for (const f of readdirSync(p)) walk(join(p, f));
        } else {
            total += st.size;
        }
    };
    walk(dir);
    return Math.round(total / (1024 * 1024));
}
