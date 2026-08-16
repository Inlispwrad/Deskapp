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

/** 项目没给图标时的回退图标：应用自己的 icon（透明背景版，64px）。 */
const FALLBACK_ICON = 'data:image/png;base64,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';

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

    // 项目图标尚未到达前，先显示应用自己的图标，不留红方块占位
    icon.src = FALLBACK_ICON;
    mark.classList.add('has-icon');

    // 整个指标区就是一个按钮 —— 点哪一格结果都一样（都是开 Inspector），
    // 那就不该做成四个各自可点的小目标
    const data = $('tb-data');
    data.addEventListener('click', (e) => {
        // 鼠标点完主动失焦：这次点击会开/关 Inspector（独立窗口），焦点离开再回来时
        // Chromium 把这次恢复算作"非指针发起"，:focus-visible 命中，
        // 于是标题栏上会一直留着一圈红色描边。
        //
        // 必须只对鼠标做 —— 键盘按 Enter/Space 也会发 click，那种情况下失焦
        // 等于把 Tab 的落点弄丢，正好毁掉焦点环存在的意义。
        // 判据用 detail：鼠标点击 >= 1，键盘激活恒为 0。
        if (e.detail > 0) data.blur();
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
        } else {
            icon.src = FALLBACK_ICON;
        }
        mark.classList.add('has-icon');
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
