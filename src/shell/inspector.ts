/**
 * Inspector —— 独立窗口里的开发者面板。
 * 数据全部由主进程推送，这里只做展示，不持有任何状态判断逻辑。
 */

import { shell, type PageLogEntry } from './api';
import type { HostAlert, HostState, ProbeSample, SystemSample } from '../shared/types';
import { FrameGraph } from './frame-graph';

const MB = 1024 * 1024;

const TEMPLATE = `
<div class="insp">
  <div class="insp-head">
    <div class="name" id="t-name">未装载</div>
    <div class="path" id="t-path"></div>
  </div>

  <div class="insp-bar">
    <button data-cmd="reload">刷新</button>
    <button data-cmd="hard-reload">硬刷新</button>
    <button data-cmd="purge">销毁重建</button>
    <button data-cmd="gc">GC</button>
    <button data-cmd="devtools">DevTools</button>
    <button data-cmd="fullscreen">全屏</button>
    <button data-cmd="screenshot">截图</button>
    <button data-cmd="return-launcher">返回启动器</button>
  </div>

  <div class="insp-body">
    <div id="banners"></div>

    <div class="card">
      <h3>帧</h3>
      <div class="body">
        <div class="hero">
          <span class="value" id="f-fps">—</span><span class="unit">fps</span>
          <span class="aside" id="f-budget"></span>
        </div>
        <canvas class="graph" id="f-graph"></canvas>
        <div class="kv" style="margin-top:8px">
          <span class="k">帧间隔 avg / p50</span><span class="v" id="f-avg">—</span>
          <span class="k">p95 / p99 / max</span><span class="v" id="f-tail">—</span>
          <span class="k">长帧（&gt;1.5×预算）</span><span class="v" id="f-long">—</span>
          <span class="k">主线程脚本 avg / max</span><span class="v" id="f-script">—</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>显存记账</h3>
      <div class="body">
        <div class="hero">
          <span class="value" id="v-total">—</span><span class="unit">MB</span>
          <span class="aside" id="v-limit"></span>
        </div>
        <div class="meter"><i id="v-meter" style="width:0"></i></div>
        <div class="kv">
          <span class="k">纹理</span><span class="v" id="v-tex">—</span>
          <span class="k">renderbuffer</span><span class="v" id="v-rb">—</span>
          <span class="k">buffer（VBO/IBO）</span><span class="v" id="v-buf">—</span>
          <span class="k">WebGPU 纹理 / buffer</span><span class="v" id="v-wgpu">—</span>
          <span class="k">峰值</span><span class="v" id="v-peak">—</span>
        </div>
        <div class="note">
          记账值是<strong>下界</strong>：三通道格式按四通道计、驱动对齐补齐未计入，真实占用只会更高。
          用于判断「离 400MB 死线还有多远」足够，不能当精确显存读数。
        </div>
      </div>
    </div>

    <div class="card">
      <h3>绘制与 GL 对象</h3>
      <div class="body">
        <div class="kv">
          <span class="k">draw call 每帧 avg / max</span><span class="v" id="d-calls">—</span>
          <span class="k">纹理 / buffer / renderbuffer</span><span class="v" id="d-obj1">—</span>
          <span class="k">framebuffer / program</span><span class="v" id="d-obj2">—</span>
          <span class="k">WebGL 上下文数</span><span class="v" id="d-ctx">—</span>
        </div>
        <div class="note">
          对象数是「create 减 delete」。持续单向上涨即为泄漏：未显式 delete 的 GL 对象
          只有等 JS 对象被 GC 才会释放，时机不可控。
        </div>
      </div>
    </div>

    <div class="card">
      <h3>内存</h3>
      <div class="body">
        <div class="kv">
          <span class="k">JS 堆 已用 / 总量</span><span class="v" id="m-heap">—</span>
          <span class="k">JS 堆上限</span><span class="v" id="m-limit">—</span>
          <span class="k">webapp 渲染进程 RSS</span><span class="v" id="m-rss">—</span>
          <span class="k">GPU 进程 RSS</span><span class="v" id="m-gpu">—</span>
          <span class="k">Deskapp 全部进程合计</span><span class="v" id="m-total">—</span>
        </div>
        <table class="procs" style="margin-top:9px">
          <thead><tr><th>进程</th><th>CPU%</th><th>RSS MB</th></tr></thead>
          <tbody id="m-procs"></tbody>
        </table>
      </div>
    </div>

    <div class="card" id="custom-card" style="display:none">
      <h3>应用自报指标</h3>
      <div class="body"><div class="kv" id="custom-kv"></div></div>
    </div>

    <div class="card">
      <h3>GPU</h3>
      <div class="body">
        <div class="kv">
          <span class="k">渲染器</span><span class="v" id="g-renderer">—</span>
          <span class="k">厂商</span><span class="v" id="g-vendor">—</span>
          <span class="k">GL 版本</span><span class="v" id="g-glver">—</span>
          <span class="k">WebGL / WebGL2</span><span class="v" id="g-webgl">—</span>
          <span class="k">GPU 合成</span><span class="v" id="g-comp">—</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>设置</h3>
      <div class="body">
        <div class="settings">
          <span class="k">性能档位</span>
          <select id="s-profile">
            <option value="balanced">balanced</option>
            <option value="max-perf">max-perf</option>
            <option value="compat">compat</option>
          </select>
          <span class="k">显存告警线 MB</span>
          <input id="s-vram" type="number" min="0" step="50">
          <span class="k">RSS 告警线 MB</span>
          <input id="s-rss" type="number" min="0" step="100">
          <span class="k">采样周期 ms</span>
          <input id="s-interval" type="number" min="50" step="50">
        </div>
        <div class="note">档位与 ANGLE 后端是 Chromium 进程级开关，改了要重启 Deskapp 才生效。</div>
      </div>
    </div>

    <div class="card">
      <h3>日志</h3>
      <div class="body"><div class="log" id="log"></div></div>
    </div>
  </div>
</div>`;

