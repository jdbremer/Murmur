import { describe, expect, it, vi } from 'vitest'

import { createNativeStub, type MurmurNative } from '@murmur/shared'

import {
  applyFileTags,
  CodeContextReader,
  CODE_CONTEXT_TTL_MS,
  extractCodeContext,
  ideForBundleId,
  splitIdentifier,
  supportsFileTagging,
} from '../src/main/dictation/code-context'

/**
 * Vibe coding (PLAN §18.3).
 *
 * Two things are under test, and only one of them is about accuracy. The other
 * is the gating: this is the single place in Murmur that reads screen content,
 * and "it did not read anything it should not have" is a property that has to
 * be asserted rather than reviewed, because nothing about a missing read is
 * visible from the outside.
 */

const SOURCE = `
import { useCallback } from 'react'
import { barBounds } from './windows/bar'

export function useNoteAutosave(noteId: string): void {
  const flush_pending = useCallback(() => {
    barBounds()
    barBounds()
  }, [noteId])
}
`

function nativeWith(read: MurmurNative['readFocusedEditorText']): {
  native: MurmurNative
  calls: () => number
} {
  const spy = vi.fn(read)
  const stub = createNativeStub('test')
  return {
    native: { ...stub, readFocusedEditorText: spy },
    calls: () => spy.mock.calls.length,
  }
}

const CURSOR = 'com.todesktop.230313mzl4w4u92'

describe('ideForBundleId', () => {
  it('recognises the three allowlisted IDEs', () => {
    expect(ideForBundleId('com.microsoft.VSCode')).toBe('vscode')
    expect(ideForBundleId(CURSOR)).toBe('cursor')
    expect(ideForBundleId('com.exafunction.windsurf')).toBe('windsurf')
  })

  it('refuses everything else, including things that look like editors', () => {
    for (const bundleId of [
      null,
      '',
      'com.apple.Terminal',
      'com.jetbrains.intellij',
      'com.sublimetext.4',
      'com.apple.dt.Xcode',
      // Insiders reports its own id and its screen-reader mode does not expose
      // the editor the same way, so listing it would ship a silent no-op.
      'com.microsoft.VSCodeInsiders',
    ]) {
      expect(ideForBundleId(bundleId)).toBeNull()
    }
  })

  it('tags files only where the chat understands @file', () => {
    expect(supportsFileTagging('cursor')).toBe(true)
    expect(supportsFileTagging('windsurf')).toBe(true)
    expect(supportsFileTagging('vscode')).toBe(false)
  })
})

describe('splitIdentifier', () => {
  it('splits camelCase, PascalCase and snake_case', () => {
    expect(splitIdentifier('barBounds')).toEqual(['bar', 'Bounds'])
    expect(splitIdentifier('BarBounds')).toEqual(['Bar', 'Bounds'])
    expect(splitIdentifier('flush_pending')).toEqual(['flush', 'pending'])
  })

  it('keeps an acronym together', () => {
    // `H T T P Server` would be four useless one-letter terms.
    expect(splitIdentifier('HTTPServer')).toEqual(['HTTP', 'Server'])
    expect(splitIdentifier('parseJSONBody')).toEqual(['parse', 'JSON', 'Body'])
  })
})

