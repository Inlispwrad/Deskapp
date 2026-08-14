/**
 * 进程级资源采样。
 *
 * 口径：`app.getAppMetrics()` 的 `memory.workingSetSize` 单位是 **KB**（不是字节）。
 * GPU 进程 RSS 不等于 VRAM，但它随纹理/RT 分配同向变化，
 * 用来交叉验证页面内的显存记账是否漏记（两者长期背离说明记账有洞）。
 */

import { app } from 'electron';
import type { ProcMetric, SystemSample } from '../shared/types';

export interface PidRoles {
    /** 被装载 webapp 的渲染进程 */
    app: number | null;
    /** shell UI（开发者覆盖层）的渲染进程 */
    shell: number | null;
}

export function sampleSystem(roles: PidRoles): SystemSample {
    const procs: ProcMetric[] = [];
    let appRendererMB = 0;
    let gpuProcessMB = 0;
    let totalMB = 0;

    for (const m of app.getAppMetrics()) {
        const memoryMB = (m.memory?.workingSetSize ?? 0) / 1024;
        const cpuPercent = m.cpu?.percentCPUUsage ?? 0;
        let role: ProcMetric['role'] = 'other';
        let name = m.name ?? m.serviceName ?? m.type;

        if (m.pid === roles.app) {
            role = 'app';
            name = 'webapp renderer';
        } else if (m.pid === roles.shell) {
            role = 'shell';
            name = 'deskapp shell';
        } else if (m.type === 'GPU') {
            role = 'gpu';
            name = 'GPU process';
        } else if (m.type === 'Browser') {
            role = 'browser';
            name = 'main process';
        }

        if (role === 'app') appRendererMB = memoryMB;
        if (role === 'gpu') gpuProcessMB = memoryMB;
        totalMB += memoryMB;

        procs.push({ pid: m.pid, type: m.type, role, name, cpuPercent, memoryMB });
    }

    procs.sort((a, b) => b.memoryMB - a.memoryMB);

    return { t: Date.now(), procs, appRendererMB, gpuProcessMB, totalMB };
}
