/**
 * Deskapp 压测台。
 *
 * 存在的理由：显存记账如果算错，整个宿主的核心价值就是零。
 * 所以这里**自己算一份期望值**——用和探针完全相同的口径——再和探针实测值逐字节对比。
 * 期望值不是硬编码的常数，而是随每次分配同步累加的，改了分配方案不用改断言。
 *
 * 顺带施加可控渲染压力：draw call 数、纹理组数、人为长帧都能手动调，
 * 用来验证帧统计、长帧计数、告警线是否真的会触发。
 */

const canvas = document.getElementById('gl');
const gl = canvas.getContext('webgl', {
    antialias: false,
    alpha: false,
    depth: true,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
});

if (!gl) {
    document.getElementById('verdict').className = 'verdict fail';
    document.getElementById('verdict').textContent = '拿不到 WebGL 上下文';
    throw new Error('no webgl');
}

const host = /** @type {any} */ (window).deskapp ?? null;

/* ==================== 记账口径（必须与 probe 一致） ==================== */

/** RGBA / UNSIGNED_BYTE = 4 字节每像素 */
const RGBA_BPP = 4;
/** DEPTH_COMPONENT16 = 2 字节每像素 */
const DEPTH16_BPP = 2;

/**
 * generateMipmap 在 level 0 之外追加的精确字节数。
 * 这里是**独立实现**——不引用探针的代码，两边算出同一个数才算真的对。
 */
function mipChainExtra(w, h, bpp) {
    if (w === 1 && h === 1) return 0;
    let extra = 0;
    for (let i = 1; ; i++) {
        const ww = Math.max(1, w >> i);
        const hh = Math.max(1, h >> i);
        extra += bpp * ww * hh;
        if (ww === 1 && hh === 1) break;
    }
    return extra;
}

/* ==================== 分配管理 ==================== */

/** 期望的显存字节数，随每次分配/释放同步维护 */
let expectedBytes = 0;
/** 期望的存活纹理对象数 */
let expectedTextures = 0;
/** 期望的存活 buffer 对象数 */
let expectedBuffers = 0;
/** 期望的存活 renderbuffer 对象数 */
let expectedRenderbuffers = 0;

/** 可释放的分配组 */
const groups = [];

function allocTextureGroup({ count, size, mipmap }) {
    const group = { kind: mipmap ? 'mip' : 'plain', textures: [], bytes: 0, label: '' };
    for (let i = 0; i < count; i++) {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        const level0 = size * size * RGBA_BPP;
        let bytes = level0;
        if (mipmap) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            gl.generateMipmap(gl.TEXTURE_2D);
            bytes += mipChainExtra(size, size, RGBA_BPP);
        } else {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        group.textures.push(tex);
        group.bytes += bytes;
        expectedTextures++;
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    expectedBytes += group.bytes;
    group.label = `${count}×${size}² RGBA${mipmap ? ' +mip' : ''}`;
    groups.push(group);
    return group;
}

function freeLastGroup() {
    const group = groups.pop();
    if (!group) return;
    for (const tex of group.textures) {
        gl.deleteTexture(tex);
        expectedTextures--;
    }
    expectedBytes -= group.bytes;
}

/* ---- 固定基线：一个 renderbuffer + 一块大 buffer ---- */

const depthRb = gl.createRenderbuffer();
gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, 1024, 1024);
gl.bindRenderbuffer(gl.RENDERBUFFER, null);
expectedBytes += 1024 * 1024 * DEPTH16_BPP;
expectedRenderbuffers++;

const BIG_BUFFER_BYTES = 4 * 1024 * 1024;
const bigBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, bigBuffer);
gl.bufferData(gl.ARRAY_BUFFER, BIG_BUFFER_BYTES, gl.STATIC_DRAW);
expectedBytes += BIG_BUFFER_BYTES;
expectedBuffers++;

/* ==================== 渲染资源 ==================== */

const VS = `
attribute vec2 a_pos;
uniform vec2 u_offset;
uniform vec2 u_scale;
void main() { gl_Position = vec4(a_pos * u_scale + u_offset, 0.0, 1.0); }`;

