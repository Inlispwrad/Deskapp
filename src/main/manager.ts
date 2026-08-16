/**
 * HostManager —— 多窗口编排。
 *
 * 产品定位：Deskapp 本体是**启动器**，不是一个"会把自身变成项目"的单窗口壳。
 * 启动器窗口永远只做选择与导出；每选择一个项目（目录 / 网址 / 网址项目），
 * 就新开一个独立的应用窗口。因此可以同时装载多个项目，每个窗口的
 * 采样、告警、Inspector、标题栏指标全部各自独立。
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { app, ipcMain, Menu, type WebContents } from 'electron';
import { CH, type PageCommand, type ShellCommand } from '../shared/channels';
import type { ProbeSample } from '../shared/types';
import type { CliOptions } from './cli';
import {
    createUrlProject,
    loadProjectAt,
    resolveEntry,
    ManifestError,
    type LoadedProject,
} from './project';
import { Host } from './host';

export class HostManager {
    private readonly hosts = new Set<Host>();
    private launcher: Host | null = null;
    private smokeHost: Host | null = null;

    constructor(
        private readonly cli: CliOptions,
        private readonly embedded: LoadedProject | null,
    ) {
        this.registerIpc();
    }

    /**
     * 启动入口。
     * 命令行给了目标 / 内嵌清单 → 直接开一个应用窗口；
     * 什么都没给 → 开启动器窗口。
     * 返回 smoke 模式应该观测的那个 Host。
     */
    async start(): Promise<Host> {
        let host: Host;
        if (this.cli.target !== null) {
            host = await this.openTargetWindow(this.cli.target, { passEmbedded: true });
        } else if (this.embedded) {
            host = await this.openProjectWindow(this.embedded);
        } else {
            host = await this.ensureLauncher();
        }
        this.smokeHost = host;
        this.installMenu();
        return host;
    }

    getSmokeHost(): Host | null {
        return this.smokeHost;
    }

    async shutdownAll(): Promise<void> {
        const all = [...this.hosts];
        for (const h of all) {
            await h.shutdown();
        }
        this.hosts.clear();
        this.launcher = null;
    }

    /** 同步收尾（SIGINT/SIGTERM 兜底）：不跑异步 shutdown 脚本，先保证进程树被收。 */
    closeAll(): void {
        for (const h of [...this.hosts]) h.close();
        this.hosts.clear();
        this.launcher = null;
    }

    alertAll(level: 'info' | 'warn' | 'error', code: string, message: string): void {
        for (const h of this.hosts) h.alert(level, code, message);
    }

    /* ---------------- 窗口创建 ---------------- */

    private async openTargetWindow(
        input: string,
        opts: { passEmbedded?: boolean; relaxedNavigation?: boolean } = {},
    ): Promise<Host> {
        const host = new Host(
            { ...this.cli, target: input },
            opts.passEmbedded ? this.embedded : null,
            { relaxedNavigation: opts.relaxedNavigation === true },
        );
        this.adopt(host);
        await host.start();
        return host;
    }

    private async openProjectWindow(project: LoadedProject): Promise<Host> {
        const host = new Host(this.cli, null, { initialProject: project });
        this.adopt(host);
        await host.start();
        return host;
    }

    /** 启动器点「打开项目」：校验一下再开新窗口，错误留在启动器里报。 */
    async openTargetFromLauncher(input: string): Promise<void> {
        const urlLike = /^https?:\/\//i.test(input);
        if (urlLike) {
            try {
                new URL(input);
            } catch {
                this.launcher?.alert('error', 'target', `不是合法的网址：${input}`);
                return;
            }
        } else {
            const abs = isAbsolute(input) ? input : resolve(process.cwd(), input);
            if (!existsSync(abs)) {
                this.launcher?.alert('error', 'target', `路径不存在：${abs}`);
                return;
            }
            if (statSync(abs).isDirectory()) {
                try {
                    const loaded = loadProjectAt(abs);
                    if (!resolveEntry(loaded)) {
                        this.launcher?.alert(
                            'error',
                            'target',
                            `项目里找不到入口：${loaded.manifest.entry ?? 'index.html'}（根目录 ${loaded.root}）`,
                        );
                        return;
                    }
                } catch (err) {
                    this.launcher?.alert(
                        'error',
                        'target',
                        err instanceof ManifestError ? err.message : String(err),
                    );
                    return;
                }
            }
        }
        await this.openTargetWindow(input);
    }

    /** 启动器的网址模式：持久化与否，行为要能看得见。 */
    async openUrlProjectFromLauncher(input: {
        url: string;
        name?: string;
        startup?: string;
        shutdown?: string;
    }): Promise<void> {
        const persist = Boolean(
            input.name?.trim() || input.startup?.trim() || input.shutdown?.trim(),
        );
        if (!persist) {
            await this.openTargetWindow(input.url.trim());
            return;
        }
        try {
            const project = createUrlProject(join(app.getPath('userData'), 'projects'), input);
            this.launcher?.alert('info', 'project', `已创建网址项目：${project.root}`);
            await this.openProjectWindow(project);
        } catch (err) {
            this.launcher?.alert(
                'error',
                'project',
                err instanceof ManifestError ? err.message : String(err),
            );
        }
    }

    /** 外链选择「在 Deskapp 中打开」：额外开一个宽松导航的应用窗口。 */
    async openUrlInDeskapp(url: string): Promise<void> {
        await this.openTargetWindow(url, { relaxedNavigation: true });
    }

    /** 关闭当前应用窗口，回到/创建启动器窗口。 */
    async returnToLauncher(host: Host): Promise<void> {
        await host.shutdown();
        const launcher = await this.ensureLauncher();
        launcher.win?.show();
        launcher.win?.focus();
    }

    /* ---------------- 内部 ---------------- */

    private async ensureLauncher(): Promise<Host> {
        if (this.launcher && this.launcher.isAlive()) return this.launcher;
        const host = new Host(
            { ...this.cli, target: null },
            null,
            { initialProject: 'launcher' },
        );
        this.launcher = host;
        this.hosts.add(host);
        host.onClosed = () => {
            if (this.launcher === host) this.launcher = null;
            this.hosts.delete(host);
        };
        host.onOpenTargetRequest = (input) => void this.openTargetFromLauncher(input);
        host.onOpenUrlProjectRequest = (input) => void this.openUrlProjectFromLauncher(input);
        await host.start();
        return host;
    }

    private adopt(host: Host): void {
        this.hosts.add(host);
        host.onClosed = () => this.hosts.delete(host);
        host.onOpenUrlInDeskapp = (url) => void this.openUrlInDeskapp(url);
        host.onReturnLauncher = () => void this.returnToLauncher(host);
    }

    private registerIpc(): void {
        ipcMain.on(CH.probeSample, (e, sample: ProbeSample) => {
            this.findHost(e.sender)?.handleProbeSample(sample);
        });
        ipcMain.on(CH.pageReady, (e) => {
            this.findHost(e.sender)?.handlePageReady();
        });
        ipcMain.handle(CH.pageCommand, (e, cmd: PageCommand) => {
            return this.findHost(e.sender)?.handlePageCommand(cmd);
        });
        ipcMain.handle(CH.command, (e, cmd: ShellCommand) => {
            return this.findHost(e.sender)?.handleShellCommand(cmd);
        });
        ipcMain.on(CH.shellReady, (e) => {
            this.findHost(e.sender)?.handleShellReady(e.sender);
        });
    }

    private findHost(sender: WebContents): Host | null {
        for (const h of this.hosts) {
            if (h.owns(sender)) return h;
        }
        return null;
    }

    /** 菜单动作只作用于当前聚焦的窗口（多窗口时不能都发给同一个）。 */
    private focusedHost(): Host | null {
        for (const h of this.hosts) {
            if (h.isAlive() && h.win?.isFocused()) return h;
        }
        if (this.launcher && this.launcher.isAlive()) return this.launcher;
        for (const h of this.hosts) {
            if (h.isAlive()) return h;
        }
        return null;
    }

    private installMenu(): void {
        if (process.platform !== 'darwin') {
            // Win/Linux：不挂菜单栏，窗口顶上就没有那条"这是个浏览器"的横条
            Menu.setApplicationMenu(null);
            return;
        }
        // mac 必须留菜单，否则 Cmd+Q / Cmd+W / Cmd+H 全失效，反而不像原生应用
        const name = app.getName();
        Menu.setApplicationMenu(
            Menu.buildFromTemplate([
                {
                    label: name,
                    submenu: [
                        { role: 'about' },
                        { type: 'separator' },
                        { role: 'hide' },
                        { role: 'hideOthers' },
                        { role: 'unhide' },
                        { type: 'separator' },
                        { role: 'quit' },
                    ],
                },
                {
                    label: '编辑',
                    submenu: [
                        { role: 'undo' },
                        { role: 'redo' },
                        { type: 'separator' },
                        { role: 'cut' },
                        { role: 'copy' },
                        { role: 'paste' },
                        { role: 'selectAll' },
                    ],
                },
                {
                    label: '视图',
                    submenu: [
                        {
                            label: '全屏',
                            accelerator: 'Ctrl+Cmd+F',
                            click: () => this.focusedHost()?.toggleFullscreen(),
                        },
                        {
                            label: 'Inspector',
                            accelerator: 'Alt+Cmd+I',
                            click: () => this.focusedHost()?.toggleInspector(),
                        },
                        { type: 'separator' },
                        {
                            label: '重新加载',
                            accelerator: 'Cmd+Shift+R',
                            click: () => this.focusedHost()?.reload(true),
                        },
                        {
                            label: '销毁并重建渲染进程',
                            accelerator: 'Cmd+Shift+P',
                            click: () => {
                                const h = this.focusedHost();
                                if (h) void h.purge();
                            },
                        },
                        {
                            label: '页面 DevTools',
                            click: () => this.focusedHost()?.openDevTools(),
                        },
                    ],
                },
                { role: 'windowMenu', label: '窗口' },
            ]),
        );
    }
}