function n(v: number, digits = 1): string {
    return v.toFixed(digits);
}

export function mountInspector(root: HTMLElement): void {
    root.innerHTML = TEMPLATE;
    const api = shell();
    const $ = (id: string): HTMLElement => root.querySelector(`#${id}`) as HTMLElement;

    const graph = new FrameGraph($('f-graph') as HTMLCanvasElement);
    let state: HostState | null = null;
    let lastBudget = 1000 / 60;

    /* ---------- 工具栏 ---------- */

    root.querySelector('.insp-bar')?.addEventListener('click', (e) => {
        const cmd = (e.target as HTMLElement).closest('[data-cmd]')?.getAttribute('data-cmd');
        switch (cmd) {
            case 'reload':
                void api.command({ type: 'reload' });
                graph.clear();
                break;
            case 'hard-reload':
                void api.command({ type: 'reload', hard: true });
                graph.clear();
                break;
            case 'purge':
                void api.command({ type: 'purge' });
                graph.clear();
                break;
            case 'gc':
                void api.command({ type: 'gc' });
                break;
            case 'devtools':
                void api.command({ type: 'devtools' });
                break;
            case 'fullscreen':
                void api.command({ type: 'toggle-fullscreen' });
                break;
            case 'screenshot':
                void api.command({ type: 'screenshot' });
                break;
            case 'return-launcher':
                void api.command({ type: 'return-launcher' });
                break;
            default:
                break;
        }
    });

    /* ---------- 设置 ---------- */

    const profileSel = $('s-profile') as HTMLSelectElement;
    const vramInput = $('s-vram') as HTMLInputElement;
    const rssInput = $('s-rss') as HTMLInputElement;
    const intervalInput = $('s-interval') as HTMLInputElement;

    profileSel.addEventListener('change', () => {
        void api.command({
            type: 'set-settings',
            patch: { profile: profileSel.value as HostState['settings']['profile'] },
        });
    });
    const numberSetting = (
        el: HTMLInputElement,
        key: 'vramLimitMB' | 'rssLimitMB' | 'sampleIntervalMs',
    ): void => {
        el.addEventListener('change', () => {
            const v = Number(el.value);
            if (Number.isFinite(v) && v > 0) {
                void api.command({ type: 'set-settings', patch: { [key]: v } });
            }
        });
    };
    numberSetting(vramInput, 'vramLimitMB');
    numberSetting(rssInput, 'rssLimitMB');
    numberSetting(intervalInput, 'sampleIntervalMs');

    /* ---------- 日志 ---------- */

    const logEl = $('log');
    const appendLog = (level: string, code: string, message: string): void => {
        const line = document.createElement('div');
        line.className = `line ${level}`;
        const c = document.createElement('span');
        c.className = 'code';
        c.textContent = code;
        line.append(c, document.createTextNode(message));
        logEl.prepend(line);
        while (logEl.childElementCount > 300) logEl.lastElementChild?.remove();
    };

    api.onAlert((a: HostAlert) => appendLog(a.level, a.code, a.message));
    api.onPageLog((l: PageLogEntry) =>
        appendLog(l.level === 'error' ? 'error' : 'warn', 'console', l.message),
    );

    /* ---------- 状态 ---------- */

    api.onState((s: HostState) => {
        state = s;
        $('t-name').textContent = s.target?.label ?? '未装载';
        $('t-path').textContent = s.target?.value ?? '在启动器里选择一个目录或输入 URL';

        profileSel.value = s.settings.profile;
        if (document.activeElement !== vramInput) vramInput.value = String(s.settings.vramLimitMB);
        if (document.activeElement !== rssInput) rssInput.value = String(s.settings.rssLimitMB);
        if (document.activeElement !== intervalInput) {
            intervalInput.value = String(s.settings.sampleIntervalMs);
        }

        const banners: string[] = [];
        if (s.loadError) {
            banners.push(`<div class="banner err">加载失败：${escapeHtml(s.loadError)}</div>`);
        }
        if (s.gpu?.softwareRendering) {
            banners.push(
                `<div class="banner err">正在软件渲染（${escapeHtml(s.gpu.glRenderer)}）——性能数据不具参考价值</div>`,
            );
        }
        if (s.crashCount > 0) {
            banners.push(
                `<div class="banner warn">渲染进程已崩溃 ${s.crashCount} 次</div>`,
            );
        }
        $('banners').innerHTML = banners.join('');

        const g = s.gpu;
        $('g-renderer').textContent = g?.glRenderer || '—';
        $('g-vendor').textContent = g?.glVendor || '—';
        $('g-glver').textContent = g?.glVersion || '—';
        $('g-webgl').textContent = g
            ? `${g.featureStatus.webgl ?? '?'} / ${g.featureStatus.webgl2 ?? '?'}`
            : '—';
        $('g-comp').textContent = g?.featureStatus.gpu_compositing ?? '—';
    });

    /* ---------- 探针采样 ---------- */

    api.onSample((s: ProbeSample) => {
        lastBudget = s.frame.budgetMs || lastBudget;
        graph.push(s.frame.intervals);
        graph.draw(lastBudget);

        const f = s.frame;
        $('f-fps').textContent = f.frames > 0 ? n(f.fps) : '—';
        $('f-budget').textContent = `预算 ${n(lastBudget, 2)}ms · ${f.frames} 帧/窗口`;
        $('f-avg').textContent = `${n(f.avgMs, 2)} / ${n(f.p50Ms, 2)} ms`;
        $('f-tail').textContent = `${n(f.p95Ms, 2)} / ${n(f.p99Ms, 2)} / ${n(f.maxMs, 1)} ms`;
        setVal($('f-long'), String(f.longFrames), f.longFrames > 0 ? 'warn' : 'ok');
        $('f-script').textContent = `${n(f.scriptAvgMs, 2)} / ${n(f.scriptMaxMs, 2)} ms`;

        const limit = state?.settings.vramLimitMB ?? 400;
        const totalMB = s.vram.total / MB;
        $('v-total').textContent = n(totalMB);
        $('v-limit').textContent = `告警线 ${limit}MB`;
        const meter = $('v-meter');
        const ratio = Math.min(1, totalMB / limit);
        meter.style.width = `${(ratio * 100).toFixed(1)}%`;
        meter.className = totalMB > limit ? 'err' : ratio > 0.8 ? 'warn' : '';
        $('v-tex').textContent = `${n(s.vram.textures / MB)} MB`;
        $('v-rb').textContent = `${n(s.vram.renderbuffers / MB)} MB`;
        $('v-buf').textContent = `${n(s.vram.buffers / MB)} MB`;
        $('v-wgpu').textContent =
            `${n(s.vram.gpuTextures / MB)} / ${n(s.vram.gpuBuffers / MB)} MB`;
        $('v-peak').textContent = `${n(s.vram.peak / MB)} MB`;

        $('d-calls').textContent = `${n(s.drawCallsAvg, 0)} / ${s.drawCallsMax}`;
        $('d-obj1').textContent =
            `${s.counts.textures} / ${s.counts.buffers} / ${s.counts.renderbuffers}`;
        $('d-obj2').textContent = `${s.counts.framebuffers} / ${s.counts.programs}`;
        $('d-ctx').textContent = s.gl
            ? `${s.gl.contexts}（WebGL ${s.gl.webglVersion}，最大纹理 ${s.gl.maxTextureSize}）`
            : '—';

        if (s.heap) {
            $('m-heap').textContent = `${n(s.heap.usedMB)} / ${n(s.heap.totalMB)} MB`;
            $('m-limit').textContent = `${n(s.heap.limitMB, 0)} MB`;
        }

        const keys = Object.keys(s.custom);
        const card = $('custom-card');
        if (keys.length === 0) {
            card.style.display = 'none';
        } else {
            card.style.display = '';
            const kv = $('custom-kv');
            kv.replaceChildren(
                ...keys.sort().flatMap((k) => {
                    const kEl = document.createElement('span');
                    kEl.className = 'k';
                    kEl.textContent = k;
                    const vEl = document.createElement('span');
                    vEl.className = 'v';
                    vEl.textContent = formatCustom(s.custom[k]);
                    return [kEl, vEl];
                }),
            );
        }
    });

    /* ---------- 进程采样 ---------- */

    api.onSystem((s: SystemSample) => {
        const rssLimit = state?.settings.rssLimitMB ?? Number.POSITIVE_INFINITY;
        setVal(
            $('m-rss'),
            `${n(s.appRendererMB, 0)} MB`,
            s.appRendererMB > rssLimit ? 'warn' : '',
        );
        $('m-gpu').textContent = `${n(s.gpuProcessMB, 0)} MB`;
        $('m-total').textContent = `${n(s.totalMB, 0)} MB`;

        const tbody = $('m-procs');
        tbody.replaceChildren(
            ...s.procs.slice(0, 8).map((p) => {
                const tr = document.createElement('tr');
                if (p.role === 'app') tr.className = 'app';
                for (const [text, right] of [
                    [p.name, false],
                    [n(p.cpuPercent, 1), true],
                    [n(p.memoryMB, 0), true],
                ] as Array<[string, boolean]>) {
                    const td = document.createElement('td');
                    td.textContent = text;
                    if (right) td.style.textAlign = 'right';
                    tr.append(td);
                }
                return tr;
            }),
        );
    });

    // 窗口尺寸变化时重画（canvas 是 CSS 宽度自适应的）
    window.addEventListener('resize', () => graph.draw(lastBudget));

    api.ready();
}

function setVal(el: HTMLElement, text: string, cls: string): void {
    el.textContent = text;
    el.className = `v${cls ? ` ${cls}` : ''}`;
}

function formatCustom(v: number): string {
    if (!Number.isFinite(v)) return String(v);
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(2);
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
    );
}
