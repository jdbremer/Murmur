import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { COMPILED_ORIGIN_POLICY, validateCatalog } from '../src/catalog/validate'
import type { ModelEntry } from '../src/catalog/schema'

/**
 * The **shipped** catalog file (PLAN §8).
 *
 * `catalog.test.ts` proves `validateCatalog` behaves; this proves the file we
 * actually ship passes it, and adds the invariants a hand-edit could break
 * without failing the schema — a duplicate download filename inside one model,
 * a size that does not match its files, an entry with no `notes` explaining a
 * community quantisation.
 *
 * Every URL and SHA-256 in that file was verified against live Hugging Face
 * metadata when it was authored; this test is the regression guard, not the
 * original verification.
 */

const catalogPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'resources',
  'catalog',
  'models.json',
)

const catalog = validateCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')), {
  source: 'resources/catalog/models.json',
})

const stt = catalog.models.filter((model) => model.kind === 'stt')
const polish = catalog.models.filter((model) => model.kind === 'polish')

describe('resources/catalog/models.json', () => {
  it('passes validateCatalog under the compiled origin policy', () => {
    expect(catalog.originPolicy).toEqual([...COMPILED_ORIGIN_POLICY])
    expect(catalog.models.length).toBeGreaterThan(0)
  })

  it('offers both an STT and a polish model', () => {
    expect(stt.length).toBeGreaterThan(0)
    expect(polish.length).toBeGreaterThan(0)
  })

  it('says who converted Parakeet, since it is the one entry we built ourselves', () => {
    // Every other entry points at weights their publisher packaged. This one is
    // NVIDIA's weights in a container Murmur produced, so the file has to answer
    // "who converted this" rather than leave it to a commit message.
    const parakeet = catalog.models.find((model) => model.id.includes('parakeet'))
    expect(parakeet).toBeDefined()
    expect(parakeet?.org).toBe('NVIDIA')
    expect(parakeet?.license).toBe('CC-BY-4.0')
    expect(parakeet?.notes ?? '').toContain('export_parakeet.py')
    expect(catalog.notes ?? '').toContain('export-parakeet.md')
  })

  it('never cites the design document in text a user reads', () => {
    // `notes` is rendered in the Models section. "PLAN §7.2" is a pointer into
    // a file that ships with the source and not with the app, so to a user it
    // is a reference to nothing. Naming a script in this repository is fine and
    // deliberate — that is checkable provenance, not an internal cross-reference.
    for (const model of catalog.models) {
      expect(model.notes ?? '', `${model.id} cites PLAN`).not.toMatch(/PLAN\s*§/)
    }
    expect(catalog.notes ?? '').not.toMatch(/PLAN\s*§/)
  })

  it('has exactly one recommended default per RAM tier and kind', () => {
    for (const kind of ['stt', 'polish'] as const) {
      const recommended = catalog.models.filter(
        (model) => model.kind === kind && model.recommended === true,
      )
      expect(recommended.length, `${kind} recommendations`).toBeGreaterThan(0)

      // One per distinct RAM tier — the "one opinionated default per tier" of
      // PLAN §17.2, not a list of favourites.
      const tiers = recommended.map((model) => model.ramTierGb)
      expect(new Set(tiers).size).toBe(tiers.length)
    }
  })

  it('pins every URL to an immutable revision or release tag', () => {
    // Two shapes, because Parakeet's ONNX is Murmur's own conversion and cannot
    // live on Hugging Face. Both are immutable: a Hugging Face revision is a
    // commit hash, and the model release tag is never re-cut. Combined with the
    // sha256 check, a moved file is a failed download rather than a silent swap.
    for (const model of catalog.models) {
      for (const file of model.files) {
        const url = new URL(file.url)
        expect(url.protocol, model.id).toBe('https:')

        if (url.hostname === 'huggingface.co') {
          // /<owner>/<repo>/resolve/<40-hex-revision>/<path>
          expect(url.pathname, `${model.id}/${file.filename} is not revision-pinned`).toMatch(
            /\/resolve\/[0-9a-f]{40}\//,
          )
          continue
        }

        expect(url.hostname, model.id).toBe('github.com')
        expect(url.pathname, `${model.id}/${file.filename}`).toMatch(
          /^\/jdbremer\/Murmur\/releases\/download\/models-[\w.-]+\//,
        )
      }
    }
  })

  it('gives every file a real lowercase SHA-256 and a positive size', () => {
    for (const model of catalog.models) {
      for (const file of model.files) {
        expect(file.sha256, `${model.id}/${file.filename}`).toMatch(/^[0-9a-f]{64}$/)
        // A placeholder hash is the failure this guards against.
        expect(new Set(file.sha256).size, `${model.id} hash looks synthetic`).toBeGreaterThan(4)
        expect(file.bytes).toBeGreaterThan(0)
      }
    }
  })

  it('keeps filenames unique inside a model, since they share one directory', () => {
    for (const model of catalog.models) {
      const names = model.files.map((file) => file.filename)
      expect(new Set(names).size, `${model.id} has duplicate filenames`).toBe(names.length)
    }
  })

  it('reports sizeBytes as the sum of its files', () => {
    for (const model of catalog.models) {
      const total = model.files.reduce((sum, file) => sum + file.bytes, 0)
      expect(model.sizeBytes, model.id).toBe(total)
    }
  })

  it('states quantisation provenance in notes for every entry', () => {
    // PLAN §8's origin policy is only auditable if a reader can tell whose
    // weights these are and who packaged them.
    for (const model of catalog.models) {
      expect(model.notes, `${model.id} has no notes`).toBeTruthy()
      expect((model.notes ?? '').length).toBeGreaterThan(40)
    }
  })

  it('routes each model to an engine that can load it', () => {
    const expectations: Record<ModelEntry['engine'], (model: ModelEntry) => boolean> = {
      // whisper.cpp wants a single ggml .bin.
      'whisper-cpp': (model) =>
        model.kind === 'stt' && model.files.every((file) => file.filename.endsWith('.bin')),
      // llama.cpp wants exactly one .gguf.
      'llama-cpp': (model) =>
        model.kind === 'polish' &&
        model.files.filter((file) => file.filename.endsWith('.gguf')).length === 1,
      // The ONNX host loads one of three shapes, and `detectFamily` has to be
      // able to tell which from the filenames alone.
      'onnx-runtime': (model) => {
        const names = model.files.map((file) => file.filename)
        // A transducer is three graphs plus its vocabulary and the export's own
        // config; an encoder-decoder is two graphs plus a tokenizer.
        const transducer =
          names.includes('encoder.onnx') &&
          names.includes('decoder.onnx') &&
          names.includes('joint.onnx') &&
          names.includes('vocab.json') &&
          names.includes('config.json')
        const encoderDecoder =
          names.some((name) => name.includes('encoder_model')) &&
          names.some((name) => name.includes('decoder_model')) &&
          names.includes('tokenizer.json')
        // A CTC model is a single graph and a vocabulary — it has no decoder to
        // step and no joint network, which is the whole reason its decode is a
        // collapse rather than a loop.
        const ctc =
          names.some((name) => name === 'model.onnx' || name === 'model.int8.onnx') &&
          names.includes('tokenizer.json')
        return transducer || encoderDecoder || ctc
      },
    }

    for (const model of catalog.models) {
      expect(expectations[model.engine](model), `${model.id} (${model.engine})`).toBe(true)
    }
  })

  it('labels every model with a licence and a US origin', () => {
    for (const model of catalog.models) {
      expect(model.origin).toBe('US')
      expect(model.license.length).toBeGreaterThan(2)
      expect(model.org.length).toBeGreaterThan(1)
    }
  })

  it('sets a plausible RAM tier for every model', () => {
    for (const model of catalog.models) {
      expect(model.ramTierGb, model.id).toBeGreaterThanOrEqual(4)
      expect(model.ramTierGb, model.id).toBeLessThanOrEqual(64)
    }
  })
})
