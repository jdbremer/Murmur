/**
 * The narrow slice of ONNX Runtime the decode loops actually use.
 *
 * `onnxruntime-node` is an **optional** dependency: it ships prebuilt binaries
 * per platform and its postinstall reaches the network, so a Linux dev
 * container (and any restricted CI leg) can legitimately end up without it.
 * Every decode loop in this directory is therefore written against these
 * interfaces rather than against `ort.InferenceSession`, which buys two things:
 *
 *  1. the loops unit-test against a hand-written fake session that returns
 *     synthetic logits — no model files, no runtime, no network; and
 *  2. the engine can report `unavailable(runtime-missing)` cleanly instead of
 *     crashing at import time.
 *
 * The shapes match `onnxruntime-common`'s exactly, so the real `InferenceSession`
 * satisfies `InferenceSessionLike` structurally with no adapter.
 */

/** Element types the loops need. ORT has more; we deliberately do not. */
export type TensorData = Float32Array | Int32Array | BigInt64Array | Uint8Array

export interface TensorLike {
  readonly type: string
  readonly data: TensorData
  readonly dims: readonly number[]
}

export type Feeds = Record<string, TensorLike>
export type Fetches = Record<string, TensorLike>

export interface InferenceSessionLike {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(feeds: Feeds): Promise<Fetches>
  release?(): Promise<void>
}

/**
 * Creates tensors. Injected for the same reason the session is: a test can
 * build tensors without ORT, and the real factory is a one-line wrapper over
 * `new ort.Tensor(...)`.
 */
export interface TensorFactory {
  float32(data: Float32Array, dims: readonly number[]): TensorLike
  int64(data: BigInt64Array, dims: readonly number[]): TensorLike
  int32(data: Int32Array, dims: readonly number[]): TensorLike
  bool(data: Uint8Array, dims: readonly number[]): TensorLike
}

/** A tensor factory backed by plain objects — the one tests use. */
export function createPlainTensorFactory(): TensorFactory {
  return {
    float32: (data, dims) => ({ type: 'float32', data, dims }),
    int64: (data, dims) => ({ type: 'int64', data, dims }),
    int32: (data, dims) => ({ type: 'int32', data, dims }),
    bool: (data, dims) => ({ type: 'bool', data, dims }),
  }
}

// ---------------------------------------------------------------------------
// Tensor helpers
// ---------------------------------------------------------------------------

/** Total element count implied by `dims`. */
export function elementCount(dims: readonly number[]): number {
  return dims.reduce((product, dimension) => product * dimension, 1)
}

/**
 * Read a tensor's contents as `Float32Array`, whatever integer type it arrived
 * as. Cheap when it is already float32 (no copy).
 */
export function asFloat32(tensor: TensorLike): Float32Array {
  const { data } = tensor
  if (data instanceof Float32Array) return data
  const out = new Float32Array(data.length)
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index]
    out[index] = typeof value === 'bigint' ? Number(value) : (value ?? 0)
  }
  return out
}

/**
 * `argmax` over `[offset, offset + length)`.
 *
 * Ties resolve to the lowest index, which matches NumPy/PyTorch and therefore
 * matches the reference decoders we validate against.
 */
export function argmax(values: Float32Array, offset = 0, length = values.length - offset): number {
  let bestIndex = 0
  let bestValue = Number.NEGATIVE_INFINITY
  for (let index = 0; index < length; index += 1) {
    const value = values[offset + index] ?? Number.NEGATIVE_INFINITY
    if (value > bestValue) {
      bestValue = value
      bestIndex = index
    }
  }
  return bestIndex
}

/** Natural log of the softmax value at `index`, computed stably. */
export function logSoftmaxAt(
  values: Float32Array,
  index: number,
  offset = 0,
  length = values.length - offset,
): number {
  let max = Number.NEGATIVE_INFINITY
  for (let i = 0; i < length; i += 1) {
    const value = values[offset + i] ?? Number.NEGATIVE_INFINITY
    if (value > max) max = value
  }
  let sum = 0
  for (let i = 0; i < length; i += 1) sum += Math.exp((values[offset + i] ?? 0) - max)
  return (values[offset + index] ?? 0) - max - Math.log(sum)
}

/** One row of a `[batch, steps, features]` tensor, copied out. */
export function sliceStep(
  tensor: TensorLike,
  step: number,
  { batch = 0 }: { batch?: number } = {},
): Float32Array {
  const [batchSize = 1, steps = 1, features = 1] = tensor.dims
  if (step < 0 || step >= steps) {
    throw new RangeError(`step ${step} out of range for dims [${tensor.dims.join(', ')}]`)
  }
  if (batch < 0 || batch >= batchSize) {
    throw new RangeError(`batch ${batch} out of range for dims [${tensor.dims.join(', ')}]`)
  }
  const values = asFloat32(tensor)
  const start = (batch * steps + step) * features
  return values.slice(start, start + features)
}
