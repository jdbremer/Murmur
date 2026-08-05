import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const rendererRoot = resolve(__dirname, 'src/renderer')

/**
 * Five build targets: `main`, `preload` and three renderer pages (PLAN §3).
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
      externalizeDeps: { include: ['@murmur/native'], exclude: ['@murmur/shared'] },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
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
      rollupOptions: {
        input: {
          hub: resolve(rendererRoot, 'hub/index.html'),
          bar: resolve(rendererRoot, 'bar/index.html'),
          audio: resolve(rendererRoot, 'audio/index.html'),
        },
      },
    },
  },
})
