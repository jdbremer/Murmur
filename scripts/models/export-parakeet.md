# Exporting Parakeet-TDT to ONNX, first-party

**Status: not shipped.** `resources/catalog/models.json` deliberately contains no
Parakeet entry. This document is the plan for adding one honestly.

## Why Parakeet is not in the catalog

PLAN §6.2 lists **Parakeet-TDT 0.6B** as the recommended default STT model:
NVIDIA, US-origin, CC-BY-4.0, and the fastest high-accuracy option on the list.
PLAN §8 also says every catalog entry is pinned by SHA-256 to a URL we have
verified, and PLAN §10 stakes the product on a supply chain an IT team can
audit at a glance.

Those two commitments collide:

- NVIDIA publishes Parakeet as **`.nemo` checkpoints** (`nvidia/parakeet-tdt-0.6b-v3`
  and `-v2`), not as ONNX. The `.nemo` archive is a NeMo-specific bundle that
  `onnxruntime-node` cannot load.
- The ONNX exports that exist on Hugging Face are **community conversions**.
  They are usually fine. But "usually fine" is not a provenance story, and a
  catalog whose whole point is auditable origin cannot list a re-upload by an
  account with no relationship to NVIDIA and call it an NVIDIA model.

So the rule we applied: **we do the export ourselves, verify it against NVIDIA's
own reference transcripts, and host the result.** Until that has happened, the
entry stays out and Whisper large-v3-turbo is the recommended STT default.

Everything else is already in place. `apps/desktop/src/main/engines/stt/onnx/`
contains the log-mel featurizer with NeMo's constants, the TDT greedy decode
loop with its duration-skip semantics, and the SentencePiece detokeniser — all
unit-tested against synthetic logits. What is missing is the model files and the
fixture-based validation, not the code.

## The export — no longer needs NeMo

NVIDIA now publishes the same weights in `transformers` format
(`model.safetensors` plus a `ParakeetForTDT` architecture) alongside the
`.nemo` bundle, so the export runs from `transformers` and `torch` alone. Same
weights, same provenance, a fraction of the toolchain. **This has now been
run.**

```bash
python3.12 -m venv .venv-parakeet && source .venv-parakeet/bin/activate
pip install torch transformers onnx onnxruntime onnxscript librosa

python3 scripts/models/export_parakeet.py \
  --model nvidia/parakeet-tdt-0.6b-v3 \
  --out   build/parakeet-tdt-0.6b-v3-onnx
```

Two things bite, both recorded in the script:

- **Use the TorchScript exporter (`dynamo=False`).** The dynamo path cannot
  decompose the Conformer attention's `reshape(*input_shape, -1)` once the frame
  count is symbolic, and variable-length audio is the entire point.
- **fp32 exceeds protobuf's 2 GB limit**, so the encoder spills its weights into
  ~300 external tensor files. Before anything is hosted this needs consolidating
  (`all_tensors_to_one_file=True`) and quantising to int8, which is what the
  catalog entry claims and what gets the download down to a sane size.

### What the run confirmed

Everything the decode loop assumes is true of the shipped v3 checkpoint:
`durations = [0, 1, 2, 3, 4]` exactly as `PARAKEET_DURATIONS`,
`max_symbols_per_step = 10`, blank at id 8192, and a joint head of width
8198 = 8193 + 5, which is the `V + 1 + D` the loop expects.

That produces the three graphs a transducer needs:

| File                 | Shape                                                       |
| -------------------- | ----------------------------------------------------------- |
| `encoder-model.onnx` | `[B, 80, T]` log-mel → `[B, T', D]` encoder states          |
| `decoder-model.onnx` | prediction network: `(targets, lengths, state) → [B, 1, D]` |
| `joiner-model.onnx`  | `(enc_step, dec_step) → [B, V + 1 + len(durations)]` logits |

plus `vocab.txt` (one SentencePiece piece per line, id = line number) and a
small `config.json` recording `vocab_size`, the duration bins, and the mel
front-end parameters the featurizer must match.

## Validation — the part that actually matters

PLAN §16 names "in-house Parakeet decode loop subtly wrong" as a medium risk,
and the mitigation is golden fixtures against NVIDIA reference transcripts. A
wrong decode loop does not crash; it quietly drops the last word of every
utterance, or duplicates tokens on frames where the duration head predicts zero.

Before an entry goes in the catalog:

1. **Featurizer parity — done.** Verified against the shipped
   `ParakeetFeatureExtractor`: the filterbank matches to `3.7e-9` and full
   features to `6.6e-5`, against the `1e-3` bar. The fixture lives at
   `apps/desktop/test/__fixtures__/parakeet/featurizer.json` and the check at
   `apps/desktop/test/parakeet-featurizer-parity.test.ts`, so it runs without
   Python or the checkpoint.

   It found **five** defects, not the three predicted, and every one was silent:
   80 mel bands where v3 uses 128; the HTK formula behind a function named
   "Slaney"; reflect padding where the extractor zero-pads; the 400-sample
   window left-aligned in the 512-point FFT frame rather than centred; and one
   frame too many, whose log-mel is the padding floor and which drags the
   per-feature mean and standard deviation. Anyone repeating this on a future
   checkpoint should assume the same and re-run the parity test rather than
   trust the constants.

2. **Decode parity.** Transcribe the NeMo reference set with
   `nemo_asr.models.ASRModel.transcribe()`, then with our ONNX loop, and assert
   identical strings. Not "similar" — identical. Greedy decoding is
   deterministic, so any difference is a bug in the loop.
3. **Duration-bin sanity.** Assert the exported joiner's last dimension is
   `vocab_size + 1 + len(durations)` and that `durations` matches the training
   config. If a future release changes the bins, `PARAKEET_DURATIONS` in
   `tdt-decode.ts` has to change with it.
4. **Fixture capture.** Save 3–5 short utterances as
   `apps/desktop/test/__fixtures__/parakeet/*.json` — encoder output, joint
   outputs per step, expected token ids — so the decode loop keeps its
   regression test without the 650 MB model. The fake-session tests already in
   `test/tdt-decode.test.ts` are written against exactly this shape, so the
   fixtures drop straight in.

## Hosting

Once validated, the export is published to a Murmur-controlled Hugging Face repo
and the catalog entry points at it with a pinned revision and real SHA-256s, the
same as every other entry. `notes` must say plainly that Murmur performed the
conversion from NVIDIA's `.nemo` checkpoint, with the NeMo version and the
commit of `export_parakeet.py` that produced it — so "who converted this" has an
answer that is not "someone on the internet".

Suggested entry shape (fill in the hashes from the real upload):

```jsonc
{
  "id": "parakeet-tdt-0.6b-v3-int8",
  "kind": "stt",
  "engine": "onnx-runtime",
  "displayName": "Parakeet-TDT 0.6B v3",
  "org": "NVIDIA",
  "origin": "US",
  "license": "CC-BY-4.0",
  "ramTierGb": 8,
  "languages": ["en", "multi"],
  "quant": "int8",
  "recommended": true,
  "files": [
    /* encoder-model.onnx, decoder-model.onnx, joiner-model.onnx, vocab.txt, config.json */
  ],
  "notes": "Converted by the Murmur project from NVIDIA's nvidia/parakeet-tdt-0.6b-v3 .nemo checkpoint using NeMo <version> via scripts/models/export_parakeet.py (<commit>). Weights are NVIDIA's, unmodified; the ONNX packaging is ours. Verified against NVIDIA reference transcripts.",
}
```
