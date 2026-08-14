import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const r = (p: string) => resolve(__dirname, p);

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()],
        build: {
            outDir: 'build/main',
            minify: false,
            sourcemap: 'inline',
            rollupOptions: { input: { index: r('src/main/index.ts') } },
        },
    },
    preload: {
        plugins: [externalizeDepsPlugin()],
        build: {
            outDir: 'build/preload',
            minify: false,
            sourcemap: 'inline',
            rollupOptions: {
                input: {
                    index: r('src/preload/index.ts'),
                    shell: r('src/preload/shell.ts'),
                },
                output: { format: 'cjs', entryFileNames: '[name].js' },
            },
        },
    },
    renderer: {
        root: r('src/shell'),
        build: {
            outDir: r('build/shell'),
            emptyOutDir: true,
            rollupOptions: { input: { index: r('src/shell/index.html') } },
        },
    },
});
