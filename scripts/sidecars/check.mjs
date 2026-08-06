#!/usr/bin/env node
/**
 * Prepare `.sidecars/bin` for packaging, and say plainly when it is empty.
 *
 * electron-builder needs the directory to exist (a missing `from` in
 * extraResources is fatal), so this creates it. The louder job is the warning:
 * packaging with no sidecars produces an app that installs, opens, downloads a
 * model, and then cannot transcribe a word — with nothing to explain why until
 * a runtime error naming two paths inside the bundle.
 *
 * It warns rather than fails on purpose. A contributor working on the UI should
 * not be forced through a whisper.cpp build to package the app; the release
 * workflow is where their absence is a hard error.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const binDir = join(repoRoot, '.sidecars', 'bin')

mkdirSync(binDir, { recursive: true })

const present = new Set(readdirSync(binDir))
const missing = ['whisper-server', 'llama-server'].filter(
  (name) => !present.has(name) && !present.has(`${name}.exe`),
)

if (missing.length > 0) {
  const yellow = (s) => `[33m${s}[0m`
  console.warn('')
  console.warn(yellow(`⚠  Packaging without: ${missing.join(', ')}`))
  console.warn(
    yellow('   The app will build and run, and will not be able to transcribe anything.'),
  )
  console.warn(
    yellow('   Build them first: brew install cmake && scripts/sidecars/build-whisper.sh'),
  )
  console.warn(
    yellow('   (build-llama.sh for polishing; the .ps1 scripts fetch prebuilds on Windows)'),
  )
  console.warn(
    yellow(`   Or copy them out of a release DMG into ${binDir.replace(repoRoot + '/', '')}`),
  )
  console.warn('')
} else if (existsSync(binDir)) {
  console.log(`sidecars: ${[...present].filter((f) => !f.startsWith('.')).join(', ')}`)
}