describe('extractCodeContext', () => {
  it('finds the identifiers a decoder would otherwise mangle', () => {
    const { terms } = extractCodeContext(SOURCE)

    expect(terms).toContain('useCallback')
    expect(terms).toContain('barBounds')
    expect(terms).toContain('useNoteAutosave')
    expect(terms).toContain('flush_pending')
  })

  it('contributes the pieces of a compound name as well as the whole', () => {
    // So "bar bounds" said as two words is heard as two words the file uses.
    const { terms } = extractCodeContext(SOURCE)
    expect(terms).toContain('bar')
    expect(terms).toContain('Bounds')
  })

  it('drops language keywords, which the decoder already knows', () => {
    const { terms } = extractCodeContext('export function returns(value) { return value }')
    expect(terms).not.toContain('export')
    expect(terms).not.toContain('function')
    expect(terms).not.toContain('return')
    // But a keyword-shaped *compound* is a real name and stays.
    expect(extractCodeContext('const returnValue = 1').terms).toContain('returnValue')
  })

  it('drops names too short to be worth a prompt slot', () => {
    const { terms } = extractCodeContext('const i = 0; const ok = 1; const map = 2')
    expect(terms).not.toContain('i')
    expect(terms).not.toContain('ok')
  })

  it('ranks by frequency, so the file’s own vocabulary comes first', () => {
    // barBounds appears three times in the fixture; useNoteAutosave once.
    const { terms } = extractCodeContext(SOURCE)
    expect(terms.indexOf('barBounds')).toBeLessThan(terms.indexOf('useNoteAutosave'))
  })

  it('caps the number of terms, because they are charged to the prompt', () => {
    const many = Array.from({ length: 500 }, (_, index) => `identifierNumber${index}`).join(' ')
    expect(extractCodeContext(many, 96).terms).toHaveLength(96)
  })

  it('collects filenames without leaving their extensions as terms', () => {
    const { files, terms } = extractCodeContext("import x from './windows/bar.ts'")
    expect(files).toContain('bar.ts')
    // A bare "ts" in the bias list would be noise at best.
    expect(terms).not.toContain('ts')
  })

  it('ignores dotted things that are not source files', () => {
    const { files } = extractCodeContext('object.property и user.name and version.toFixed(2)')
    expect(files).toEqual([])
  })
})

describe('applyFileTags', () => {
  const files = ['useNotes.ts', 'bar.ts', 'cursorFormatting.tsx']

  it('turns a spoken filename into the real one', () => {
    const { text, tagged } = applyFileTags('look at bar dot ts please', files, { at: false })
    expect(text).toBe('look at bar.ts please')
    expect(tagged).toBe(1)
  })

  it('prefixes @ where the chat understands it', () => {
    expect(applyFileTags('check bar dot ts', files, { at: true }).text).toBe('check @bar.ts')
  })

  it('matches a camelCase filename said as words', () => {
    expect(applyFileTags('open cursor formatting dot tsx', files, { at: true }).text).toBe(
      'open @cursorFormatting.tsx',
    )
  })

  it('restores the real casing when the name was already written out', () => {
    expect(applyFileTags('open usenotes.ts', files, { at: false }).text).toBe('open useNotes.ts')
  })

  it('prefers the longer filename when two could match the same phrase', () => {
    // "notes dot ts" must not win over "use notes dot ts".
    expect(
      applyFileTags('open use notes dot ts', ['notes.ts', 'useNotes.ts'], { at: true }).text,
    ).toBe('open @useNotes.ts')
  })

  it('never invents a file that is not open', () => {
    const { text, tagged } = applyFileTags('open secrets dot env', files, { at: true })
    expect(text).toBe('open secrets dot env')
    expect(tagged).toBe(0)
  })

  it('does not tag inside a longer word or an existing tag', () => {
    expect(applyFileTags('see @bar.ts already', files, { at: true }).text).toBe(
      'see @bar.ts already',
    )
    expect(applyFileTags('rebar.tsx thing', files, { at: true }).text).toBe('rebar.tsx thing')
  })

  it('is a no-op with nothing to match against', () => {
    expect(applyFileTags('bar dot ts', [], { at: true })).toEqual({ text: 'bar dot ts', tagged: 0 })
  })
})

