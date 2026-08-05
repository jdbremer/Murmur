import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/** The three renderer entry points declared in electron.vite.config.ts. */
export type RendererName = 'hub' | 'bar' | 'audio'

/** Absolute path to the compiled preload bundle (CJS, sandbox-compatible). */
export const PRELOAD_PATH = join(__dirname, '../preload/index.js')

/**
 * In `electron-vite dev` the renderers are served by Vite and the dev server
 * URL arrives in `ELECTRON_RENDERER_URL`; in a built app they are static files
 * under `out/renderer/<name>/`.
 */
export function loadRenderer(window: BrowserWindow, name: RendererName): Promise<void> {
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    return window.loadURL(`${devServerUrl}/${name}/index.html`)
  }
  return window.loadFile(join(__dirname, `../renderer/${name}/index.html`))
}