const FS = `
precision mediump float;
uniform vec3 u_color;
void main() { gl_FragColor = vec4(u_color, 1.0); }`;

function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    }
    return s;
}

const program = gl.createProgram();
gl.attachShader(program, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(program);
if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(program)}`);
}
gl.useProgram(program);

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
const quadBuffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
expectedBytes += QUAD.byteLength;
expectedBuffers++;

const aPos = gl.getAttribLocation(program, 'a_pos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

const uOffset = gl.getUniformLocation(program, 'u_offset');
const uScale = gl.getUniformLocation(program, 'u_scale');
const uColor = gl.getUniformLocation(program, 'u_color');

/* 首批纹理：16 × 512² RGBA = 16MB 整 */
allocTextureGroup({ count: 16, size: 512, mipmap: false });
/* 第二批带完整 mip 链 —— 让无人值守的 smoke 也覆盖 generateMipmap 记账路径 */
allocTextureGroup({ count: 8, size: 256, mipmap: true });

/* ==================== 交互 ==================== */

let drawCalls = 200;
let injectLongFrame = false;

window.addEventListener('keydown', (e) => {
    switch (e.key.toLowerCase()) {
        case 'a':
            allocTextureGroup({ count: 16, size: 512, mipmap: false });
            verify();
            break;
        case 'm':
            allocTextureGroup({ count: 8, size: 256, mipmap: true });
            verify();
            break;
        case 'd':
            freeLastGroup();
            verify();
            break;
        case 'v':
            verify();
            break;
        case 'l':
            injectLongFrame = true;
            break;
        case 'arrowup':
            drawCalls = Math.min(20000, drawCalls + (e.shiftKey ? 1000 : 100));
            break;
        case 'arrowdown':
            drawCalls = Math.max(1, drawCalls - (e.shiftKey ? 1000 : 100));
            break;
        default:
            return;
    }
    e.preventDefault();
});

/* ==================== 校验 ==================== */

const verdictEl = document.getElementById('verdict');
const statsEl = document.getElementById('stats');
let lastVerify = null;

function verify() {
    if (!host || typeof host.peek !== 'function') {
        lastVerify = { available: false };
        return;
    }
    const { vram, counts } = host.peek();
    const deltaBytes = vram.total - expectedBytes;
    const texOk = counts.textures === expectedTextures;
    const bufOk = counts.buffers === expectedBuffers;
    const rbOk = counts.renderbuffers === expectedRenderbuffers;
    const ok = deltaBytes === 0 && texOk && bufOk && rbOk;

    lastVerify = {
        available: true,
        ok,
        expectedBytes,
        actualBytes: vram.total,
        deltaBytes,
        counts,
        texOk,
        bufOk,
        rbOk,
    };

    host.report({
        vramAccountingOk: ok ? 1 : 0,
        // 用来验证 --coi 是不是真的生效（能加载 ≠ 跨源隔离成立）
        crossOriginIsolated: self.crossOriginIsolated ? 1 : 0,
        hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' ? 1 : 0,
        vramExpectedMB: expectedBytes / 1048576,
        vramActualMB: vram.total / 1048576,
        vramDeltaBytes: deltaBytes,
        allocGroups: groups.length,
        drawCallsRequested: drawCalls,
    });

    if (!ok) {
        host.log(
            'error',
            `显存记账不一致：期望 ${expectedBytes}B，实测 ${vram.total}B，差 ${deltaBytes}B；` +
                `对象数 纹理 ${counts.textures}/${expectedTextures} ` +
                `buffer ${counts.buffers}/${expectedBuffers} ` +
                `renderbuffer ${counts.renderbuffers}/${expectedRenderbuffers}`,
        );
    }
}

/* ==================== HUD ==================== */

const MB = 1048576;
let fps = 0;
let fpsFrames = 0;
let fpsSince = performance.now();

function row(k, v, bad) {
    return `<tr><td class="k">${k}</td><td class="v${bad ? ' bad' : ''}">${v}</td></tr>`;
}

function updateHud() {
    if (!lastVerify) {
        verdictEl.className = 'verdict wait';
        verdictEl.textContent = '等待首次校验…';
    } else if (!lastVerify.available) {
        verdictEl.className = 'verdict wait';
        verdictEl.textContent = '未在 Deskapp 中运行 —— 无法校验记账';
    } else if (lastVerify.ok) {
        verdictEl.className = 'verdict pass';
        verdictEl.textContent = '✓ 显存记账逐字节一致';
    } else {
        verdictEl.className = 'verdict fail';
        verdictEl.textContent = `✗ 记账偏差 ${lastVerify.deltaBytes} 字节`;
    }

    const v = lastVerify?.available ? lastVerify : null;
    statsEl.innerHTML =
        row('帧率', `${fps.toFixed(1)} fps`) +
        row('draw call / 帧', String(drawCalls)) +
        row('分组数', String(groups.length)) +
        '<tr class="sep"><td class="k">期望记账</td>' +
        `<td class="v">${(expectedBytes / MB).toFixed(3)} MB</td></tr>` +
        (v
            ? row('探针记账', `${(v.actualBytes / MB).toFixed(3)} MB`, v.deltaBytes !== 0) +
              row('差值', `${v.deltaBytes} B`, v.deltaBytes !== 0) +
              row(
                  '纹理对象',
                  `${v.counts.textures} / ${expectedTextures}`,
                  !v.texOk,
              ) +
              row('buffer 对象', `${v.counts.buffers} / ${expectedBuffers}`, !v.bufOk) +
              row(
                  'renderbuffer 对象',
                  `${v.counts.renderbuffers} / ${expectedRenderbuffers}`,
                  !v.rbOk,
              )
            : '');
}

/* ==================== 帧循环 ==================== */

function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
    }
}

function frame(now) {
    requestAnimationFrame(frame);

    if (injectLongFrame) {
        injectLongFrame = false;
        const until = performance.now() + 300;
        while (performance.now() < until) {
            /* 故意堵住主线程，验证长帧统计 */
        }
    }

    resize();
    gl.clearColor(0.04, 0.05, 0.07, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const t = now * 0.001;
    // 网格铺满屏幕：列数随 draw call 数变化，视觉上直接反映压力
    const cols = Math.max(1, Math.ceil(Math.sqrt(drawCalls)));
    const cell = 2 / cols;
    const half = cell * 0.42;
    const allTex = groups.flatMap((g) => g.textures);

    for (let i = 0; i < drawCalls; i++) {
        const cx = i % cols;
        const cy = Math.floor(i / cols);
        const x = -1 + cell * (cx + 0.5);
        const y = 1 - cell * (cy + 0.5);
        const phase = t * 1.6 + i * 0.11;
        gl.uniform2f(uOffset, x, y);
        gl.uniform2f(uScale, half, half * (0.55 + 0.45 * Math.sin(phase)));
        gl.uniform3f(
            uColor,
            0.28 + 0.28 * Math.sin(phase),
            0.55 + 0.35 * Math.sin(phase + 2.1),
            0.75 + 0.25 * Math.sin(phase + 4.2),
        );
        // 每次绘制换一张纹理绑定：让探针的影子绑定状态被真实使用
        if (allTex.length > 0) gl.bindTexture(gl.TEXTURE_2D, allTex[i % allTex.length]);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    fpsFrames++;
    if (now - fpsSince >= 500) {
        fps = (fpsFrames * 1000) / (now - fpsSince);
        fpsFrames = 0;
        fpsSince = now;
        updateHud();
    }
}

requestAnimationFrame(frame);

// 首次校验放到下一帧之后：确保所有分配都已经过探针
setTimeout(() => {
    verify();
    updateHud();
    host?.mark('stress-ready');
}, 300);

// 每 2s 复查一次，抓运行期的记账漂移
setInterval(() => {
    verify();
    updateHud();
}, 2000);
