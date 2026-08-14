/** shell preload 暴露的 API 的类型声明。 */

import type { ShellCommand } from '../shared/channels';
import type {
    HostAlert,
    HostState,
    ProbeSample,
    SystemSample,
    TitlebarMetrics,
    TitlebarState,
} from '../shared/types';

export interface PageLogEntry {
    level: string;
    message: string;
    source: string;
    line: number;
}

export interface ShellApi {
    ready(): void;
    command(cmd: ShellCommand): Promise<unknown>;
    onState(fn: (s: HostState) => void): () => void;
    onSample(fn: (s: ProbeSample) => void): () => void;
    onSystem(fn: (s: SystemSample) => void): () => void;
    onAlert(fn: (a: HostAlert) => void): () => void;
    onPageLog(fn: (l: PageLogEntry) => void): () => void;
    onTitlebar(fn: (s: TitlebarState) => void): () => void;
    onTitlebarMetrics(fn: (m: TitlebarMetrics) => void): () => void;
}

declare global {
    interface Window {
        shell: ShellApi;
    }
}

export const shell = (): ShellApi => window.shell;
