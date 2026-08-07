'use strict'

/**
 * Build the N-API addon on supported platforms; skip quietly elsewhere.
 * Supported: darwin (Obj-C++), win32 (C++ SendInput / hooks), linux (X11).
 */

const SUPPORTED = ['darwin', 'win32', 'linux']

if (!SUPPORTED.includes(process.platform)) {
  console.log(
    '[@murmur/native] skipping native build on ' + process.platform + ' (macOS/Windows/Linux only)',
  )
  process.exit(0)
}

const { spawnSync } = require('node:child_process')

const result = spawnSync('node-gyp', ['rebuild'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

/**
 * A failed build must not fail `npm install`.
 *
 * The app is built to run without this addon: `index.js` serves a typed stub
 * and every caller treats it as "dictation unavailable" rather than an error.
 * Someone on a machine without Xcode Command Line Tools, VS Build Tools or the
 * X11 headers should still get a working checkout they can run `npm run dev`
 * in — failing the whole workspace install teaches them nothing the warning
 * below doesn't.
 *
 * `npm run native:build` is the command that reports build failure loudly, and
 * it is what CI runs.
 */
if (result.error) {
  console.warn('[@murmur/native] node-gyp not found — dictation will be unavailable in this build.')
  process.exit(0)
}

if (result.status !== 0) {
  console.warn(
    '[@murmur/native] native build failed (exit ' +
      result.status +
      ') — the app will load the no-op stub and dictation will be unavailable. ' +
      'Run `npm run native:build` to see why.',
  )
  if (process.platform === 'linux') {
    // Overwhelmingly the reason on a fresh Linux box, and the error node-gyp
    // prints for it ("X11/Xlib.h: No such file") does not name a package.
    console.warn(
      '[@murmur/native] on Linux this usually means the X11 headers are missing: ' +
        'apt install libx11-dev libxtst-dev  (dnf: libX11-devel libXtst-devel)',
    )
  }
}

process.exit(0)
