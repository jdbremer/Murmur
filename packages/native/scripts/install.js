'use strict'

/**
 * npm's default `install` script for a `"gypfile": true` package is
 * `node-gyp rebuild`, which would fail on any non-macOS machine. This script
 * replaces it: build on macOS, quietly skip everywhere else.
 *
 * In practice npm never even reaches this on Linux/Windows — the package
 * declares `"os": ["darwin"]`, so it is skipped as an optional dependency of
 * `@murmur/desktop`. The guard is here for the case where someone installs
 * this package directly.
 */

if (process.platform !== 'darwin') {
  console.log('[@murmur/native] skipping native build on ' + process.platform + ' (macOS only)')
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
