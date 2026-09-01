import { describe, expect, it } from 'vitest'

import { findOrphanedSidecars } from '../src/main/engines/sidecar'

/**
 * Finding sidecars that outlived the app that spawned them.
 *
 * Sidecars are spawned detached on POSIX so a kill can reach the whole process
 * group, which also means they survive a parent that dies without running
 * `before-quit` — a crash, a Force Quit, a logout. They then hold a port, a
 * model and its memory indefinitely: one real machine had four of them nine
 * days old, from an app bundle since replaced twice.
 *
 * The risk in sweeping them up is killing something still in use, so the two
 * conditions are tested from that direction: what must be spared, first.
 */

const BIN = '/Applications/Murmur.app/Contents/Resources/bin/whisper-server'

const ps = (...lines: string[]): string => lines.join('\n')
const row = (pid: number, ppid: number, command: string): string =>
  `${String(pid).padStart(6)} ${String(ppid).padStart(6)} ${command}`

describe('findOrphanedSidecars', () => {
  it('spares a sidecar that still has a parent', () => {
    // A second running Murmur owns its sidecar, so its parent is that app and
    // never init. Killing it would take down a live instance's transcription.
    expect(findOrphanedSidecars(BIN, ps(row(500, 499, `${BIN} --port 51824`)))).toEqual([])
  })

  it('spares an identically-named binary from a different install', () => {
    // A dev build beside the shipped one runs the same file name from another
    // bundle. Matching on the name alone would kill across installs.
    const dev =
      '/Users/x/git/Murmur/apps/desktop/release/mac-arm64/Murmur.app/Contents/Resources/bin/whisper-server'
    expect(findOrphanedSidecars(BIN, ps(row(500, 1, `${dev} --port 51824`)))).toEqual([])
  })

  it('spares a longer path that merely starts with ours', () => {
    // `startsWith` on its own would match "/…/bin/whisper-server-v2".
    expect(findOrphanedSidecars(BIN, ps(row(500, 1, `${BIN}-v2 --port 51824`)))).toEqual([])
  })

  it('finds an orphan of exactly this binary', () => {
    expect(
      findOrphanedSidecars(BIN, ps(row(59007, 1, `${BIN} --host 127.0.0.1 --port 52037`))),
    ).toEqual([59007])
  })

  it('finds an orphan invoked with no arguments at all', () => {
    expect(findOrphanedSidecars(BIN, ps(row(59007, 1, BIN)))).toEqual([59007])
  })

  it('finds several, and ignores everything else on the machine', () => {
    const listing = ps(
      row(1, 0, '/sbin/launchd'),
      row(500, 1, `${BIN} --port 51824`),
      row(501, 499, `${BIN} --port 51825`),
      row(502, 1, `${BIN} --port 51826`),
      row(600, 1, '/opt/homebrew/bin/ollama serve'),
      '',
      'not a process line at all',
    )
    expect(findOrphanedSidecars(BIN, listing)).toEqual([500, 502])
  })

  it('returns nothing for empty or unparseable output', () => {
    expect(findOrphanedSidecars(BIN, '')).toEqual([])
    expect(findOrphanedSidecars(BIN, 'ps: command not found')).toEqual([])
  })
})
