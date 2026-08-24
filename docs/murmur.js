/*
 * The hero's live pill.
 *
 * Not a video and not a screenshot: this is the app's own waveform maths
 * (apps/desktop/src/renderer/bar/level.ts) and its own timings, running on a
 * canvas. Murmur's most distinctive artifact is eight pixels tall, and showing
 * a still photograph of eight pixels would tell nobody anything — the whole
 * point of the pill is what it *does* when you speak to it.
 *
 * Every constant below is the real one. If the app's pill changes, this should
 * change with it.
 */

;(function () {
  'use strict'

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  // -- the app's constants, verbatim ---------------------------------------
  const WAVE = {
    samples: 56,
    width: 60,
    amplitude: 3.2,
    cycles: 1.6,
    periodMs: 2600,
    lineWidth: 1.6,
  }
  const CANVAS = { width: 120, height: 12 }
  const ATTACK_MS = 45
  const DECAY_MS = 260

  const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value)

  /**
   * The waveform, from `level.ts`.
   *
   * A single crest pinned to the centreline at both ends, plus a faster,
   * quieter one drifting at its own rate — which is what stops it reading as a
   * test pattern. At level 0 every offset is exactly 0, so silence is a
   * perfectly flat hairline rather than a wobble.
   */
  function waveOffsets(level, elapsedMs, samples) {
    const count = Math.max(2, Math.floor(samples))
    const eased = Math.pow(clamp01(level), 0.7) * WAVE.amplitude
    const phase = (elapsedMs / WAVE.periodMs) * Math.PI * 2
    const out = []
    for (let index = 0; index < count; index += 1) {
      const t = index / (count - 1)
      if (eased === 0) {
        out.push(0)
        continue
      }
      const envelope = Math.pow(Math.sin(Math.PI * t), 0.7)
      const primary = Math.sin(Math.PI * 2 * WAVE.cycles * t - phase)
      const secondary = Math.sin(Math.PI * 2 * WAVE.cycles * 1.9 * t - phase * 0.62)
      out.push(eased * envelope * (primary * 0.78 + secondary * 0.22))
    }
    return out
  }

  /**
   * The level envelope, from `level.ts`: fast to rise, slow to fall, and
   * frame-rate independent so it behaves the same at 60 Hz and 120 Hz.
   */
  function makeEnvelope() {
    let value = 0
    let target = 0
    return {
      push(next) {
        target = clamp01(next)
      },
      advance(dt) {
        const constant = target > value ? ATTACK_MS : DECAY_MS
        value += (target - value) * (1 - Math.exp(-dt / constant))
        return value
      },
    }
  }

  /**
   * A stand-in for a voice.
   *
   * Speech is not a sine wave — it is syllables with gaps, which is exactly
   * what makes the real pill look alive. Three detuned oscillators plus a
   * slower breath give a level that starts and stops the way talking does.
   */
  function syntheticLevel(elapsedMs) {
    const t = elapsedMs / 1000
    const syllables =
      Math.sin(t * 11.3) * 0.5 + Math.sin(t * 7.1 + 1.2) * 0.32 + Math.sin(t * 17.9 + 0.4) * 0.18
    const breath = 0.55 + 0.45 * Math.sin(t * 1.6 - 0.7)
    return clamp01(Math.max(0, syllables) * breath * 1.15)
  }

  // -- painting ------------------------------------------------------------

  function paintWave(ctx, level, elapsedMs) {
    const offsets = waveOffsets(level, elapsedMs, WAVE.samples)
    const left = (CANVAS.width - WAVE.width) / 2
    const middle = CANVAS.height / 2
    const step = WAVE.width / (offsets.length - 1)

    // Fades to nothing at both ends, so the line has no visible start or stop.
    const gradient = ctx.createLinearGradient(left, 0, left + WAVE.width, 0)
    gradient.addColorStop(0, 'rgba(255,255,255,0)')
    gradient.addColorStop(0.18, 'rgba(226,231,255,0.92)')
    gradient.addColorStop(0.5, 'rgba(255,255,255,1)')
    gradient.addColorStop(0.82, 'rgba(226,231,255,0.92)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')

    ctx.strokeStyle = gradient
    ctx.lineWidth = WAVE.lineWidth
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    for (let index = 0; index < offsets.length; index += 1) {
      const x = left + index * step
      const y = middle + offsets[index]
      if (index === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }

  function paintShimmer(ctx, elapsedMs) {
    const height = 2
    const width = 52
    const left = (CANVAS.width - width) / 2
    const top = (CANVAS.height - height) / 2
    const radius = height / 2

    const base = ctx.createLinearGradient(left, 0, left + width, 0)
    base.addColorStop(0, 'rgba(255,255,255,0)')
    base.addColorStop(0.12, 'rgba(255,255,255,0.20)')
    base.addColorStop(0.88, 'rgba(255,255,255,0.20)')
    base.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = base
    ctx.beginPath()
    ctx.roundRect(left, top, width, height, radius)
    ctx.fill()

    const position = (elapsedMs % 1200) / 1200
    const centre = left + position * width
    const highlight = ctx.createLinearGradient(centre - 16, 0, centre + 16, 0)
    highlight.addColorStop(0, 'rgba(255,255,255,0)')
    highlight.addColorStop(0.5, 'rgba(255,255,255,0.95)')
    highlight.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = highlight
    ctx.beginPath()
    ctx.roundRect(left, top, width, height, radius)
    ctx.fill()
  }

  function paintDots(ctx) {
    const count = 5
    const gap = 7
    const left = (CANVAS.width - (count - 1) * gap) / 2
    const middle = CANVAS.height / 2
    ctx.fillStyle = 'rgba(255,255,255,0.38)'
    for (let index = 0; index < count; index += 1) {
      ctx.beginPath()
      ctx.arc(left + index * gap, middle, 1.2, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  function paintCheck(ctx) {
    ctx.strokeStyle = '#86efac'
    ctx.lineWidth = 1.8
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const cx = CANVAS.width / 2
    const cy = CANVAS.height / 2
    ctx.beginPath()
    ctx.moveTo(cx - 3.4, cy)
    ctx.lineTo(cx - 1, cy + 2.4)
    ctx.lineTo(cx + 3.6, cy - 2.6)
    ctx.stroke()
  }

  // -- the loop ------------------------------------------------------------

  /** The sentence the demo "dictates", and where the pill is in its cycle. */
  const SENTENCE = 'Let us push the release to Thursday so the docs land with it.'

  const PHASES = [
    { state: 'idle', ms: 1500 },
    { state: 'listening', ms: 4200 },
    { state: 'processing', ms: 1100 },
    { state: 'inserted', ms: 1000 },
  ]
  const CYCLE_MS = PHASES.reduce((total, phase) => total + phase.ms, 0)

  function phaseAt(elapsed) {
    let cursor = elapsed % CYCLE_MS
    for (const phase of PHASES) {
      if (cursor < phase.ms) return { state: phase.state, into: cursor, of: phase.ms }
      cursor -= phase.ms
    }
    return { state: 'idle', into: 0, of: 1 }
  }

  function start() {
    const stage = document.querySelector('[data-pill-stage]')
    const pill = document.querySelector('[data-pill]')
    const canvas = document.querySelector('[data-pill-canvas]')
    const text = document.querySelector('[data-stage-text]')
    const caption = document.querySelector('[data-stage-caption]')
    if (!stage || !pill || !canvas || !text) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
    canvas.width = Math.round(CANVAS.width * ratio)
    canvas.height = Math.round(CANVAS.height * ratio)
    ctx.scale(ratio, ratio)

    // Reduce Motion gets the finished state, not a frozen mid-animation frame:
    // the point of the scene is "you spoke and the text is there".
    if (reducedMotion.matches) {
      stage.dataset.state = 'inserted'
      pill.dataset.state = 'inserted'
      text.textContent = SENTENCE
      if (caption) caption.textContent = 'Dictated into Messages'
      paintCheck(ctx)
      return
    }

    const envelope = makeEnvelope()
    let started = 0
    let previous = 0
    let lastState = ''
    /** Only animate while the hero is actually on screen. */
    let visible = true

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible = entry.isIntersecting
      },
      { threshold: 0 },
    )
    observer.observe(stage)

    const CAPTIONS = {
      idle: 'Resting — 44 × 8 pixels',
      listening: 'Hold your key and speak',
      processing: 'Transcribing and polishing, on this Mac',
      inserted: 'Inserted where the cursor was',
    }

    function frame(now) {
      requestAnimationFrame(frame)
      if (!visible) {
        previous = 0
        return
      }
      if (started === 0) started = now
      const dt = previous === 0 ? 16 : Math.min(100, now - previous)
      previous = now

      const elapsed = now - started
      const phase = phaseAt(elapsed)

      if (phase.state !== lastState) {
        lastState = phase.state
        stage.dataset.state = phase.state
        pill.dataset.state = phase.state
        const pillWrap = pill.parentElement
        if (pillWrap) pillWrap.dataset.state = phase.state
        if (caption) caption.textContent = CAPTIONS[phase.state]
      }

      // The words appear while the pill is listening, then stay put for the
      // rest of the cycle — the same order they happen in for real.
      if (phase.state === 'idle') {
        text.textContent = ''
      } else if (phase.state === 'listening') {
        const progress = clamp01(phase.into / (phase.of * 0.92))
        text.textContent = SENTENCE.slice(0, Math.round(progress * SENTENCE.length))
      } else {
        text.textContent = SENTENCE
      }

      envelope.push(phase.state === 'listening' ? syntheticLevel(phase.into) : 0)
      const level = envelope.advance(dt)

      ctx.clearRect(0, 0, CANVAS.width, CANVAS.height)
      if (phase.state === 'listening') paintWave(ctx, level, elapsed)
      else if (phase.state === 'processing') paintShimmer(ctx, phase.into)
      else if (phase.state === 'inserted') paintCheck(ctx)
      else paintDots(ctx)
    }

    requestAnimationFrame(frame)
  }

  // -- platform ------------------------------------------------------------

  /**
   * Which build to offer.
   *
   * Murmur ships four artifacts, and the page had been assuming everyone was on
   * a Mac — including in step one, which told a Windows visitor to hold `fn`,
   * a key their keyboard does not have and their build does not bind.
   *
   * Detection is user-agent sniffing, which is unreliable by nature, so
   * everything degrades: the markup already links to the releases page (which
   * lists every build), an unrecognised platform is left exactly as authored,
   * and the alternatives are always listed so a wrong guess costs one click.
   */
  const PLATFORMS = {
    mac: {
      name: 'macOS',
      requirement: '<strong>macOS 13 Ventura or later</strong>',
      /** Matches the DMG for a given architecture. */
      match: { arm64: /-arm64\.dmg$/i, x64: /^(?!.*arm64).*\.dmg$/i },
      device: 'Mac',
      paletteKey: '⌘K',
      claimKey:
        'Input Monitoring lets Murmur notice your dictation key being held anywhere on the ' +
        'system. The tap is listen-only and matches the one key you chose. No other keystroke is ' +
        'read, stored or sent anywhere.',
      claimInsert:
        'Accessibility is used to type the finished text where your cursor is. Murmur looks up ' +
        'which app is frontmost — the bundle id, nothing else — to pick a tone.',
      hotkey:
        '<kbd>fn</kbd> by default — or right <kbd>⌘</kbd>, right <kbd>⌥</kbd>, or one you pick. ' +
        'It works in every app, including the ones with no dictation of their own.',
      install:
        'Grab the disk image, drag it to Applications, and hold your key. First run walks you ' +
        'through the permissions and downloads a model sized for your machine.',
    },
    windows: {
      name: 'Windows',
      requirement: '<strong>Windows 10 or 11</strong>, 64-bit',
      match: { x64: /\.exe$/i },
      device: 'PC',
      paletteKey: 'Ctrl K',
      claimKey:
        'A low-level keyboard hook lets Murmur notice your dictation key being held anywhere on ' +
        'the system — Windows asks for no permission to do it. The hook matches the one key you ' +
        'chose. No other keystroke is read, stored or sent anywhere.',
      claimInsert:
        'The text is typed the way you would type it: the clipboard is swapped, Ctrl+V is sent, ' +
        'and the clipboard is put back. Murmur looks up which app is in front — the process name, ' +
        'nothing else — to pick a tone.',
      hotkey:
        'Right <kbd>Ctrl</kbd> by default — or <kbd>Caps Lock</kbd>, or one you pick. It works ' +
        'in every app, including the ones with no dictation of their own.',
      install:
        'Run the installer and hold your key. First run walks you through the setup and downloads ' +
        'a model sized for your machine.',
    },
    linux: {
      name: 'Linux',
      requirement: '<strong>X11</strong> · AppImage or .deb, 64-bit',
      match: { appimage: /\.AppImage$/i, deb: /\.deb$/i },
      device: 'machine',
      paletteKey: 'Ctrl K',
      claimKey:
        'XRecord lets Murmur notice your dictation key being held anywhere in the session, and no ' +
        'permission is involved. It observes the key rather than taking it, so right Ctrl still ' +
        'works everywhere else. No other keystroke is read, stored or sent anywhere.',
      claimInsert:
        'The text is typed the way you would type it, over XTEST: the clipboard is swapped, ' +
        'Ctrl+V is sent, and the clipboard is put back. Murmur looks up which window is active — ' +
        'its name, nothing else — to pick a tone.',
      hotkey:
        'Right <kbd>Ctrl</kbd> by default — or right <kbd>Alt</kbd>, or one you pick. Wayland is ' +
        'not supported yet; the global key needs X11.',
      install:
        'Download the AppImage, make it executable, and hold your key. First run walks you ' +
        'through the setup and downloads a model sized for your machine.',
    },
  }

  const RELEASES = 'https://github.com/jdbremer/Murmur/releases/latest'

  function detectOs() {
    const ua = navigator.userAgent
    const platform = navigator.userAgentData?.platform ?? navigator.platform ?? ''
    // iPadOS reports a Mac user agent; it is not a Mac, and nothing here runs
    // on it, so a touch-capable "Mac" is treated as unknown.
    if (/Mac/i.test(platform + ua) && navigator.maxTouchPoints > 2) return null
    if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return 'mac'
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows'
    if (/Linux|X11/i.test(platform + ua) && !/Android/i.test(ua)) return 'linux'
    return null
  }

  /**
   * Apple Silicon or Intel, or null when the browser will not say.
   *
   * Chromium exposes it behind a high-entropy hint; Safari does not, and
   * reports "MacIntel" on every Mac ever made — so the GPU string is the only
   * signal left there. Returning null on doubt is deliberate: an arm64 build
   * does not run on an Intel Mac at all, so a confident wrong guess is worse
   * than offering both.
   */
  async function detectMacArch() {
    const data = navigator.userAgentData
    if (data && typeof data.getHighEntropyValues === 'function') {
      try {
        const values = await data.getHighEntropyValues(['architecture'])
        if (values.architecture === 'arm') return 'arm64'
        if (values.architecture === 'x86') return 'x64'
      } catch {
        /* fall through to the GPU probe */
      }
    }
    try {
      const gl = document.createElement('canvas').getContext('webgl')
      const info = gl && gl.getExtension('WEBGL_debug_renderer_info')
      const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : ''
      if (/apple\s*m\d|apple gpu/i.test(renderer)) return 'arm64'
      if (/intel|radeon/i.test(renderer)) return 'x64'
    } catch {
      /* no WebGL: give up rather than guess */
    }
    return null
  }

  const ARCH_LABEL = { arm64: 'Apple Silicon', x64: 'Intel', appimage: 'AppImage', deb: '.deb' }

  function applyPlatform(os, arch, assets) {
    const spec = PLATFORMS[os]
    if (!spec) return

    document.documentElement.dataset.os = os

    const assetFor = (key) => {
      const pattern = spec.match[key]
      if (!pattern || !assets) return null
      const found = assets.find((asset) => pattern.test(asset.name))
      return found ? found.url : null
    }

    // The primary key: the detected architecture on a Mac, otherwise the one
    // build that platform has.
    const primaryKey = os === 'mac' ? (arch ?? 'arm64') : Object.keys(spec.match)[0]
    const primaryUrl = assetFor(primaryKey)

    const suffix = os === 'mac' && arch ? ` · ${ARCH_LABEL[arch]}` : ''
    for (const label of document.querySelectorAll('[data-download-label]')) {
      label.textContent = `Download for ${spec.name}${suffix}`
    }
    if (primaryUrl) {
      for (const link of document.querySelectorAll('[data-download]')) link.href = primaryUrl
    }

    for (const node of document.querySelectorAll('[data-requirements]')) {
      node.innerHTML = `${spec.requirement} · Free and <strong>MIT licensed</strong>`
    }
    for (const node of document.querySelectorAll('[data-hotkey-copy]')) {
      node.innerHTML = spec.hotkey
    }
    for (const node of document.querySelectorAll('[data-install-copy]')) {
      node.textContent = spec.install
    }
    // "anywhere on your Mac" is the wrong sentence for someone on Windows, and
    // the headline claim is the last place to be sloppy about whose machine
    // this is. The <title> and the social card stay Mac-first on purpose:
    // that is the product's positioning, not a detail of who is reading.
    for (const node of document.querySelectorAll('[data-device]')) node.textContent = spec.device
    for (const node of document.querySelectorAll('[data-platform-name]')) {
      node.textContent = spec.name
    }
    // The browser tab too. `og:title` cannot follow — a scraper reads the
    // markup before any of this runs — so the social card stays Mac-first,
    // which is the product's positioning rather than an oversight.
    document.title = `Murmur — dictation that never leaves your ${spec.device}`

    // The command palette is ⌘K on a Mac and Ctrl K everywhere else — the app
    // binds both, but the page should name the one this visitor would press.
    for (const node of document.querySelectorAll('[data-palette-key]')) {
      node.textContent = spec.paletteKey
    }

    // Input Monitoring and Accessibility are macOS permissions and do not
    // exist on the other two. Windows uses a keyboard hook and SendInput,
    // Linux uses XRecord and XTEST, and neither asks the user for anything —
    // so the privacy claims have to be per-platform or they are simply untrue
    // for two thirds of the people reading them.
    for (const node of document.querySelectorAll('[data-claim-key]')) {
      node.textContent = spec.claimKey
    }
    for (const node of document.querySelectorAll('[data-claim-insert]')) {
      node.textContent = spec.claimInsert
    }

    // Everything this visitor was not offered, so a wrong guess is one click to
    // fix rather than a dead end.
    const others = []
    for (const key of Object.keys(spec.match)) {
      if (key === primaryKey) continue
      others.push({
        label: `${spec.name} · ${ARCH_LABEL[key] ?? key}`,
        url: assetFor(key) ?? RELEASES,
      })
    }
    for (const [id, other] of Object.entries(PLATFORMS)) {
      if (id === os) continue
      others.push({ label: other.name, url: RELEASES })
    }

    for (const node of document.querySelectorAll('[data-alt-downloads]')) {
      node.innerHTML =
        'Also for ' +
        others
          .map((item) => `<a href="${item.url}">${item.label}</a>`)
          .join('<span class="sep">·</span>')
      node.hidden = false
    }
  }

  /**
   * Asset URLs for the newest release.
   *
   * One anonymous GET to the public API, purely so the button is a download
   * rather than a trip to a list. Nothing is sent, nothing is stored, and every
   * failure path — offline, rate-limited, blocked — leaves the links pointing
   * at the releases page they already point at in the markup.
   */
  async function latestAssets() {
    try {
      const response = await fetch('https://api.github.com/repos/jdbremer/Murmur/releases/latest', {
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (!response.ok) return null
      const release = await response.json()
      if (!Array.isArray(release.assets)) return null
      return release.assets.map((asset) => ({ name: asset.name, url: asset.browser_download_url }))
    } catch {
      return null
    }
  }

  async function setUpDownloads() {
    const os = detectOs()
    if (!os) return
    const arch = os === 'mac' ? await detectMacArch() : null
    // Paint the platform-specific copy immediately; upgrade the links to direct
    // downloads if and when the API answers.
    applyPlatform(os, arch, null)
    const assets = await latestAssets()
    if (assets) applyPlatform(os, arch, assets)
  }

  // -- page furniture ------------------------------------------------------

  function revealOnScroll() {
    const targets = [...document.querySelectorAll('.reveal')]
    const show = (element) => {
      element.dataset.shown = 'true'
    }

    if (reducedMotion.matches || !('IntersectionObserver' in window)) {
      targets.forEach(show)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          show(entry.target)
          observer.unobserve(entry.target)
        }
      },
      { rootMargin: '0px 0px -12% 0px' },
    )
    targets.forEach((element) => observer.observe(element))

    /*
     * Belt and braces: reveal anything the viewport has already passed.
     *
     * An anchor jump — or any scroll faster than the observer's callback —
     * can skip an element entirely, and something that never intersects never
     * fires. It would reveal on the way back up, but "content is invisible
     * until you scroll back" is not a state worth allowing. One throttled
     * pass per frame, and the listener removes itself the moment everything
     * is shown.
     */
    let queued = false
    const sweep = () => {
      queued = false
      let remaining = 0
      for (const element of targets) {
        if (element.dataset.shown === 'true') continue
        if (element.getBoundingClientRect().top < window.innerHeight) show(element)
        else remaining += 1
      }
      if (remaining === 0) window.removeEventListener('scroll', onScroll)
    }
    const onScroll = () => {
      if (queued) return
      queued = true
      requestAnimationFrame(sweep)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
  }

  /** The masthead only grows a hairline once there is something above it. */
  function stickyHeader() {
    const masthead = document.querySelector('.masthead')
    if (!masthead) return
    const update = () => {
      masthead.dataset.scrolled = String(window.scrollY > 8)
    }
    update()
    window.addEventListener('scroll', update, { passive: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }

  function boot() {
    start()
    revealOnScroll()
    stickyHeader()
    void setUpDownloads()
  }
})()
