/**
 * Sidecar —— 宿主托管的后端进程。
 *
 * 为什么必须有：很多本地 webapp 不是"已经跑着的 URL"，而是"要先把服务拉起来才有 URL"
 * （例如 `npx` 起一个本地 dev server）。只能装载现成 URL 的壳对用户是半成品。
 *
 * 三个容易做错、这里都处理了的点：
 *
 * ① **PATH**：从图形界面启动的 app 拿不到用户在 shell 配置里设的 PATH ——
 *    macOS 的 Finder 只给极简 PATH（`/usr/bin:/bin:/usr/sbin:/sbin`），
 *    Linux 的桌面项（.desktop）同理，两边都找不到 `npx` / `node` / pnpm 的 shim。
 *    所以非绝对路径的命令一律经**登录 shell** 执行，借它把用户真实 PATH 带进来。
 *    Windows 不走这条：那里 PATH 来自注册表，进程继承的就是完整的。
 *
 * ② **进程树**：`npx X` 会再 spawn node，node 可能再 spawn worker。
 *    只杀直接子进程会留下一堆孤儿继续占着端口。这里用独立进程组 + 组信号
 *    （Windows 走 `taskkill /T`）。
 *
 * ③ **不杀不是自己起的东西**：启动前先探一次 readyUrl，已经有人在跑就直接沿用，
 *    退出时也不去动它。用户自己开的开发服务器不该被我们杀掉。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { net } from 'electron';

export interface SidecarConfig {
    /**
     * 原样交给登录 shell 执行的命令行 —— 用户手写的那种（`npx foo bar --baz`）。
     * 与 command/args 二选一，优先。
     */
    shellLine?: string;
    /** 可执行命令。含路径分隔符时按绝对/相对路径直接执行，否则经登录 shell 查找 */
    command?: string;
    args?: string[];
    /** 工作目录，相对内嵌配置文件所在目录 */
    cwd?: string;
    env?: Record<string, string>;
    /** 就绪探测地址。给了就轮询到它有响应为止；不给则固定等 waitMs */
    readyUrl?: string;
    /** 就绪超时（ms），默认 90000 —— npx 首次运行可能要下载包 */
    readyTimeoutMs?: number;
    /** 没有 readyUrl 时的固定等待（ms），默认 1500 */
    waitMs?: number;
    /** 退出时等它自己收摊的时间（ms），超时后强杀，默认 5000 */
    shutdownTimeoutMs?: number;
}

export type SidecarLog = (level: 'info' | 'warn' | 'error', message: string) => void;

const POLL_INTERVAL_MS = 300;

