/** IPC 频道名集中定义，避免三方各写一份字符串。 */
export const CH = {
    /* ---- preload(被装载页) → 主进程 ---- */
    /** 探针周期上报 */
    probeSample: 'deskapp:probe-sample',
    /** 页面调 deskapp.* 的控制请求（invoke） */
    pageCommand: 'deskapp:page-command',
    /** 探针安装完成 / 页面就绪 */
    pageReady: 'deskapp:page-ready',

    /* ---- 主进程 → preload ---- */
    /** 下发采样周期等配置 */
    probeConfig: 'deskapp:probe-config',
    /** 要求页面立即回采一次 */
    probeFlush: 'deskapp:probe-flush',
    /** 推给页面的宿主事件（全屏变化 / 即将 purge / 设置变更） */
    pageEvent: 'deskapp:page-event',

    /* ---- shell UI ↔ 主进程 ---- */
    /** shell 就绪，请求首帧状态 */
    shellReady: 'deskapp:shell-ready',
    /** 主进程推送宿主状态 */
    state: 'deskapp:state',
    /** 主进程推送探针采样（转发页面上报） */
    sample: 'deskapp:sample',
    /** 主进程推送系统进程采样 */
    system: 'deskapp:system',
    /** 主进程推送告警 */
    alert: 'deskapp:alert',
    /** 主进程推送页面 console 消息（仅 warn/error） */
    pageLog: 'deskapp:page-log',
    /** shell 调命令（invoke） */
    command: 'deskapp:command',
    /** 推给自绘标题栏的身份状态（低频） */
    titlebar: 'deskapp:titlebar',
    /** 推给自绘标题栏的实时指标（约 2Hz） */
    titlebarMetrics: 'deskapp:titlebar-metrics',
} as const;

/** shell UI 可以发起的命令。 */
export type ShellCommand =
    | { type: 'open-dir' }
    | { type: 'open-url'; url: string }
    | { type: 'open-target'; target: { kind: 'dir' | 'url'; value: string } }
    | { type: 'reload'; hard?: boolean }
    | { type: 'purge' }
    | { type: 'gc' }
    | { type: 'heap-snapshot' }
    | { type: 'devtools' }
    | { type: 'shell-devtools' }
    | { type: 'toggle-fullscreen' }
    | { type: 'toggle-panel' }
    | { type: 'set-settings'; patch: Partial<import('./types').HostSettings> }
    | { type: 'get-state' }
    | { type: 'clear-recents' }
    | { type: 'screenshot' }
    /** 选目录打开项目 */
    | { type: 'open-project' }
    /**
     * 网址模式：以一个 URL 为入口新建项目并打开。
     * 与本地项目唯一的区别是 entry 是 URL，其余（启动/关闭脚本、窗口、导出）完全一致。
     */
    | {
          type: 'create-url-project';
          url: string;
          name?: string;
          startup?: string;
          shutdown?: string;
      }
    /** 导出项目为独立桌面应用；不给 dir 就导当前项目 */
    | { type: 'export-project'; dir?: string };

/** 被装载页面可以发起的命令（window.deskapp）。 */
export type PageCommand =
    | { type: 'info' }
    | { type: 'set-fullscreen'; value: boolean }
    | { type: 'set-window-size'; width: number; height: number }
    | { type: 'set-title'; title: string }
    | { type: 'mark'; name: string }
    | { type: 'request-reload' }
    | { type: 'request-quit' }
    | { type: 'open-external'; url: string }
    | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** 主进程推给被装载页面的事件。 */
export type PageEvent =
    | { type: 'fullscreen-change'; value: boolean }
    | { type: 'visibility'; visible: boolean }
    | { type: 'before-purge' }
    | { type: 'settings-change'; settings: import('./types').HostSettings };
