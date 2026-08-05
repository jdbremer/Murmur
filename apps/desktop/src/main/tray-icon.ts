import { nativeImage, type NativeImage } from 'electron'

/**
 * Placeholder menu-bar glyph (PLAN §2.3) — a 16 pt microphone, black-on-alpha
 * so macOS can treat it as a template image and invert it for dark menu bars.
 *
 * Inlined as data URLs rather than shipped as files so the main bundle has no
 * asset-path dependency. Stage 3 replaces this with the real mark, including
 * the subtle listening-state variant.
 */

const MIC_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVR42mNgGMzgPxqmSDPJhoxkA/4TEQv/' +
  'iTWALDWEnEqUV/4TwGQlKAa6p0T6AQDpIz3DUTUaLwAAAABJRU5ErkJggg=='

const MIC_32 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAUElEQVR42u3VWwoAIAhEUfe/aVtBhIr54A74' +
  'Ox0iSYQQe/QxewFqHAAAAACYD7gVWQ92g9oCvvW0AXgLwo+yHOBdv7R1LAOkX/EYAJ8R2ZkD8Or3CZD5guIA' +
  'AAAASUVORK5CYII='

/** A template-mode tray image with 1x and 2x representations. */
export function createTrayIcon(): NativeImage {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${MIC_16}`)
  icon.addRepresentation({
    scaleFactor: 2,
    dataURL: `data:image/png;base64,${MIC_32}`,
  })
  // Only macOS honours template images; harmless elsewhere.
  icon.setTemplateImage(true)
  return icon
}