/** 单引号包裹，内部单引号转义 —— 交给 shell 时防止拆词与注入。 */
function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class Sidecar {
    private child: ChildProcess | null = null;
    /** 服务在我们启动之前就已经在跑 —— 沿用它，退出时不要杀 */
    private adopted = false;
    private stopped = false;

    constructor(
        private cfg: SidecarConfig,
        private baseDir: string,
        private log: SidecarLog,
    ) {}

    get running(): boolean {
        return this.adopted || (this.child !== null && this.child.exitCode === null);
    }

    /** 我们自己拉起来的（决定退出时要不要杀）。 */
    get owned(): boolean {
        return this.child !== null && !this.adopted;
    }

    /**
     * 确保服务可用。返回 true = 可以去加载页面了。
     */
    async ensureUp(): Promise<boolean> {
        if (this.cfg.readyUrl && (await this.probe(this.cfg.readyUrl))) {
            this.adopted = true;
            this.log('info', `服务已在运行，沿用现有实例（退出时不会关闭它）：${this.cfg.readyUrl}`);
            return true;
        }

        if (!this.spawnChild()) return false;

        if (!this.cfg.readyUrl) {
            await sleep(this.cfg.waitMs ?? 1500);
            return this.running;
        }

        const timeout = this.cfg.readyTimeoutMs ?? 90_000;
        const deadline = Date.now() + timeout;
        let lastLogged = 0;
        while (Date.now() < deadline) {
            // **先探地址、后判进程存活**，顺序不能反。
            // 常见写法是启动脚本把真正的服务丢到后台自己就退了
            // （`docker compose up -d`、`./start.sh &` 这类）。
            // 先判存活会把这种正常情况判成失败 —— 判据应该是"地址通不通"，
            // 而不是"我们 spawn 的那个进程还在不在"。
            if (await this.probe(this.cfg.readyUrl)) {
                this.log('info', `服务就绪：${this.cfg.readyUrl}`);
                if (!this.running) {
                    this.log(
                        'info',
                        '启动命令自身已退出，服务由它派生的后台进程提供 —— ' +
                            '这种情况 Deskapp 无法代为收尾，请在关闭脚本里自行停止',
                    );
                }
                return true;
            }
            if (!this.running) {
                this.log('error', '启动命令已退出，且地址仍不可达');
                return false;
            }
            const waited = Math.round((timeout - (deadline - Date.now())) / 1000);
            if (waited >= lastLogged + 5) {
                lastLogged = waited;
                this.log('info', `等待服务就绪… ${waited}s`);
            }
            await sleep(POLL_INTERVAL_MS);
        }
        this.log('error', `等待服务就绪超时（${timeout / 1000}s）：${this.cfg.readyUrl}`);
        return false;
    }

    private async probe(url: string): Promise<boolean> {
        try {
            const res = await net.fetch(url, { method: 'GET' });
            // 只要有 HTTP 响应就算起来了 —— 4xx/5xx 也说明端口在监听
            return res.status > 0;
        } catch {
            return false;
        }
    }

    /** 人类可读的命令描述，用于日志与执行确认框。 */
    describe(): string {
        if (this.cfg.shellLine) return this.cfg.shellLine;
        return [this.cfg.command ?? '', ...(this.cfg.args ?? [])].join(' ').trim();
    }

    private spawnChild(): boolean {
        const cwd = this.cfg.cwd
            ? isAbsolute(this.cfg.cwd)
                ? this.cfg.cwd
                : resolve(this.baseDir, this.cfg.cwd)
            : this.baseDir;

        const env = { ...process.env, ...(this.cfg.env ?? {}) };
        const plan = planExec(this.cfg);
        if (!plan) {
            this.log('error', '命令为空，无法启动');
            return false;
        }

        this.log('info', `启动服务：${this.describe()}（cwd=${cwd}）`);

        try {
            this.child = spawn(plan.file, plan.argv, {
                cwd,
                env,
                // 独立进程组：退出时能把 npx → node → worker 整棵树一起收掉
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (err) {
            this.log('error', `服务启动失败：${String(err)}`);
            return false;
        }

        const pipe = (
            stream: NodeJS.ReadableStream | null,
            level: 'info' | 'error',
        ): void => {
            stream?.setEncoding('utf8');
            stream?.on('data', (chunk: string) => {
                for (const line of chunk.split('\n')) {
                    const t = line.trimEnd();
                    if (t) this.log(level, t.slice(0, 500));
                }
            });
        };
        pipe(this.child.stdout, 'info');
        // 很多 CLI 把正常日志写 stderr，所以按 warn 而不是 error 记
        pipe(this.child.stderr, 'info');

        this.child.on('error', (err) => {
            this.log('error', `服务进程错误：${err.message}`);
        });
        this.child.on('exit', (code, signal) => {
            if (this.stopped) return;
            this.log(
                code === 0 ? 'info' : 'error',
                `服务进程退出：code=${code} signal=${signal ?? '-'}`,
            );
        });

        return true;
    }

    /** 退出时调用。只杀自己启动的进程树。 */
    stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        const child = this.child;
        if (!child || child.exitCode !== null || child.pid === undefined) return;
        if (this.adopted) return;

        this.log('info', `关闭服务进程树（pid=${child.pid}）`);
        killTree(child, 'SIGTERM');

        // 给它时间自己收摊，超时再强杀
        const grace = this.cfg.shutdownTimeoutMs ?? 5000;
        const timer = setTimeout(() => killTree(child, 'SIGKILL'), grace);
        timer.unref?.();
        child.once('exit', () => clearTimeout(timer));
    }
}

/**
 * 决定怎么起这个进程。
 *
 * `shellLine` 原样交给登录 shell —— 用户手写的命令行本来就是给 shell 读的，
 * 自己去拆词只会拆错（引号、管道、`&&` 全得重新实现一遍）。
 * `command`+`args` 是显式形式：给了路径就直接 exec，没给路径也要过一次登录 shell 找它。
 */
function planExec(cfg: SidecarConfig): { file: string; argv: string[] } | null {
    // 兜底用 /bin/sh 而不是某个具体 shell：它是 POSIX 唯一保证存在的那个。
    // 写死 zsh 在多数 Linux 发行版上直接 ENOENT，服务根本起不来。
    const shell = process.env.SHELL || (process.platform === 'win32' ? '' : '/bin/sh');

    if (cfg.shellLine && cfg.shellLine.trim()) {
        const line = cfg.shellLine.trim();
        if (process.platform === 'win32') {
            return { file: process.env.ComSpec || 'cmd.exe', argv: ['/d', '/s', '/c', line] };
        }
        return { file: shell, argv: ['-lc', `exec ${line}`] };
    }

    const command = cfg.command?.trim();
    if (!command) return null;
    const args = cfg.args ?? [];
    const isPath = command.includes('/') || command.includes('\\');
    if (isPath || process.platform === 'win32') return { file: command, argv: args };

    // 经登录 shell 找命令：Finder 启动的 app 拿不到用户 PATH。
    // exec 让 shell 把自己替换掉，进程组里少一层壳。
    const line = [command, ...args].map(shellQuote).join(' ');
    return { file: shell, argv: ['-lc', `exec ${line}`] };
}

/**
 * 一次性执行一条命令并等它结束 —— 项目的 startup / shutdown 钩子用。
 * 与 Sidecar 共用同一套 PATH 解析与进程组语义，钩子里起的后台进程也能被收掉。
 */
export function runOnce(
    cfg: SidecarConfig,
    baseDir: string,
    log: SidecarLog,
    timeoutMs: number,
): Promise<{ ok: boolean; code: number | null }> {
    const plan = planExec(cfg);
    if (!plan) return Promise.resolve({ ok: false, code: null });

    const cwd = cfg.cwd
        ? isAbsolute(cfg.cwd)
            ? cfg.cwd
            : resolve(baseDir, cfg.cwd)
        : baseDir;

    return new Promise((resolve_) => {
        let child: ChildProcess;
        try {
            child = spawn(plan.file, plan.argv, {
                cwd,
                env: { ...process.env, ...(cfg.env ?? {}) },
                detached: process.platform !== 'win32',
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (err) {
            log('error', `执行失败：${String(err)}`);
            resolve_({ ok: false, code: null });
            return;
        }

        for (const stream of [child.stdout, child.stderr]) {
            stream?.setEncoding('utf8');
            stream?.on('data', (chunk: string) => {
                for (const line of chunk.split('\n')) {
                    const t = line.trimEnd();
                    if (t) log('info', t.slice(0, 500));
                }
            });
        }

        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            log('error', `超时 ${timeoutMs}ms，终止`);
            killTree(child);
            settled = true;
            resolve_({ ok: false, code: null });
        }, timeoutMs);
        timer.unref?.();

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            log('error', `执行错误：${err.message}`);
            resolve_({ ok: false, code: null });
        });
        child.on('exit', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve_({ ok: code === 0, code });
        });
    });
}

/** 收掉整棵进程树（负 pid = 进程组；Windows 走 taskkill /T）。 */
function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null) return;
    if (process.platform === 'win32') {
        try {
            spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        } catch {
            /* 已经没了 */
        }
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            /* 已经没了 */
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