describe('CodeContextReader — the gates', () => {
  const on = { variableRecognition: true, fileTagging: true }

  it('never touches native when the feature is off', () => {
    const { native, calls } = nativeWith(() => ({ ok: true, text: SOURCE }))
    const reader = new CodeContextReader({
      native: () => native,
      settings: () => ({ variableRecognition: false, fileTagging: false }),
    })

    expect(reader.read(CURSOR).terms).toEqual([])
    expect(calls()).toBe(0)
  })

  it('never touches native for an app that is not an allowlisted IDE', () => {
    const { native, calls } = nativeWith(() => ({ ok: true, text: SOURCE }))
    const reader = new CodeContextReader({ native: () => native, settings: () => on })

    for (const bundleId of [null, 'com.apple.Terminal', 'com.tinyspeck.slackmacgap']) {
      expect(reader.read(bundleId).terms).toEqual([])
    }
    expect(calls()).toBe(0)
  })

  it('reads, once the user has opted in and an IDE is in front', () => {
    const { native, calls } = nativeWith(() => ({ ok: true, text: SOURCE }))
    const reader = new CodeContextReader({ native: () => native, settings: () => on })

    expect(reader.read(CURSOR).terms).toContain('barBounds')
    expect(calls()).toBe(1)
  })

  it('returns nothing when the IDE exposes no text', () => {
    // The ordinary case: Screen Reader Mode is off, so the editor is a canvas.
    const { native } = nativeWith(() => ({ ok: false, error: 'no text' }))
    const reader = new CodeContextReader({ native: () => native, settings: () => on })

    expect(reader.read(CURSOR)).toEqual({ terms: [], files: [] })
  })

  it('returns nothing on a platform with no such native call', () => {
    // Windows and Linux do not export it at all, rather than exporting a stub
    // that returns a plausible empty string — so the property is *absent*.
    const { readFocusedEditorText: _absent, ...withoutTheCall } = createNativeStub('test')
    const reader = new CodeContextReader({ native: () => withoutTheCall, settings: () => on })
    expect(reader.read(CURSOR)).toEqual({ terms: [], files: [] })
  })

  it('caches for a few seconds, so three quick utterances are one AX round trip', () => {
    let now = 1_000
    const { native, calls } = nativeWith(() => ({ ok: true, text: SOURCE }))
    const reader = new CodeContextReader({
      native: () => native,
      settings: () => on,
      now: () => now,
    })

    reader.read(CURSOR)
    reader.read(CURSOR)
    expect(calls()).toBe(1)

    now += CODE_CONTEXT_TTL_MS + 1
    reader.read(CURSOR)
    expect(calls()).toBe(2)
  })

  it('does not serve one app’s context to another', () => {
    const now = 1_000
    const { native, calls } = nativeWith(() => ({ ok: true, text: SOURCE }))
    const reader = new CodeContextReader({
      native: () => native,
      settings: () => on,
      now: () => now,
    })

    reader.read(CURSOR)
    reader.read('com.microsoft.VSCode')
    expect(calls()).toBe(2)
  })

  it('forgets on demand — switching the feature off must drop what it holds', () => {
    const now = 1_000
    const { native, calls } = nativeWith(() => ({ ok: true, text: SOURCE }))
    const reader = new CodeContextReader({
      native: () => native,
      settings: () => on,
      now: () => now,
    })

    reader.read(CURSOR)
    reader.forget()
    reader.read(CURSOR)
    expect(calls()).toBe(2)
  })
})

describe('CodeContextReader.probe', () => {
  const on = { variableRecognition: true, fileTagging: false }

  it('says which IDE to bring forward when none is', () => {
    const { native } = nativeWith(() => ({ ok: true, text: SOURCE }))
    const result = new CodeContextReader({ native: () => native, settings: () => on }).probe(
      'com.apple.Terminal',
    )

    expect(result.ide).toBeNull()
    expect(result.readable).toBe(false)
    expect(result.detail).toContain('Cursor')
  })

  it('names the next step when the editor is not exposing its text', () => {
    const { native } = nativeWith(() => ({ ok: false, error: 'no text' }))
    const result = new CodeContextReader({ native: () => native, settings: () => on }).probe(CURSOR)

    expect(result.readable).toBe(false)
    expect(result.detail).toContain('Screen Reader Accessibility Mode')
  })

  it('reports a count and never the code itself', () => {
    const { native } = nativeWith(() => ({ ok: true, text: SOURCE }))
    const result = new CodeContextReader({ native: () => native, settings: () => on }).probe(CURSOR)

    expect(result.readable).toBe(true)
    expect(result.symbolCount).toBeGreaterThan(0)
    // The whole point of returning a count: nothing from the file may appear.
    expect(result.detail).not.toContain('barBounds')
    expect(JSON.stringify(result)).not.toContain('useCallback')
  })
})
