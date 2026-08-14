/**
 * 帧时间条形图。
 * 颜色按帧预算分档：绿 = 达标，黄 = 1~1.5 倍预算，红 = 掉帧。
 * 每根条是一帧，看的是尖峰分布，不是平均值 —— 平均值会把卡顿抹平。
 */

const CAPACITY = 240;

export class FrameGraph {
    private buf: number[] = [];
    private ctx: CanvasRenderingContext2D | null;

    constructor(private canvas: HTMLCanvasElement) {
        this.ctx = canvas.getContext('2d');
    }

    push(values: number[]): void {
        for (const v of values) this.buf.push(v);
        if (this.buf.length > CAPACITY) this.buf.splice(0, this.buf.length - CAPACITY);
    }

    clear(): void {
        this.buf = [];
    }

    draw(budgetMs: number): void {
        const ctx = this.ctx;
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        const cssW = this.canvas.clientWidth;
        const cssH = this.canvas.clientHeight;
        if (cssW === 0 || cssH === 0) return;
        const w = Math.round(cssW * dpr);
        const h = Math.round(cssH * dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }

        ctx.clearRect(0, 0, w, h);

        let peak = budgetMs * 2;
        for (const v of this.buf) if (v > peak) peak = v;
        const scale = h / peak;

        // 预算基准线
        const budgetY = h - budgetMs * scale;
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, budgetY + 0.5);
        ctx.lineTo(w, budgetY + 0.5);
        ctx.stroke();

        const barW = w / CAPACITY;
        const start = CAPACITY - this.buf.length;
        for (let i = 0; i < this.buf.length; i++) {
            const v = this.buf[i];
            const bh = Math.max(1, v * scale);
            ctx.fillStyle =
                v > budgetMs * 1.5 ? '#ff5c5c' : v > budgetMs * 1.05 ? '#ffb84c' : '#3ddc84';
            ctx.fillRect((start + i) * barW, h - bh, Math.max(1, barW - dpr * 0.5), bh);
        }

        // 右上角标注量程
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.font = `${10 * dpr}px ui-monospace, monospace`;
        ctx.textAlign = 'right';
        ctx.fillText(`${peak.toFixed(0)}ms`, w - 4 * dpr, 11 * dpr);
    }
}
