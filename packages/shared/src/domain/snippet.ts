import { z } from 'zod'

/**
 * Snippets (PLAN §2.2.2) — say a short phrase, get a stored block of text.
 *
 * Distinct from the Dictionary, which is next door and looks similar. The
 * Dictionary fixes *recognition*: it steers the decoder toward a spelling and
 * swaps one word for another of roughly the same size. A snippet is an
 * *expansion*: three spoken words become a calendar link, a postal address, or
 * a paragraph of boilerplate. The two want different UI, different validation
 * (an expansion may be long and multi-line; a dictionary replacement may not)
 * and — crucially — a different place in the pipeline.
 *
 * ## Where expansion runs, and why it is last
 *
 * After polishing, immediately before insertion, alongside the trailing-period
 * rule. A snippet's whole value is that the text comes out *exactly* as stored,
 * and a 1B model asked to tidy a URL, an account number or an address will
 * eventually reformat one. Expanding before the model would hand it precisely
 * the content it must not touch.
 *
 * The cost of that choice is that the trigger is matched against polished text
 * rather than the raw transcript, so it has to tolerate the capitalisation and
 * punctuation the model adds — hence the matcher below. At Rewrite level the
 * model may reword a trigger phrase entirely, in which case the snippet does
 * not fire; that is a miss, not a corruption, and a miss is the failure we
 * would rather have.
 */

export const SnippetSchema = z.object({
  id: z.string().min(1),
  /** The spoken phrase, e.g. "my calendar link". Matched case-insensitively. */
  trigger: z.string().min(1).max(120),
  /** What it expands to. Multi-line is fine — an address, a standard reply. */
  expansion: z.string().min(1).max(4000),
  enabled: z.boolean(),
})
export type Snippet = z.infer<typeof SnippetSchema>

/** Fields accepted when creating a snippet; the store assigns the id. */
export const SnippetDraftSchema = SnippetSchema.omit({ id: true }).extend({
  enabled: z.boolean().default(true),
})
export type SnippetDraft = z.infer<typeof SnippetDraftSchema>

/** Sparse update to an existing snippet. */
export const SnippetPatchSchema = z
  .object({
    trigger: z.string().min(1).max(120),
    expansion: z.string().min(1).max(4000),
    enabled: z.boolean(),
  })
  .partial()
export type SnippetPatch = z.infer<typeof SnippetPatchSchema>

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Build the matcher for one trigger.
 *
 * Three tolerances, each earned from what the polish model does to a spoken
 * phrase on its way here:
 *
 *  - **case**, because the model capitalises a trigger that opens a sentence;
 *  - **whitespace between words**, because it may join or split around them;
 *  - **word boundaries at both ends**, so "my calendar link" does not fire
 *    inside "my calendar linkage".
 *
 * Boundaries are written as lookarounds on letters and digits rather than `\b`,
 * which would fail on a trigger ending in punctuation.
 */
function triggerPattern(trigger: string): RegExp {
  const words = trigger.trim().split(/\s+/).map(escapeRegExp)
  return new RegExp(`(?<![\\p{L}\\p{N}])${words.join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu')
}

/**
 * Expand every enabled snippet in `text`.
 *
 * Longest trigger first, so a specific phrase wins over a shorter one it
 * contains ("my work address" is not consumed by "my address"). Each pass runs
 * over the output of the last, but an expansion is never re-scanned for
 * further triggers — a snippet whose expansion contains another's trigger
 * would otherwise expand forever.
 */
export function expandSnippets(text: string, snippets: readonly Snippet[]): string {
  return expandSnippetsWithCount(text, snippets).text
}

/**
 * The same expansion, reporting how many triggers actually fired.
 *
 * Counted here rather than inferred by the caller because only this function
 * can tell an expansion from a coincidence: comparing lengths before and after
 * would miss a snippet that expands to something shorter than its trigger, and
 * would count a polish-level rewrite as an expansion.
 */
export function expandSnippetsWithCount(
  text: string,
  snippets: readonly Snippet[],
): { text: string; expansions: number } {
  const active = snippets
    .filter((snippet) => snippet.enabled)
    .sort((a, b) => b.trigger.length - a.trigger.length)
  if (active.length === 0) return { text, expansions: 0 }

  // Expansions are held aside as placeholders while the remaining triggers are
  // matched, then restored at the end. Without this, snippet B's trigger could
  // match text that snippet A just inserted.
  //
  // NUL-delimited rather than something readable, because the placeholder has
  // to be a sequence that cannot occur in a transcript. A readable choice like
  // " 0 " would also match the ordinary number in "I have 3 things" and
  // silently delete it; NUL survives no speech-to-text path.
  const held: string[] = []
  let out = text

  for (const snippet of active) {
    out = out.replace(triggerPattern(snippet.trigger), () => {
      held.push(snippet.expansion)
      return `\u0000${held.length - 1}\u0000`
    })
  }

  const restored = out.replace(PLACEHOLDER, (_match, index: string) => held[Number(index)] ?? '')

  // One entry was pushed per substitution, so `held.length` is the count of
  // triggers that fired, by construction.
  return { text: restored, expansions: held.length }
}

/**
 * Matches the placeholders written above.
 *
 * A module constant rather than an inline literal only so the lint exemption
 * has somewhere stable to live: prettier reflows a long `.replace(...)` call
 * across lines, which moves the regex off the line the directive applies to.
 * The control character itself is the whole point of the design, and is
 * explained where the placeholders are written.
 */
// eslint-disable-next-line no-control-regex -- the NUL is deliberate: the placeholder must be a sequence no transcript can contain.
const PLACEHOLDER = /\u0000(\d+)\u0000/g
