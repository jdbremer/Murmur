import { app, session } from 'electron'

/**
 * Baseline renderer hardening (PLAN §10).
 *
 * Murmur's whole pitch is that nothing leaves the machine, so the renderers get
 * a Content-Security-Policy that says exactly that, and navigation away from
 * the bundled pages is refused outright. The dev policy is looser only where
 * Vite's HMR needs it — the production policy is the one that ships.
 */

const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // Tailwind injects a stylesheet; React sets inline styles for animation.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  // No outbound network from a renderer, ever. Model downloads happen in main.
  "connect-src 'none'",
  "media-src 'self' mediastream:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ')

const DEVELOPMENT_CSP = [
  "default-src 'self'",
  // Vite's React Refresh preamble is an inline script and uses eval.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  // The HMR websocket and the dev server itself.
  "connect-src 'self' ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*",
  "media-src 'self' mediastream:",
  "object-src 'none'",
].join('; ')

/**
 * The only permission Murmur ever wants: the microphone, for the hidden capture
 * renderer (PLAN §5). Everything else — camera, geolocation, notifications,
 * MIDI, clipboard reads — is refused.
 *
 * Electron grants most permissions by default when no handler is installed,
 * which for an app whose entire claim is "nothing leaves this machine" is the
 * wrong default to inherit silently.
 */
function isPermittedMedia(permission: string, mediaTypes: readonly string[] | undefined): boolean {
  if (permission !== 'media') return false
  // An empty/absent list is a bare `media` check, which we allow — but a
  // request that names `video` is a camera request and is refused outright.
  if (!mediaTypes || mediaTypes.length === 0) return true
  return mediaTypes.every((type) => type === 'audio')
}

export function installSecurityPolicies(isDev: boolean): void {
  const policy = isDev ? DEVELOPMENT_CSP : PRODUCTION_CSP

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    // `details` is a union keyed by permission; only the media variant carries
    // `mediaTypes`, and narrowing it by hand buys nothing here.
    const { mediaTypes } = details as { mediaTypes?: string[] }
    const granted = isPermittedMedia(permission, mediaTypes)
    if (!granted) console.warn(`[security] denied permission request: ${permission}`)
    callback(granted)
  })

  // The synchronous half — `navigator.permissions.query`, and the check
  // Chromium runs before handing out device labels in `enumerateDevices`.
  session.defaultSession.setPermissionCheckHandler((_contents, permission, _origin, details) => {
    const mediaType = (details as { mediaType?: string }).mediaType
    return isPermittedMedia(permission, mediaType && mediaType !== 'unknown' ? [mediaType] : [])
  })

  // A renderer must never navigate off its own page — not to a remote origin,
  // not to another local file.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      const current = contents.getURL()
      if (url !== current) {
        event.preventDefault()
        console.warn(`[security] blocked navigation to ${url}`)
      }
    })
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })

    // Deny `window.open` by default for *every* web contents. The Hub replaces
    // this with a handler that opens vetted external links in the real browser
    // (see windows/hub.ts); the Bar and the capture page have no business
    // opening anything, and without a handler Electron would happily spawn an
    // unsandboxed BrowserWindow for them.
    contents.setWindowOpenHandler(({ url }) => {
      console.warn(`[security] blocked window.open to ${url}`)
      return { action: 'deny' }
    })
  })
}
