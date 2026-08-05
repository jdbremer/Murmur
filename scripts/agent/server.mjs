#!/usr/bin/env node
/**
 * Murmur agent control server (WINDOWS-HANDOFF).
 *
 * Long-lived process that owns a Playwright-driven Electron session so an AI
 * (or curl) can start the app, screenshot, click, inject mic PCM, and read
 * machine-readable state — without a human at the keyboard.
 *
 *   node scripts/agent/server.mjs          # listens on 127.0.0.1:17321
 *   curl -H "x-murmur-agent-token: $(jq -r .token .agent/server.json)" \
 *        http://127.0.0.1:17321/health
 *
 * State + screenshots land in .agent/ (gitignored).
 *
 * ## Why this is authenticated
 *
 * Binding to loopback keeps other machines out; it does **not** keep the
 * developer's own browser out. Every route here is high-authority —
 * `/evaluate` runs arbitrary JS in a renderer holding the full `window.murmur`
 * IPC surface, and `/desktop/type` injects real keystrokes into whatever window
 * has focus. Without a token, any web page open in any browser could POST here
 * with `content-type: text/plain` (no CORS preflight, so the request is sent
 * and the side effect lands even though the reply is unreadable).
 *
 * So: a per-run token in `.agent/server.json` (gitignored, mode 0600) is
 * required on every request, and requests carrying a browser `Origin` or
 * `Referer` are refused outright. `cli.mjs` reads the file.
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import {
  captureScreen,
  clickAt,
  typeText,
  pressKeys,
  focusWindow,
  virtualScreenBounds,
  osBackend,
} from './os-control.mjs'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..', '..')
const DESKTOP = join(REPO, 'apps', 'desktop')
const AGENT_DIR = join(REPO, '.agent')
const SHOT_DIR = join(AGENT_DIR, 'screenshots')
const PORT = Number(process.env.MURMUR_AGENT_PORT || 17321)
const HOST = '127.0.0.1'
const CDP_PORT = Number(process.env.MURMUR_CDP_PORT || 9222)

mkdirSync(SHOT_DIR, { recursive: true })

const TOKEN = process.env.MURMUR_AGENT_TOKEN || randomBytes(24).toString('hex')
const META_PATH = join(AGENT_DIR, 'server.json')

/** Constant-time compare that tolerates length mismatch without throwing. */
function tokenMatches(candidate) {
  if (typeof candidate !== 'string') return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(TOKEN)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Reject anything that smells like a browser fetch. A real CLI/agent client
 * never sends Origin or Referer; a page doing drive-by CSRF always does.
 */
function authorize(req) {
  if (req.headers.origin || req.headers.referer) return 'browser-origin'
  const host = String(req.headers.host || '')
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return 'bad-host'
  const header = req.headers['x-murmur-agent-token']
  const supplied = Array.isArray(header) ? header[0] : header
  return tokenMatches(supplied) ? null : 'bad-token'
}

/** @type {import('playwright').ElectronApplication | null} */
let electronApp = null
/** @type {import('playwright').Page | null} */
let hubPage = null
let starting = false
let lastError = null

function log(...args) {
  console.log('[murmur-agent]', ...args)
}

function json(res, status, body) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}

function electronExecutable() {
  const electron = require(join(REPO, 'node_modules', 'electron'))
  // electron package exports the path string when required from Node.
  return typeof electron === 'string' ? electron : electron
}

async function ensureBuilt() {
  const mainJs = join(DESKTOP, 'out', 'main', 'index.js')
  if (existsSync(mainJs) && process.env.MURMUR_AGENT_SKIP_BUILD === '1') {
    log('skip build (MURMUR_AGENT_SKIP_BUILD=1)')
    return
  }
  log('building desktop (electron-vite build)…')
  await run('npm', ['run', 'build', '--workspace', '@murmur/desktop'], REPO)
  if (!existsSync(mainJs)) {
    throw new Error(`build finished but ${mainJs} is missing`)
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: 'inherit',
      env: process.env,
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
  })
}

async function findHubPage(app) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    for (const page of app.windows()) {
      try {
        const url = page.url()
        // Hub is the large window; URL contains /hub/ in dev and prod builds.
        if (url.includes('hub') || (await page.title()) === 'Murmur') {
          // Prefer the one that has the sidebar / Help text once loaded.
          const hasSidebar = await page
            .locator('text=Help')
            .first()
            .isVisible()
            .catch(() => false)
          if (hasSidebar || url.includes('hub')) return page
        }
      } catch {
        /* window may be mid-navigation */
      }
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  const pages = app.windows()
  if (pages.length === 0) throw new Error('Electron started but no windows appeared')
  // Fall back to the first non-empty page.
  return pages[0]
}

