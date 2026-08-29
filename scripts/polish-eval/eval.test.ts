import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, it } from 'vitest'

import {
  buildPolishPrompt,
  checkPolishOutput,
  maxOutputTokens,
  unwrapModelOutput,
} from '../../apps/desktop/src/main/engines/polish/prompt'

/**
 * How well each polish model actually polishes — see README.md for running it.
 *
 * Outside `apps/desktop/test/`, so `npm test` does not pick it up: every case
 * costs a real inference against a real llama-server, which no CI leg has. It
 * lives in the repo anyway because the catalog says its recommended models
 * were "chosen on measured failure rates", and until this existed nothing in
 * the repo could measure one — which is how Granite 4.2 came to be listed for
 * polishing without ever being evaluated at it.
 */

interface Case {
  text: string
}

const cases = (): string[] => {
  const override = process.env['CASES']
  const path = override ?? join(__dirname, 'cases.json')
  if (!existsSync(path)) throw new Error(`no case file at ${path}`)
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as (Case | { raw_text: string })[]
  return parsed.map((entry) => ('text' in entry ? entry.text : entry.raw_text))
}

/** `NAME=port` pairs, e.g. MODELS="4.1=18091,4.2=18092". */
const models = (): [string, number][] =>
  (process.env['MODELS'] ?? '4.1=18091,4.2=18092,gemma=18093')
    .split(',')
    .map((pair) => pair.split('='))
    .map(([name, port]) => [name ?? '?', Number(port)])

const REPS = Number(process.env['REPS'] ?? 1)

it('scores each model on the polish guard', { timeout: 7_200_000 }, async () => {
  const corpus = cases()
  const summary: string[] = []

  for (const [name, port] of models()) {
    const failures = new Map<string, { count: number; last: string }>()
    const scores: number[] = []

    for (let rep = 0; rep < REPS; rep += 1) {
      let kept = 0
      for (const raw of corpus) {
        const built = buildPolishPrompt({
          level: 'rewrite',
          transcript: raw,
          profile: {
            category: 'work',
            formality: 'neutral',
            fillerHandling: 'trim',
            emoji: 'never',
            customInstructions: '',
          },
          dictionary: [],
          extraSpellings: [],
          language: 'en',
        } as never)

        const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'local',
            messages: [
              { role: 'system', content: built.systemPrompt },
              ...built.examples.flatMap((example) => [
                { role: 'user', content: example.user },
                { role: 'assistant', content: example.assistant },
              ]),
              { role: 'user', content: built.userText },
            ],
            temperature: 0.2,
            top_p: 0.9,
            max_tokens: maxOutputTokens(raw) + 32,
            stream: false,
            reasoning_effort: 'none',
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: AbortSignal.timeout(180_000),
        })
        const payload = (await response.json()) as {
          choices?: { message?: { content?: string } }[]
        }
        const text = unwrapModelOutput(payload.choices?.[0]?.message?.content ?? '', raw)
        const verdict = checkPolishOutput(raw, text)
        if (verdict.ok) kept += 1
        else {
          const seen = failures.get(raw)
          failures.set(raw, {
            count: (seen?.count ?? 0) + 1,
            last: `${verdict.reason}: ${JSON.stringify(text.slice(0, 140))}`,
          })
        }
      }
      scores.push(kept)
    }

    summary.push(`  ${name.padEnd(8)} ${scores.map((s) => `${s}/${corpus.length}`).join('  ')}`)
    if (failures.size > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `\n  ${name} failures:\n` +
          [...failures.entries()]
            .sort((a, b) => b[1].count - a[1].count)
            .map(([raw, f]) => `    [${f.count}/${REPS}] ${raw.slice(0, 78)}\n        ${f.last}`)
            .join('\n'),
      )
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n===== kept, per repetition (${corpus.length} utterances) =====\n${summary.join('\n')}`,
  )
  expect(summary.length).toBeGreaterThan(0)
})
