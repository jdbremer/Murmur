import type { Tokenizer } from './tokenizer'

/**
 * Greedy CTC decoding, and the byte-level detokenisation Granite needs.
 *
 * CTC is why this is so much shorter than `tdt-decode.ts`. A transducer runs
 * the prediction network once per emitted symbol and has to carry LSTM state
 * and duration skips through the loop; a CTC model emits one distribution per
 * frame independently, so the whole decode is: take the best token per frame,
 * collapse runs, drop the blank. No state, no second graph, no loop over the
 * vocabulary.
 */

/** Granite reserves id 0 for `<|blank|>`; the vocab confirms it. */
export const CTC_BLANK_ID = 0

/**
 * Best token per frame, runs collapsed, blanks removed.
 *
 * The two steps are ordered and not interchangeable: collapsing *before*
 * dropping blanks is what lets the model spell a real double letter. "ll"
 * arrives as `l, blank, l`, and the blank between them is the only thing
 * separating it from a single `l` held over two frames.
 */
export function decodeCtcGreedy(
  logits: Float32Array,
  frames: number,
  vocabSize: number,
  blankId: number = CTC_BLANK_ID,
): number[] {
  const out: number[] = []
  let previous = -1

  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * vocabSize
    let best = 0
    let bestScore = Number.NEGATIVE_INFINITY
    for (let token = 0; token < vocabSize; token += 1) {
      const score = logits[offset + token] ?? Number.NEGATIVE_INFINITY
      if (score > bestScore) {
        bestScore = score
        best = token
      }
    }

    if (best !== previous && best !== blankId) out.push(best)
    previous = best
  }

  return out
}

/**
 * Mean log-probability of the chosen tokens — the confidence signal the rest of
 * the pipeline already speaks (`avgLogProb`, as whisper.cpp reports it).
 *
 * Computed with a log-sum-exp per frame rather than by softmaxing the whole
 * 16,384-wide distribution, which would allocate a second copy of the logits
 * for every frame and be thrown away immediately.
 *
 * Blank frames are included deliberately: a model that is confidently silent is
 * confident, and excluding them makes a mostly-empty clip look certain because
 * the two frames that did emit happened to be clear.
 */
export function ctcAverageLogProb(
  logits: Float32Array,
  frames: number,
  vocabSize: number,
): number | null {
  if (frames === 0 || vocabSize === 0) return null

  let total = 0
  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * vocabSize
    let max = Number.NEGATIVE_INFINITY
    for (let token = 0; token < vocabSize; token += 1) {
      const score = logits[offset + token] ?? Number.NEGATIVE_INFINITY
      if (score > max) max = score
    }
    let sum = 0
    for (let token = 0; token < vocabSize; token += 1) {
      sum += Math.exp((logits[offset + token] ?? Number.NEGATIVE_INFINITY) - max)
    }
    // log p(best) = max - log Σ exp(x - max) - max  ⇒  -log Σ exp(x - max).
    total += -Math.log(sum)
  }

  return total / frames
}

/**
 * GPT-2's byte↔character table, inverted.
 *
 * Byte-level BPE cannot put raw bytes in a JSON vocabulary, so every byte is
 * mapped to a printable code point first: the printable ASCII and Latin-1
 * ranges stand for themselves, and the remaining 68 bytes are lifted into
 * U+0100 and up. That is why a space appears as `Ġ` and a newline as `Ċ`.
 * Decoding is the reverse — map characters back to bytes, then read the bytes
 * as UTF-8, which is what lets a multi-byte character span two tokens.
 */
function byteDecoder(): Map<number, number> {
  const bytes: number[] = []
  const add = (from: number, to: number): void => {
    for (let code = from; code <= to; code += 1) bytes.push(code)
  }
  add(0x21, 0x7e)
  add(0xa1, 0xac)
  add(0xae, 0xff)

  const codes = [...bytes]
  let next = 0
  for (let byte = 0; byte < 256; byte += 1) {
    if (bytes.includes(byte)) continue
    bytes.push(byte)
    codes.push(256 + next)
    next += 1
  }

  const table = new Map<number, number>()
  for (let index = 0; index < bytes.length; index += 1) {
    table.set(codes[index] ?? 0, bytes[index] ?? 0)
  }
  return table
}

/** Built once — the table is fixed and building it per utterance is waste. */
const BYTE_DECODER = byteDecoder()

/**
 * Token ids to text, for a byte-level BPE vocabulary.
 *
 * Unmapped characters pass through as themselves rather than being dropped: a
 * vocabulary entry outside the byte table is a sign the tokenizer is not
 * byte-level at all, and silently deleting the text would hide that behind a
 * transcript that merely looks a bit wrong.
 */
export function decodeByteLevelTokens(ids: readonly number[], tokenizer: Tokenizer): string {
  const bytes: number[] = []
  const passthrough: string[] = []

  for (const id of ids) {
    if (tokenizer.specialIds.has(id)) continue
    const piece = tokenizer.pieces.get(id)
    if (piece === undefined) continue

    for (const character of piece) {
      const code = character.codePointAt(0) ?? 0
      const byte = BYTE_DECODER.get(code)
      if (byte === undefined) {
        passthrough.push(character)
        continue
      }
      bytes.push(byte)
    }
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes))
  return (text + passthrough.join('')).trim()
}
