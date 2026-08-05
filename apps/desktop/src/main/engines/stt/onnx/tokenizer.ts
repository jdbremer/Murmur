/**
 * Token ids → text, for the ONNX Runtime STT path.
 *
 * Only *de*tokenisation is implemented: the STT loops never encode text, so the
 * merge table and the pre-tokeniser are irrelevant here, and pulling in a full
 * tokenizer library for a 60-line reverse lookup would be a poor trade.
 *
 * ## What the models actually ship
 *
 * Moonshine's `tokenizer.json` is a SentencePiece-style BPE whose `decoder` is
 * a four-step sequence — checked against the real file, not assumed:
 *
 * ```json
 * {"type":"Sequence","decoders":[
 *   {"type":"Replace","pattern":{"String":"▁"},"content":" "},
 *   {"type":"ByteFallback"},
 *   {"type":"Fuse"},
 *   {"type":"Strip","content":" ","start":1,"stop":0}]}
 * ```
 *
 * So: metaspace `▁` means "space", `<0xNN>` tokens are raw bytes that must be
 * fused and UTF-8 decoded *together* (a two-byte character arrives as two
 * tokens), everything is concatenated, and one leading space is stripped.
 * {@link decodeTokens} implements exactly that pipeline.
 *
 * NeMo/Parakeet vocabularies are also SentencePiece with `▁`, and ship as a
 * plain `vocab.txt` (one piece per line, id = line number). Both shapes load
 * through {@link loadTokenizer}.
 */

const METASPACE = '▁'
const BYTE_TOKEN = /^<0x([0-9A-Fa-f]{2})>$/

export interface Tokenizer {
  /** id → piece. Sparse ids are simply absent. */
  readonly pieces: ReadonlyMap<number, string>
  /** Ids that must never appear in output text (`<s>`, `</s>`, `<unk>`, …). */
  readonly specialIds: ReadonlySet<number>
  readonly size: number
}

/** Shape of the parts of `tokenizer.json` this module reads. */
interface HfTokenizerFile {
  model?: { vocab?: Record<string, number> | [string, number][] }
  added_tokens?: { id: number; content: string; special?: boolean }[]
}

/**
 * Build a tokenizer from a parsed HuggingFace `tokenizer.json`.
 *
 * @throws when the file has no usable vocabulary, which is worth failing loudly
 *   on: a silently empty tokenizer produces empty transcripts.
 */
export function tokenizerFromHuggingFace(file: unknown): Tokenizer {
  const parsed = file as HfTokenizerFile
  const raw = parsed.model?.vocab
  const pieces = new Map<number, string>()

  if (Array.isArray(raw)) {
    // Unigram-style: [[piece, score], …] with the index as the id.
    raw.forEach((entry, index) => {
      const piece = Array.isArray(entry) ? entry[0] : undefined
      if (typeof piece === 'string') pieces.set(index, piece)
    })
  } else if (raw && typeof raw === 'object') {
    for (const [piece, id] of Object.entries(raw)) {
      if (typeof id === 'number') pieces.set(id, piece)
    }
  }

  if (pieces.size === 0) {
    throw new Error('tokenizer.json contains no vocabulary (model.vocab was empty or unreadable)')
  }

  const specialIds = new Set<number>()
  for (const added of parsed.added_tokens ?? []) {
    if (typeof added.id !== 'number' || typeof added.content !== 'string') continue
    pieces.set(added.id, added.content)
    if (added.special) specialIds.add(added.id)
  }

  return { pieces, specialIds, size: pieces.size }
}

/** Build a tokenizer from a NeMo-style `vocab.txt` (one piece per line). */
export function tokenizerFromVocabText(text: string): Tokenizer {
  const pieces = new Map<number, string>()
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    const piece = line.replace(/\r$/, '')
    // A trailing newline yields one empty final line; a genuine empty piece
    // cannot exist in a SentencePiece vocabulary, so dropping it is safe.
    if (piece === '' && index === lines.length - 1) continue
    pieces.set(index, piece)
  }
  if (pieces.size === 0) throw new Error('vocab.txt was empty')
  return { pieces, specialIds: new Set(), size: pieces.size }
}

/** Pick the right loader from a file name. */
export function loadTokenizer(fileName: string, contents: string): Tokenizer {
  if (fileName.endsWith('.json')) return tokenizerFromHuggingFace(JSON.parse(contents))
  return tokenizerFromVocabText(contents)
}

export interface DecodeOptions {
  /** Drop `<s>`, `</s>` and friends. Default true. */
  skipSpecialTokens?: boolean
  /** Apply the `Strip{content:" ", start:1}` step. Default true. */
  stripLeadingSpace?: boolean
}

/**
 * Token ids → text, implementing Replace(▁→" ") → ByteFallback → Fuse → Strip.
 *
 * Byte tokens are buffered until a non-byte token arrives so a multi-byte
 * character split across several `<0xNN>` tokens decodes as one character
 * rather than as three replacement glyphs.
 */
export function decodeTokens(
  tokenizer: Tokenizer,
  ids: readonly number[],
  options: DecodeOptions = {},
): string {
  const skipSpecial = options.skipSpecialTokens ?? true
  const stripLeading = options.stripLeadingSpace ?? true

  let out = ''
  let byteBuffer: number[] = []

  const flushBytes = (): void => {
    if (byteBuffer.length === 0) return
    out += new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(byteBuffer))
    byteBuffer = []
  }

  for (const id of ids) {
    if (skipSpecial && tokenizer.specialIds.has(id)) continue
    const piece = tokenizer.pieces.get(id)
    if (piece === undefined) continue

    const byteMatch = BYTE_TOKEN.exec(piece)
    if (byteMatch?.[1]) {
      byteBuffer.push(Number.parseInt(byteMatch[1], 16))
      continue
    }

    flushBytes()
    out += piece.replaceAll(METASPACE, ' ')
  }
  flushBytes()

  return stripLeading && out.startsWith(' ') ? out.slice(1) : out
}
