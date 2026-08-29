# Polish eval

Scores each polish model on the same utterances, through the real prompt, the
real unwrapping, and the real hallucination guard — so "this model polishes
better than that one" is a number rather than an impression.

It exists because the catalog says its recommended models were chosen on
measured failure rates, and for a while nothing here could measure one. Granite
4.2 was listed for polishing on the strength of being newer than 4.1, and
turned out to keep 23 of 34 utterances where 4.1 kept 33.

## Running it

Start one `llama-server` per model you want to compare, each on its own port:

```bash
MODELS="$HOME/Library/Application Support/Murmur/models"
./.sidecars/bin/llama-server --host 127.0.0.1 --port 18091 --n-gpu-layers 999 \
  --ctx-size 4096 --parallel 1 --no-webui \
  --model "$MODELS/granite-4.1-3b-instruct-q4_k_m/granite-4.1-3b-Q4_K_M.gguf"
```

Then:

```bash
REPS=3 npx vitest run scripts/polish-eval/eval.test.ts --reporter=verbose
```

`MODELS` overrides the name/port pairs (default
`4.1=18091,4.2=18092,gemma=18093`); `REPS` sets repetitions.

## Repetitions are not optional

Sampling runs at temperature 0.2, and one pass is not a measurement. A single
run of Granite 4.2 scored 22/34 and the very next scored 26/34 — a gap wide
enough to have shipped the opposite conclusion. Three runs, and read the spread
rather than the best number.

## Cases

`cases.json` holds utterances shaped like the ones that break polish models:
questions, instructions addressed to a listener, sentence fragments. Every one
is written for this file. **Do not commit real dictations** — they are personal
speech, and this repository is public.

To measure against your own archive instead, export it locally and point
`CASES` at the file. It stays on your machine:

```bash
sqlite3 -json "file:$HOME/Library/Application Support/Murmur/murmur.db?mode=ro" \
  "SELECT raw_text FROM dictations
   WHERE (length(raw_text)-length(replace(raw_text,' ','')))+1 BETWEEN 5 AND 60
   GROUP BY raw_text ORDER BY ts DESC LIMIT 60;" > /tmp/my-cases.json

CASES=/tmp/my-cases.json REPS=3 npx vitest run scripts/polish-eval/eval.test.ts --reporter=verbose
```

Tune against one half of your archive and confirm on the other. The
post-processing in `prompt.ts` reached 34/34 on the set it was written against
and 37/40 on a disjoint set from the same speaker; without that second number
the first one only says the patterns matched the examples they came from.
