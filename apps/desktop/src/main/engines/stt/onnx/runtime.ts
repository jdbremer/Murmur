import type { InferenceSessionLike, TensorFactory, TensorLike } from './session'

/**
 * Dynamic loader for `onnxruntime-node` (PLAN §6.1, §11.1).
 *
 * The package is an **optionalDependency** for a concrete reason: its
 * postinstall downloads platform-specific native binaries, and in restricted
 * environments (this project's Linux dev container, an air-gapped CI leg) that
 * step fails. npm then skips the package entirely, which must be a *status*,
 * not a crash — so nothing in the app may `import 'onnxruntime-node'` at module
 * scope. Everything goes through {@link loadOnnxRuntime}, which requires it
 * lazily and reports failure as data.
 *
 * On macOS CI and in shipped builds the package is present and this is a
 * one-time `require` behind a cached promise.
 */

export type OnnxRuntimeLoad =
  | { ok: true; createSession: SessionFactory; tensors: TensorFactory; version: string }
  | { ok: false; reason: 'runtime-missing'; detail: string }

export type SessionFactory = (
  path: string,
  options?: { intraOpNumThreads?: number },
) => Promise<InferenceSessionLike>

/** Minimal structural view of the bits of `onnxruntime-node` we touch. */
interface OrtModule {
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<InferenceSessionLike>
  }
  Tensor: new (type: string, data: unknown, dims: readonly number[]) => TensorLike
  env?: { versions?: { common?: string } }
}

let cached: OnnxRuntimeLoad | null = null

export function loadOnnxRuntime(): OnnxRuntimeLoad {
  if (cached) return cached
  cached = attemptLoad()
  return cached
}

function attemptLoad(): OnnxRuntimeLoad {
  let ort: OrtModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ort = require('onnxruntime-node') as OrtModule
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      reason: 'runtime-missing',
      detail:
        `onnxruntime-node is not installed for this platform, so ONNX models cannot run ` +
        `(${message}). Whisper models are unaffected — they use the whisper.cpp sidecar.`,
    }
  }

  const tensors: TensorFactory = {
    float32: (data, dims) => new ort.Tensor('float32', data, dims),
    int64: (data, dims) => new ort.Tensor('int64', data, dims),
    int32: (data, dims) => new ort.Tensor('int32', data, dims),
    bool: (data, dims) => new ort.Tensor('bool', data, dims),
  }

  const createSession: SessionFactory = (path, options = {}) =>
    ort.InferenceSession.create(path, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      // Conservative: leave cores for the polish model and the UI. ONNX int8 is
      // real-time on a single core for these model sizes (PLAN §6.1).
      intraOpNumThreads: options.intraOpNumThreads ?? 2,
    })

  return {
    ok: true,
    createSession,
    tensors,
    version: ort.env?.versions?.common ?? 'unknown',
  }
}

/** Reset the cache. Tests only. */
export function resetOnnxRuntimeCache(): void {
  cached = null
}
