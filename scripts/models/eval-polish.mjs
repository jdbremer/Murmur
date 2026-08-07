// Does the polish model edit the transcript, or answer it? (PLAN §7.4, §13.4)
//
// The failure this measures is not hypothetical: a user dictating about fixing
// a spec had "I understand. Let's focus on preserving the original
// specification…" inserted over their words by Gemma 3 1B. Instruction-following
// is the whole job of a polish model, and it is the thing that degrades fastest
// as the model gets smaller — so which model we default to on an 8 GB machine
// is a question that should be answered with numbers.
//
// Run it against any two GGUFs:
//
//   node scripts/models/eval-polish.mjs --a <model-a.gguf> --b <model-b.gguf>
//
// It uses the *production* prompt (bundled straight from the app's own
// prompt.ts), the production sampling settings, and the production guard, so a
// pass here means the same thing it means at runtime.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)))

function arg(flag) {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : null
}

const MODEL_A = arg('--a')
const MODEL_B = arg('--b')
if (!MODEL_A || !MODEL_B) {
  console.error('usage: node scripts/models/eval-polish.mjs --a <a.gguf> --b <b.gguf>')
  process.exit(2)
}

// Bundle the app's own prompt builder and guard, so this cannot drift from what
// ships. Re-bundled per run rather than checked in for the same reason.
const work = mkdtempSync(join(tmpdir(), 'murmur-eval-'))
writeFileSync(
  join(work, 'entry.ts'),
  `export { buildPolishPrompt, checkPolishOutput } from ${JSON.stringify(
    join(repo, 'apps/desktop/src/main/engines/polish/prompt'),
  )}\n`,
)
execFileSync(
  'npx',
  [
    'esbuild',
    join(work, 'entry.ts'),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    `--outfile=${join(work, 'prompt.cjs')}`,
    '--log-level=error',
  ],
  { cwd: repo, stdio: 'inherit' },
)
const { buildPolishPrompt, checkPolishOutput } = require(join(work, 'prompt.cjs'))

const PROFILE = {
  category: 'work',
  formality: 'neutral',
  fillerHandling: 'remove',
  emoji: 'never',
  customInstructions: '',
}

// `temptation`: the utterance invites a reply. The model must still just edit it.
// `control`: ordinary dictation. Must survive untouched-ish — measures whether a
// model is so cautious it stops polishing.
const CASES = [
  {
    kind: 'temptation',
    text: 'can you fix the spec so that it preserves the original behaviour and we only make the minimal changes needed',
  },
  { kind: 'temptation', text: 'what time is the standup tomorrow morning' },
  {
    kind: 'temptation',
    text: 'hey could you summarize what we discussed in the meeting yesterday',
  },
  { kind: 'temptation', text: 'i need you to write me a function that parses the config file' },
  {
    kind: 'temptation',
    text: 'what do you think about shipping this on wednesday instead of friday',
  },
  {
    kind: 'temptation',
    text: 'please review the pull request and let me know if anything looks wrong',
  },
  {
    kind: 'temptation',
    text: 'how should we handle the case where the user has no models installed',
  },
  {
    kind: 'temptation',
    text: 'explain to me why the deploy keeps failing on the certificate step',
  },
  { kind: 'control', text: 'um so basically we should uh ship it on on tuesday no wednesday' },
  {
    kind: 'control',
    text: 'hey hey hey let me know i think this is gonna work just fine let me know',
  },
  {
    kind: 'control',
    text: 'the deploy failed again because the certificate expired and nobody renewed it',
  },
  { kind: 'control', text: 'first i want to check the logs second i want to analyze them' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withServer(modelPath, port, fn) {
  const proc = spawn(
    join(repo, '.sidecars/bin/llama-server'),
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--model',
      modelPath,
      '--ctx-size',
      '4096',
      '--threads',
      '4',
      '--n-gpu-layers',
      '999',
      '--parallel',
      '1',
    ],
    { stdio: 'ignore' },
  )
  try {
    for (let i = 0; i < 120; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break
      } catch {}
      await sleep(1000)
    }
    return await fn()
  } finally {
    proc.kill('SIGKILL')
    await sleep(1500)
  }
}

async function polish(port, text) {
  const built = buildPolishPrompt({
    level: 'clean',
    profile: PROFILE,
    dictionary: [],
    language: 'auto',
  })
  const messages = [{ role: 'system', content: built.systemPrompt }]
  for (const ex of built.examples) {
    messages.push({ role: 'user', content: ex.user }, { role: 'assistant', content: ex.assistant })
  }
  messages.push({ role: 'user', content: text })
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      messages,
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: Math.max(64, Math.round(text.length * 2.5)),
    }),
  })
  const json = await res.json()
  return (json.choices?.[0]?.message?.content ?? '').trim()
}

const results = {}
for (const [name, path, port] of [
  [MODEL_A.split('/').pop(), MODEL_A, 8131],
  [MODEL_B.split('/').pop(), MODEL_B, 8132],
]) {
  process.stderr.write(`\n=== ${name} ===\n`)
  results[name] = await withServer(path, port, async () => {
    const rows = []
    for (const c of CASES) {
      const out = await polish(port, c.text)
      const verdict = checkPolishOutput(c.text, out)
      rows.push({ ...c, out, ok: verdict.ok, reason: verdict.ok ? null : verdict.reason })
      process.stderr.write(
        `  ${verdict.ok ? 'kept   ' : 'REJECT '} [${c.kind}] ${out.slice(0, 80)}\n`,
      )
    }
    return rows
  })
}

console.log('\n\n================ SUMMARY ================')
for (const [name, rows] of Object.entries(results)) {
  const t = rows.filter((r) => r.kind === 'temptation')
  const c = rows.filter((r) => r.kind === 'control')
  console.log(`\n${name}`)
  console.log(
    `  temptation cases rejected by the guard: ${t.filter((r) => !r.ok).length}/${t.length}`,
  )
  console.log(
    `  control cases rejected (false alarms):  ${c.filter((r) => !r.ok).length}/${c.length}`,
  )
  for (const r of rows.filter((x) => !x.ok)) {
    console.log(`   - [${r.kind}/${r.reason}] "${r.text.slice(0, 45)}…" -> "${r.out.slice(0, 90)}"`)
  }
}
writeFileSync(join(work, 'eval-results.json'), JSON.stringify(results, null, 2))
console.log(`\nfull outputs: ${join(work, 'eval-results.json')}`)
