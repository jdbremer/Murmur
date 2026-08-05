import type { ModelEntry } from '../src/catalog/schema'

/** A structurally valid entry; override fields per test. */
export function makeModelEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: 'whisper-small-en',
    kind: 'stt',
    engine: 'whisper-cpp',
    displayName: 'Whisper small.en',
    org: 'OpenAI',
    origin: 'US',
    license: 'MIT',
    sizeBytes: 500_000_000,
    ramTierGb: 8,
    languages: ['en'],
    quant: 'q5_0',
    files: [
      {
        url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
        sha256: 'a'.repeat(64),
        bytes: 500_000_000,
        filename: 'ggml-small.en.bin',
      },
    ],
    ...overrides,
  }
}

export function makeCatalog(models: ModelEntry[], originPolicy: string[] = ['US']): unknown {
  return {
    schemaVersion: 1,
    updatedAt: '2026-08-05T00:00:00.000Z',
    originPolicy,
    models,
  }
}
