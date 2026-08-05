import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  CatalogOriginPolicyError,
  CatalogValidationError,
  COMPILED_ORIGIN_POLICY,
  createEmptyCatalog,
  safeValidateCatalog,
  validateCatalog,
} from '../src/catalog/validate'
import { makeCatalog, makeModelEntry } from './fixtures'

describe('validateCatalog', () => {
  it('accepts a well-formed US-only catalog', () => {
    const catalog = validateCatalog(
      makeCatalog([
        makeModelEntry(),
        makeModelEntry({
          id: 'gemma-3-4b-it',
          kind: 'polish',
          engine: 'llama-cpp',
          displayName: 'Gemma 3 4B-it',
          org: 'Google',
          license: 'Gemma',
          sizeBytes: 2_600_000_000,
          ramTierGb: 16,
          languages: ['multi'],
          quant: 'Q4_K_M',
          recommended: true,
        }),
      ]),
    )

    expect(catalog.models).toHaveLength(2)
    expect(catalog.originPolicy).toEqual(['US'])
    expect(catalog.models.map((m) => m.id)).toEqual(['whisper-small-en', 'gemma-3-4b-it'])
  })

  it('accepts a catalog with no entries yet', () => {
    expect(validateCatalog(makeCatalog([])).models).toEqual([])
  })

  it('rejects an otherwise-valid catalog containing a non-US entry, naming it', () => {
    const smuggled = makeModelEntry({
      id: 'sensevoice-small',
      displayName: 'SenseVoice Small',
      org: 'Alibaba DAMO Academy',
      origin: 'CN',
      engine: 'onnx-runtime',
      license: 'Apache-2.0',
    })

    // Sanity: the offending entry is structurally perfect — only origin is wrong.
    expect(() => validateCatalog(makeCatalog([smuggled]))).toThrow(CatalogOriginPolicyError)

    let thrown: unknown
    try {
      validateCatalog(makeCatalog([makeModelEntry(), smuggled]))
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CatalogOriginPolicyError)
    const error = thrown as CatalogOriginPolicyError
    expect(error.offendingModelIds).toEqual(['sensevoice-small'])

    // The message must name the entry so the failure is actionable in the UI.
    expect(error.message).toContain('sensevoice-small')
    expect(error.message).toContain('SenseVoice Small')
    expect(error.message).toContain('Alibaba DAMO Academy')
    expect(error.message).toContain('CN')
    expect(error.message).toContain('origin policy')

    // The compliant sibling must not be blamed.
    expect(error.message).not.toContain('whisper-small-en')
  })

  it('names every offender when several entries are out of policy', () => {
    const error = (() => {
      try {
        validateCatalog(
          makeCatalog([
            makeModelEntry({ id: 'voxtral-mini', org: 'Mistral AI', origin: 'FR' }),
            makeModelEntry({ id: 'cohere-asr', org: 'Cohere', origin: 'CA' }),
          ]),
        )
        return null
      } catch (e) {
        return e as CatalogOriginPolicyError
      }
    })()

    expect(error).toBeInstanceOf(CatalogOriginPolicyError)
    expect(error?.offendingModelIds).toEqual(['voxtral-mini', 'cohere-asr'])
    expect(error?.message).toContain('voxtral-mini')
    expect(error?.message).toContain('cohere-asr')
  })

  it('refuses a catalog that tries to widen the origin policy', () => {
    // A tampered mirror declares a permissive policy AND ships a matching entry,
    // so the entry-level check alone would pass. The compiled policy must win.
    const tampered = makeCatalog([makeModelEntry({ id: 'smuggled', origin: 'CN' })], ['US', 'CN'])

    let thrown: unknown
    try {
      validateCatalog(tampered)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(CatalogOriginPolicyError)
    expect((thrown as CatalogOriginPolicyError).message).toContain('cannot widen')
    expect((thrown as CatalogOriginPolicyError).message).toContain('CN')
  })

  it('allows a build to narrow the policy via allowedOrigins (tests only)', () => {
    const catalog = validateCatalog(makeCatalog([makeModelEntry({ origin: 'GB' })], ['GB']), {
      allowedOrigins: ['GB'],
    })
    expect(catalog.models[0]?.origin).toBe('GB')
  })

  it('rejects malformed catalogs with a path-annotated message', () => {
    expect(() => validateCatalog({ schemaVersion: 1 })).toThrow(CatalogValidationError)

    const bad = makeCatalog([makeModelEntry({ files: [] })])
    let thrown: unknown
    try {
      validateCatalog(bad)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CatalogValidationError)
    expect((thrown as CatalogValidationError).message).toContain('models.0.files')
  })

  it('rejects unknown keys so a tampered catalog cannot hide fields', () => {
    const withExtra = makeCatalog([{ ...makeModelEntry(), originOverride: 'US' } as never])
    expect(() => validateCatalog(withExtra)).toThrow(CatalogValidationError)
  })

  it('rejects a bad checksum, a path-shaped filename and duplicate ids', () => {
    const badSha = makeCatalog([
      makeModelEntry({
        files: [
          {
            url: 'https://huggingface.co/x/y/resolve/main/z.bin',
            sha256: 'not-a-sha',
            bytes: 1,
            filename: 'z.bin',
          },
        ],
      }),
    ])
    expect(() => validateCatalog(badSha)).toThrow(CatalogValidationError)

    const escapingFilename = makeCatalog([
      makeModelEntry({
        files: [
          {
            url: 'https://huggingface.co/x/y/resolve/main/z.bin',
            sha256: 'b'.repeat(64),
            bytes: 1,
            filename: '../../etc/passwd',
          },
        ],
      }),
    ])
    expect(() => validateCatalog(escapingFilename)).toThrow(CatalogValidationError)

    const duplicates = makeCatalog([makeModelEntry(), makeModelEntry()])
    expect(() => validateCatalog(duplicates)).toThrow(/duplicate model ids/)
  })

  it('safeValidateCatalog reports instead of throwing', () => {
    const ok = safeValidateCatalog(makeCatalog([makeModelEntry()]))
    expect(ok.ok).toBe(true)

    const bad = safeValidateCatalog(makeCatalog([makeModelEntry({ origin: 'CN' })]))
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toBeInstanceOf(CatalogOriginPolicyError)
  })

  it('createEmptyCatalog round-trips through validateCatalog', () => {
    expect(() => validateCatalog(createEmptyCatalog())).not.toThrow()
  })

  it('the compiled policy is US-only (PLAN §8 owner decision)', () => {
    expect([...COMPILED_ORIGIN_POLICY]).toEqual(['US'])
  })
})

describe('resources/catalog/models.json', () => {
  it('is a valid catalog under the compiled origin policy', () => {
    const path = fileURLToPath(new URL('../../../resources/catalog/models.json', import.meta.url))
    const json: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const catalog = validateCatalog(json, { source: 'resources/catalog/models.json' })
    expect(catalog.schemaVersion).toBe(1)
    expect(catalog.originPolicy).toEqual(['US'])
  })
})
