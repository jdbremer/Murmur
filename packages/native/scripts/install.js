'use strict'

/**
 * Build the N-API addon on supported platforms; skip quietly elsewhere.
 * Supported: darwin (Obj-C++), win32 (C++ SendInput / hooks).
 */

if (process.platform !== 'darwin' && process.platform !== 'win32') {
  console.log(
    '[@murmur/native] skipping native build on ' + process.platform + ' (macOS/Windows only)',
  )
  process.exit(0)
}

const { spawnSync } = require('node:child_process')

const result = spawnSync('node-gyp', ['rebuild'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

if (result.error) {
  console.error('[@murmur/native] node-gyp not found — run `npm install` at the repo root first.')
  process.exit(1)
}

process.exit(result.status === null ? 1 : result.status)
