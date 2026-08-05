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
  })
}
