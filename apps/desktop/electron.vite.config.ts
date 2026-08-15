import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const rendererRoot = resolve(__dirname, 'src/renderer')

/**
 * Six build targets: `main`, `preload` and four renderer pages (PLAN §3).
 *
 * Dependency handling worth knowing about before you add one:
 *
 *  - `@murmur/shared` is consumed as TypeScript *source* (its package `exports`
 *    point at `src/index.ts`), so it must be **bundled**, not externalised.
 *  - `@murmur/native` is a real native addon and an *optional* dependency, so it
 *    must stay **external** and be `require`d at runtime. electron-vite only
 *    externalises `dependencies` by default, hence the explicit `include`.
 */
export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        // Native addons and the optional ONNX Runtime must stay external and be
        // `require`d at runtime, so a missing one is a status rather than a
        // bundling failure. electron-vite only externalises `dependencies` by
        // default, hence the explicit `include`.
        include: ['@murmur/native', 'onnxruntime-node', 'better-sqlite3'],
        exclude: ['@murmur/shared'],
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // The STT utility process (PLAN §3.1). Built alongside the main
          // bundle so `utilityProcess.fork` can point at `out/main/onnx-host.js`.
          'onnx-host': resolve(__dirname, 'src/main/engines/stt/onnx/host.ts'),
        },
        output: { entryFileNames: '[name].js' },
      },
    },
  },

  preload: {
    build: {
      externalizeDeps: { exclude: ['@murmur/shared'] },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },

  renderer: {
    root: rendererRoot,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': rendererRoot },
    },
    build: {
      /**
       * The capture worklet must stay a real file.
       *
       * Vite inlines small assets as `data:` URLs, and
       * `audioWorklet.addModule()` fetches its module under the page's CSP —
       * where `script-src 'self'` (see `main/security.ts`) rejects `data:`
       * outright. Inlining it would therefore break the microphone in
       * production only, which is the worst possible place to find out.
       */
      assetsInlineLimit: (filePath: string) =>
        filePath.endsWith('capture-processor.js') ? false : undefined,
      rollupOptions: {
        input: {
          hub: resolve(rendererRoot, 'hub/index.html'),
          bar: resolve(rendererRoot, 'bar/index.html'),
          audio: resolve(rendererRoot, 'audio/index.html'),
          notes: resolve(rendererRoot, 'notes/index.html'),
        },
      },
    },
  },
})
