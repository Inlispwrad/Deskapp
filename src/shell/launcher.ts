/**
 * 启动器 —— 没有指定目标时装在应用窗口里的起始页。
 * 刻意做成"应用的项目选择界面"而不是浏览器新标签页。
 */

import { shell } from './api';
import type { AppTarget, HostState } from '../shared/types';

export function mountLauncher(root: HTMLElement): void {
    root.innerHTML = `
<div class="launcher">
  <div class="launcher-head">
    <h1>Deskapp</h1>
    <div class="sub">高性能 webapp 桌面宿主 —— 打开一个项目，或导出成独立应用</div>

    <div class="modes">
      <div class="mode">
        <div class="mode-title">本地项目</div>
        <div class="mode-sub">目录里有 index.html 即可，<code>deskapp.json</code> 可选</div>
        <button class="primary" data-act="open-project">选择目录…</button>
      </div>

      <div class="mode">
        <div class="mode-title">网址</div>
        <div class="mode-sub">入口是一个地址，其余与本地项目完全一样</div>
        <input id="url" type="text" placeholder="http://127.0.0.1:3080/" spellcheck="false">
        <div class="mode-extra">
          <input id="pname" type="text" placeholder="名称（可选）" spellcheck="false">
          <input id="pstart" type="text" placeholder="启动脚本（可选）—— 会等地址通了再加载" spellcheck="false">
          <input id="pstop" type="text" placeholder="关闭脚本（可选）" spellcheck="false">
        </div>
        <button id="go" data-act="open-url">装载</button>
        <div class="mode-note" id="urlnote">只填地址 = 看一眼，不留项目</div>
      </div>
    </div>

    <h2>最近项目</h2>
    <div class="recents" id="recents"><div class="empty">还没有记录</div></div>
  </div>

  <div class="launcher-foot">
    <span id="ver"></span>
    <span>F12 打开 Inspector</span>
  </div>
</div>`;

    const api = shell();
    const recents = root.querySelector('#recents') as HTMLElement;
    const urlInput = root.querySelector('#url') as HTMLInputElement;
    const ver = root.querySelector('#ver') as HTMLElement;

    const nameInput = root.querySelector('#pname') as HTMLInputElement;
    const startInput = root.querySelector('#pstart') as HTMLInputElement;
    const stopInput = root.querySelector('#pstop') as HTMLInputElement;
    const goBtn = root.querySelector('#go') as HTMLButtonElement;
    const note = root.querySelector('#urlnote') as HTMLElement;

    /**
     * 填了名称/脚本就必须建成项目（否则那些声明下次就没了）；
     * 只填地址就是"看一眼"，不留项目目录。按钮文案跟着变 —— 行为要看得见，不能靠猜。
     */
    const willPersist = (): boolean =>
        Boolean(nameInput.value.trim() || startInput.value.trim() || stopInput.value.trim());

    const syncMode = (): void => {
        const persist = willPersist();
        goBtn.textContent = persist ? '创建项目并打开' : '装载';
        goBtn.classList.toggle('primary', persist);
        note.textContent = persist
            ? '会在 Deskapp 的数据目录里生成一份 deskapp.json，之后可导出成独立应用'
            : '只填地址 = 看一眼，不留项目；装载后会出现在最近列表，可在那里导出成应用';
    };
    for (const el of [nameInput, startInput, stopInput]) {
        el.addEventListener('input', syncMode);
    }
    syncMode();

    const openUrl = (): void => {
        const raw = urlInput.value.trim();
        if (!raw) return;
        const url = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
        void api.command({
            type: 'create-url-project',
            url,
            name: nameInput.value.trim(),
            startup: startInput.value.trim(),
            shutdown: stopInput.value.trim(),
        });
    };

    root.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
        if (act === 'open-project') void api.command({ type: 'open-project' });
        if (act === 'open-url') openUrl();
    });
    for (const el of [urlInput, nameInput, startInput, stopInput]) {
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') openUrl();
        });
    }

    const renderRecents = (list: AppTarget[]): void => {
        if (list.length === 0) {
            recents.innerHTML = '<div class="empty">还没有记录</div>';
            return;
        }
        recents.replaceChildren(
            ...list.map((t) => {
                const el = document.createElement('div');
                el.className = 'recent';
                el.innerHTML = `
          <span class="kind">${t.kind === 'dir' ? '项目' : '临时'}</span>
          <span class="label"></span>
          <span class="path"></span>
          <button class="recent-export" title="导出成独立桌面应用">导出</button>`;
                (el.querySelector('.label') as HTMLElement).textContent = t.label;
                // .path 用 direction:rtl 让省略号出现在左侧（路径尾部才是有信息量的那段）。
                // 代价是开头的 '/' 是中性字符，会被 bidi 重排到行尾。前置一个 LRM
                // （U+200E，强 LTR）把整段锚成 LTR，同时保留左侧截断。
                (el.querySelector('.path') as HTMLElement).textContent = `‎${t.value}`;

                const exportBtn = el.querySelector('.recent-export') as HTMLButtonElement;
                exportBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); // 别顺带触发"打开这个项目"
                    if (t.kind === 'dir') {
                        void api.command({ type: 'export-project', dir: t.value });
                    } else {
                        // 临时网址：先晋升成 URL 项目，再导出成独立应用
                        void api.command({ type: 'export-url-project', url: t.value });
                    }
                });

                el.addEventListener('click', () => {
                    void api.command({
                        type: 'open-target',
                        target: { kind: t.kind, value: t.value },
                    });
                });
                return el;
            }),
        );
    };

    api.onState((s: HostState) => {
        renderRecents(s.recents);
        ver.textContent = `deskapp ${s.version.deskapp} · electron ${s.version.electron} · chromium ${s.version.chrome}`;
    });

    api.ready();
}