async function startApp() {
  if (electronApp) return { ok: true, already: true }
  if (starting) throw new Error('start already in progress')
  starting = true
  lastError = null
  try {
    await ensureBuilt()

    // Playwright's Electron support lives on the private export.
    const { _electron } = require(join(REPO, 'node_modules', 'playwright'))
    const executablePath = electronExecutable()
    log('launching', executablePath)

    electronApp = await _electron.launch({
      executablePath,
      // remote-debugging-port enables CDP attach if needed later.
      args: ['.', `--remote-debugging-port=${CDP_PORT}`],
      cwd: DESKTOP,
      env: {
        ...process.env,
        MURMUR_AGENT: '1',
        // Ensure Chromium accepts media without a human prompt.
        ELECTRON_EXTRA_LAUNCH_ARGS: [
          process.env.ELECTRON_EXTRA_LAUNCH_ARGS,
          '--autoplay-policy=no-user-gesture-required',
        ]
          .filter(Boolean)
          .join(' '),
      },
      timeout: 90_000,
    })

    electronApp.on('close', () => {
      log('electron closed')
      electronApp = null
      hubPage = null
    })

    hubPage = await findHubPage(electronApp)
    await hubPage.waitForLoadState('domcontentloaded').catch(() => undefined)
    // Give React a beat to paint.
    await hubPage.waitForTimeout(500)

    writeFileSync(
      join(AGENT_DIR, 'session.json'),
      JSON.stringify(
        {
          startedAt: new Date().toISOString(),
          pid: electronApp.process().pid,
          hubUrl: hubPage.url(),
        },
        null,
        2,
      ),
    )

    log('ready — hub at', hubPage.url())
    return {
      ok: true,
      hubUrl: hubPage.url(),
      pid: electronApp.process().pid,
      cdpPort: CDP_PORT,
      os: osBackend(),
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
    electronApp = null
    hubPage = null
    throw error
  } finally {
    starting = false
  }
}

async function stopApp() {
  if (!electronApp) return { ok: true, already: true }
  const app = electronApp
  electronApp = null
  hubPage = null
  await app.close().catch(() => undefined)
  if (existsSync(join(AGENT_DIR, 'session.json'))) {
    rmSync(join(AGENT_DIR, 'session.json'), { force: true })
  }
  return { ok: true }
}

async function ensureHub() {
  if (!electronApp) throw new Error('app not running — POST /start first')
  if (!hubPage || hubPage.isClosed()) {
    hubPage = await findHubPage(electronApp)
  }
  return hubPage
}

async function screenshot(name = 'shot') {
  const page = await ensureHub()
  const safe = String(name).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'shot'
  const path = join(SHOT_DIR, `${safe}.png`)
  await page.screenshot({ path, fullPage: true })
  // Also dump every window for Bar debugging.
  const extra = []
  if (electronApp) {
    let i = 0
    for (const w of electronApp.windows()) {
      try {
        const p = join(SHOT_DIR, `${safe}-win${i}.png`)
        await w.screenshot({ path: p })
        extra.push(p)
      } catch {
        /* ignore closed */
      }
      i += 1
    }
  }
  return { ok: true, path, extra }
}

async function click(selector, options = {}) {
  const page = await ensureHub()
  const locator = page.locator(selector).first()
  await locator.waitFor({ state: 'visible', timeout: options.timeoutMs ?? 10_000 })
  await locator.click({ timeout: options.timeoutMs ?? 10_000 })
  return { ok: true, selector }
}

async function clickText(text, options = {}) {
  const page = await ensureHub()
  const locator = page.getByText(text, { exact: options.exact ?? false }).first()
  await locator.waitFor({ state: 'visible', timeout: options.timeoutMs ?? 10_000 })
  await locator.click({ timeout: options.timeoutMs ?? 10_000 })
  return { ok: true, text }
}

async function evaluate(expression) {
  const page = await ensureHub()
  // expression is the body of an async function that receives window.
  const result = await page.evaluate(async (expr) => {
    const fn = new Function(`return (async () => { ${expr} })()`)
    return await fn()
  }, expression)
  return { ok: true, result }
}

async function murmur(methodPath, args = []) {
  const page = await ensureHub()
  const result = await page.evaluate(
    async ({ methodPath, args }) => {
      const parts = methodPath.split('.')
      let cur = globalThis.murmur
      for (const part of parts) {
        if (cur == null) throw new Error(`missing window.murmur.${methodPath}`)
        cur = cur[part]
      }
      if (typeof cur !== 'function') throw new Error(`not a function: murmur.${methodPath}`)
      return await cur(...args)
    },
    { methodPath, args },
  )
  return { ok: true, result }
}

async function hotkey(action) {
  return murmur('debug.simulateHotkey', [{ action }])
}

async function injectPcm(body = {}) {
  return murmur('debug.injectPcm', [body])
}

async function snapshot() {
  return murmur('debug.snapshot', [])
}

/**
 * Decode a mono/stereo 16-bit PCM WAV to Float32 samples at its native rate.
 * whisper-cpp jfk.wav is 16 kHz mono — matches Murmur capture.
 */
function wavToFloat32(filePath) {
  const buf = readFileSync(filePath)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a WAV file: ${filePath}`)
  }
  let offset = 12
  let channels = 1
  let sampleRate = 16_000
  let bitsPerSample = 16
  let dataOffset = -1
  let dataSize = 0
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(start + 2)
      sampleRate = buf.readUInt32LE(start + 4)
      bitsPerSample = buf.readUInt16LE(start + 14)
    } else if (id === 'data') {
      dataOffset = start
      dataSize = size
      break
    }
    offset = start + size + (size % 2)
  }
  if (dataOffset < 0) throw new Error(`no data chunk in ${filePath}`)
  if (bitsPerSample !== 16) throw new Error(`only 16-bit WAV supported (${bitsPerSample})`)
  const frameCount = Math.floor(dataSize / (2 * channels))
  const samples = new Array(frameCount)
  for (let i = 0; i < frameCount; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      sum += buf.readInt16LE(dataOffset + (i * channels + c) * 2)
    }
    samples[i] = sum / channels / 32768
  }
  return { samples, sampleRate, channels }
}

async function utterance(body = {}) {
  const holdMs = body.holdMs ?? 1200
  const pcmMs = body.pcmMs ?? 900
  await hotkey('down')

  // Prefer a real speech WAV when provided (G7: recognizable STT text).
  // Default: whisper.cpp jfk.wav if present under %TEMP% or .agent/samples/.
  const speechPath =
    body.speechWav ||
    process.env.MURMUR_AGENT_SPEECH_WAV ||
    (existsSync(join(AGENT_DIR, 'samples', 'jfk.wav'))
      ? join(AGENT_DIR, 'samples', 'jfk.wav')
      : existsSync(join(process.env.TEMP || '/tmp', 'jfk.wav'))
        ? join(process.env.TEMP || '/tmp', 'jfk.wav')
        : null)

  if (speechPath && body.useSine !== true) {
    const { samples, sampleRate } = wavToFloat32(speechPath)
    log(
      `utterance: injecting speech WAV ${speechPath} (${samples.length} samples @ ${sampleRate} Hz)`,
    )
    // Cap IPC size: first ~12 s is enough for JFK.
    const capped = samples.length > 16_000 * 12 ? samples.slice(0, 16_000 * 12) : samples
    await injectPcm({ samples: capped, durationMs: Math.round((capped.length / 16_000) * 1000) })
  } else {
    await injectPcm({
      durationMs: pcmMs,
      amplitude: body.amplitude ?? 0.4,
      frequencyHz: body.frequencyHz ?? 220,
    })
  }
  // Leave a little tail after PCM before release.
  await new Promise((r) => setTimeout(r, 100))
  await hotkey('up')
  // Wait for pipeline to settle a bit (STT on CPU can take several seconds).
  await new Promise((r) => setTimeout(r, holdMs))
  const snap = await snapshot()
  return { ok: true, holdMs, pcmMs, speechPath: speechPath || null, snapshot: snap.result }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
  const path = url.pathname
  const denied = authorize(req)
  if (denied) {
    return json(res, 403, {
      ok: false,
      error: denied,
      detail: 'Send the token from .agent/server.json as x-murmur-agent-token.',
    })
  }
  try {
    if (req.method === 'GET' && path === '/health') {
      return json(res, 200, {
        ok: true,
        running: Boolean(electronApp),
        starting,
        lastError,
        agentDir: AGENT_DIR,
        cdpPort: CDP_PORT,
        os: osBackend(),
        virtualScreen: (() => {
          try {
            return virtualScreenBounds()
          } catch {
            return null
          }
        })(),
      })
    }
    if (req.method === 'GET' && path === '/snapshot') {
      const snap = await snapshot()
      return json(res, 200, snap)
    }
    if (req.method === 'POST' && path === '/start') {
      const result = await startApp()
      return json(res, 200, result)
    }
    if (req.method === 'POST' && path === '/stop') {
      return json(res, 200, await stopApp())
    }
    if (req.method === 'POST' && path === '/screenshot') {
      const body = await readBody(req)
      return json(res, 200, await screenshot(body.name || url.searchParams.get('name') || 'shot'))
    }
    if (req.method === 'POST' && path === '/click') {
      const body = await readBody(req)
      if (!body.selector) throw new Error('body.selector required')
      return json(res, 200, await click(body.selector, body))
    }
    if (req.method === 'POST' && path === '/click-text') {
      const body = await readBody(req)
      if (!body.text) throw new Error('body.text required')
      return json(res, 200, await clickText(body.text, body))
    }
    if (req.method === 'POST' && path === '/hotkey') {
      const body = await readBody(req)
      if (!body.action) throw new Error('body.action = down|up|doubleTap')
      return json(res, 200, await hotkey(body.action))
    }
    if (req.method === 'POST' && path === '/inject-pcm') {
      const body = await readBody(req)
      return json(res, 200, await injectPcm(body))
    }
    if (req.method === 'POST' && path === '/utterance') {
      const body = await readBody(req)
      return json(res, 200, await utterance(body))
    }
    if (req.method === 'POST' && path === '/murmur') {
      const body = await readBody(req)
      if (!body.method) throw new Error('body.method e.g. "debug.snapshot"')
      return json(res, 200, await murmur(body.method, body.args || []))
    }
    if (req.method === 'POST' && path === '/evaluate') {
      const body = await readBody(req)
      if (!body.expression) throw new Error('body.expression required')
      return json(res, 200, await evaluate(body.expression))
    }

    // --- OS-level computer use (nut.js / Win32) ----------------------------
    if (req.method === 'POST' && (path === '/desktop/screenshot' || path === '/take_screenshot')) {
      const body = await readBody(req)
      const name = String(body.name || 'desktop').replace(/[^a-zA-Z0-9._-]+/g, '_')
      const file = join(SHOT_DIR, `${name}.png`)
      const result = await captureScreen(file)
      return json(res, 200, { ok: true, ...result })
    }
    if (req.method === 'POST' && (path === '/desktop/click' || path === '/click_xy')) {
      const body = await readBody(req)
      if (body.focus) await focusWindow(body.focus).catch(() => undefined)
      return json(res, 200, await clickAt(body.x, body.y, body.button || 'left'))
    }
    if (req.method === 'POST' && (path === '/desktop/type' || path === '/type_text')) {
      const body = await readBody(req)
      if (body.focus) await focusWindow(body.focus).catch(() => undefined)
      return json(res, 200, await typeText(body.text ?? ''))
    }
    if (req.method === 'POST' && (path === '/desktop/keys' || path === '/press_keys')) {
      const body = await readBody(req)
      if (body.focus) await focusWindow(body.focus).catch(() => undefined)
      const input = body.chord || body.keys || body
      return json(res, 200, await pressKeys(input))
    }
    if (req.method === 'POST' && path === '/desktop/focus') {
      const body = await readBody(req)
      return json(res, 200, await focusWindow(body.title || 'Murmur'))
    }
    // Alias for the recommended agent tool name.
    if (req.method === 'POST' && path === '/play_audio_to_mic') {
      const body = await readBody(req)
      // Internal path: inject into orchestrator (no VB-Cable required).
      // Real OS path would need VB-Audio + ffmpeg; document when installed.
      return json(res, 200, {
        ...(await injectPcm(body)),
        mode: 'internal-injectPcm',
        note: 'Uses debug.injectPcm into the orchestrator. For real getUserMedia, install VB-Audio Cable and set MURMUR_AGENT_FAKE_AUDIO or play into CABLE Input.',
      })
    }

    json(res, 404, {
      ok: false,
      error: 'not found',
      routes: [
        'GET /health',
        'GET /snapshot',
        'POST /start',
        'POST /stop',
        'POST /screenshot',
        'POST /click',
        'POST /click-text',
        'POST /hotkey',
        'POST /inject-pcm',
        'POST /play_audio_to_mic',
        'POST /utterance',
        'POST /murmur',
        'POST /evaluate',
        'POST /desktop/screenshot | /take_screenshot',
        'POST /desktop/click | /click_xy  {x,y,button?,focus?}',
        'POST /desktop/type | /type_text  {text,focus?}',
        'POST /desktop/keys | /press_keys {chord|keys,focus?}',
        'POST /desktop/focus {title?}',
      ],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('error', message)
    json(res, 500, { ok: false, error: message })
  }
})

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`)
  writeFileSync(
    META_PATH,
    JSON.stringify(
      {
        host: HOST,
        port: PORT,
        pid: process.pid,
        token: TOKEN,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    // Owner-only: this file is the credential for every route above.
    { mode: 0o600 },
  )
  log(`token written to ${META_PATH}`)
})

async function shutdown() {
  log('shutting down')
  await stopApp().catch(() => undefined)
  server.close()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
