/**
 * shell UI（开发者覆盖层）的 preload。
 * 与被装载页面的 preload 完全分离：这里开启 contextIsolation，只放出必要的 IPC 通道。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { CH, type ShellCommand } from '../shared/channels';
import type {
    HostAlert,
    HostState,
    ProbeSample,
    SystemSample,
    TitlebarMetrics,
    TitlebarState,
} from '../shared/types';

type Off = () => void;

function on<T>(channel: string, fn: (payload: T) => void): Off {
    const handler = (_e: unknown, payload: T) => fn(payload);
    ipcRenderer.on(channel, handler as never);
    return () => ipcRenderer.off(channel, handler as never);
}

const shellApi = {
    ready(): void {
        ipcRenderer.send(CH.shellReady);
    },
    command(cmd: ShellCommand): Promise<unknown> {
        return ipcRenderer.invoke(CH.command, cmd);
    },
    onState: (fn: (s: HostState) => void): Off => on(CH.state, fn),
    onSample: (fn: (s: ProbeSample) => void): Off => on(CH.sample, fn),
    onSystem: (fn: (s: SystemSample) => void): Off => on(CH.system, fn),
    onAlert: (fn: (a: HostAlert) => void): Off => on(CH.alert, fn),
    onPageLog: (
        fn: (l: { level: string; message: string; source: string; line: number }) => void,
    ): Off => on(CH.pageLog, fn),
    onTitlebar: (fn: (s: TitlebarState) => void): Off => on(CH.titlebar, fn),
    onTitlebarMetrics: (fn: (m: TitlebarMetrics) => void): Off => on(CH.titlebarMetrics, fn),
};

contextBridge.exposeInMainWorld('shell', shellApi);

export type ShellApi = typeof shellApi;
