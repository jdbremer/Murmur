import { z } from 'zod'

/**
 * The model catalog (PLAN §8): a versioned JSON file shipped with the app and
 * updatable independently of releases.
 *
 * The schema is deliberately strict. It is the only thing standing between the
 * model picker and a hand-edited or mirrored catalog, so unknown keys are
 * rejected and every download is pinned by SHA-256.
 */

/** ISO 3166-1 alpha-2 country code of the publishing organisation, e.g. `US`. */
export const OriginCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Origin must be an ISO 3166-1 alpha-2 country code, e.g. "US"')
export type OriginCode = z.infer<typeof OriginCodeSchema>

export const ModelKindSchema = z.enum(['stt', 'polish'])
export type ModelKind = z.infer<typeof ModelKindSchema>

/**
 * Which runtime loads the model (PLAN §6.1, §7.1).
 *
 * `onnx-runtime` is `onnxruntime-node` in the STT utility process (Parakeet,
 * Moonshine); `whisper-cpp` and `llama-cpp` are the loopback HTTP sidecars.
 */
export const ModelEngineSchema = z.enum(['whisper-cpp', 'onnx-runtime', 'llama-cpp'])
export type ModelEngine = z.infer<typeof ModelEngineSchema>

export const ModelFileSchema = z
  .object({
    url: z.url(),
    /** Lowercase hex SHA-256; downloads that do not match are discarded. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'),
    bytes: z.number().int().positive(),
    /** Name to store the file under; must not contain path separators. */
    filename: z
      .string()
      .min(1)
      .refine((v) => !v.includes('/') && !v.includes('\\') && v !== '.' && v !== '..', {
        error: 'filename must be a bare file name, not a path',
      }),
  })
  .strict()
export type ModelFile = z.infer<typeof ModelFileSchema>

export const ModelEntrySchema = z
  .object({
    id: z.string().min(1),
    kind: ModelKindSchema,
    engine: ModelEngineSchema,
    displayName: z.string().min(1),
    /** Publishing organisation, e.g. "NVIDIA". */
    org: z.string().min(1),
    origin: OriginCodeSchema,
    /** SPDX id where one exists, otherwise the licence's common name. */
    license: z.string().min(1),
    /** Total on-disk size of all `files`. */
    sizeBytes: z.number().int().positive(),
    /** Physical RAM this model wants, in GiB — drives the hardware advisor. */
    ramTierGb: z.number().positive(),
    /** BCP-47-ish tags, or `["multi"]` for broadly multilingual models. */
    languages: z.array(z.string().min(1)).min(1),
    /** Quantisation label, e.g. `q5_0`, `int8`, `fp16`. */
    quant: z.string().min(1),
    files: z.array(ModelFileSchema).min(1),
    recommended: z.boolean().optional(),
    notes: z.string().optional(),
  })
  .strict()
export type ModelEntry = z.infer<typeof ModelEntrySchema>

export const ModelCatalogSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    updatedAt: z.iso.datetime(),
    /**
     * Allowlist of permitted model origins. Enforced at load time by
     * `validateCatalog`, not merely advisory (PLAN §8).
     */
    originPolicy: z.array(OriginCodeSchema).min(1),
    models: z.array(ModelEntrySchema),
  })
  .strict()
export type ModelCatalog = z.infer<typeof ModelCatalogSchema>

/**
 * A model the user supplied themselves (file import or HF repo id). These
 * bypass the catalog by definition and are surfaced as origin-unverified
 * (PLAN §8 "Custom models").
 */
export const ImportedModelSchema = z.object({
  id: z.string().min(1),
  kind: ModelKindSchema,
  engine: ModelEngineSchema,
  displayName: z.string().min(1),
  /** Absolute path of the imported file or bundle directory. */
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  origin: z.literal('unverified'),
})
export type ImportedModel = z.infer<typeof ImportedModelSchema>

/** A model present on disk, from either source. */
export const InstalledModelSchema = z.object({
  modelId: z.string().min(1),
  kind: ModelKindSchema,
  engine: ModelEngineSchema,
  /** Directory holding the model's files. */
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  /** Epoch milliseconds. */
  installedAt: z.number().int().nonnegative(),
  source: z.enum(['catalog', 'import']),
})
export type InstalledModel = z.infer<typeof InstalledModelSchema>

export const ModelDownloadProgressSchema = z.object({
  downloadId: z.string().min(1),
  modelId: z.string().min(1),
  receivedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  status: z.enum(['queued', 'downloading', 'verifying', 'complete', 'cancelled', 'error']),
  message: z.string().nullable().default(null),
})
export type ModelDownloadProgress = z.infer<typeof ModelDownloadProgressSchema>
