/**
 * 自绘标题栏。
 *
 * 为什么自绘：macOS 的原生标题栏不显示应用图标（平台惯例，无 API 可改），
 * 也没法定制外观。自绘之后图标、样式、右侧实时指标都能有。
 *
 * 关键约束（上一版踩过的坑）：**拖拽区必须由这里自己声明**。
 * 之前用 titleBarStyle:'hiddenInset' 把红绿灯压进内容里，指望被装载页面提供
 * `-webkit-app-region: drag` —— webapp 当然不会这么做，结果窗口拖不动。
 * 现在整条标题栏是 drag 区，交互元素单独标 no-drag。
 *
 * 毛玻璃来自窗口级的原生 vibrancy（macOS）/ backgroundMaterial（Windows），
 * 不是 CSS backdrop-filter —— 后者只能模糊同一页面内的背景，跨不过 WebContentsView。
 * 所以这里的 body 必须保持透明，让底下的原生效果透上来。
 */

import { shell } from './api';
import type { TitlebarMetrics, TitlebarState } from '../shared/types';

const TEMPLATE = `
<div class="tb" id="tb">
  <div class="tb-id">
    <div class="tb-rule"></div>
    <div class="tb-mark" id="tb-mark"><img class="tb-icon" id="tb-icon" alt=""></div>
    <div class="tb-title" id="tb-title">DESKAPP</div>
    <div class="tb-tag" id="tb-tag"></div>
  </div>
  <button class="tb-data" id="tb-data" type="button" title="打开 Inspector">
    <span class="tb-cell" data-cell="fps" title="帧率（按帧间隔中位数推算，抗长帧与空闲干扰）"><span class="tb-k">FPS</span><span class="tb-v" id="m-fps">—</span></span>
    <span class="tb-cell" data-cell="ms" title="主线程每帧脚本耗时 —— 响应性的真实读数"><span class="tb-k">MS</span><span class="tb-v" id="m-ms">—</span></span>
    <span class="tb-cell" data-cell="cpu" title="webapp 渲染进程 CPU 占用"><span class="tb-k">CPU</span><span class="tb-v" id="m-cpu">—</span></span>
    <span class="tb-cell" data-cell="mem" title="webapp 渲染进程 RSS"><span class="tb-k">MEM</span><span class="tb-v" id="m-mem">—</span></span>
    <span class="tb-accent"></span>
  </button>
</div>`;

/** 1 位小数，但整数不拖小数点 —— 数字位宽稳定，标题栏才不抖。 */
function fmt(v: number | null, digits: number, suffix = ''): string {
    if (v === null || !Number.isFinite(v)) return '—';
    return `${v.toFixed(digits)}${suffix}`;
}

export function mountTitlebar(root: HTMLElement): void {
    document.body.classList.add('titlebar-body');
    root.innerHTML = TEMPLATE;

    const api = shell();
    const $ = (id: string): HTMLElement => root.querySelector(`#${id}`) as HTMLElement;

    const tb = $('tb');
    const mark = $('tb-mark');
    const icon = $('tb-icon') as HTMLImageElement;
    const title = $('tb-title');
    const tag = $('tb-tag');
    const mFps = $('m-fps');
    const mMs = $('m-ms');
    const mCpu = $('m-cpu');
    const mMem = $('m-mem');

    // 整个指标区就是一个按钮 —— 点哪一格结果都一样（都是开 Inspector），
    // 那就不该做成四个各自可点的小目标
    $('tb-data').addEventListener('click', () => {
        void api.command({ type: 'toggle-panel' });
    });

    api.onTitlebar((s: TitlebarState) => {
        tb.style.paddingLeft = `${s.insetLeft}px`;
        tb.style.paddingRight = `${s.insetRight}px`;
        title.textContent = s.title || 'DESKAPP';
        tag.textContent = s.profile === 'balanced' ? '' : s.profile.toUpperCase();
        tb.classList.toggle('alert', s.alert);

        // 用 <img> 而不是 CSS background-image：URL 不进样式表，没有注入面；
        // 而且交给 Chromium 解码，.ico / .svg 都能正确显示
        //（主进程的 nativeImage 这两种格式都不支持）。
        if (s.iconUrl) {
            icon.src = s.iconUrl;
            mark.classList.add('has-icon');
        } else {
            icon.removeAttribute('src');
            mark.classList.remove('has-icon');
        }
    });

    api.onTitlebarMetrics((m: TitlebarMetrics) => {
        mFps.textContent = fmt(m.fps, 0);
        mMs.textContent = fmt(m.mainThreadMs, 1);
        mCpu.textContent = fmt(m.cpuPercent, 0, '%');
        mMem.textContent = m.memoryMB === null ? '—' : `${m.memoryMB.toFixed(0)}M`;

        // 帧率分档：< 25 黄（明显掉帧）、< 10 红（基本不可用）
        const fps = m.fps;
        mFps.classList.toggle('warm', fps !== null && fps < 25 && fps >= 10);
        mFps.classList.toggle('hot', fps !== null && fps < 10);
        // 主线程超过半个 60fps 帧预算就该警觉
        mMs.classList.toggle('warm', m.mainThreadMs !== null && m.mainThreadMs > 8);
        mMs.classList.toggle('hot', m.mainThreadMs !== null && m.mainThreadMs > 16);
    });

    api.ready();
}
