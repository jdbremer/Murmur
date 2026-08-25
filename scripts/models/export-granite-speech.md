# Exporting Granite Speech 5.0 TurboCTC to ONNX, first-party

**Status: shipped.** `resources/catalog/models.json` lists
`granite-speech-5.0-470m-turboctc-int8`, hosted on the
`models-granite-speech-5.0-470m` release.

## Why we convert it ourselves

IBM released Granite Speech 5.0 TurboCTC on 2026-08-25: a 470M-parameter
English CTC conformer, Apache-2.0, trained on ~60,000 hours, and explicitly
aimed at "laptops, smartphones and other edge devices". That is Murmur's brief
almost word for word.

It ships as PyTorch `safetensors` with a custom architecture. There is no GGUF
— unlike `granite-speech-4.1-2b`, which IBM does publish for llama.cpp with an
`mmproj` — and no first-party ONNX. So the same rule applies as for Parakeet
(see `export-parakeet.md`): **we do the export ourselves and verify it, rather
than listing a community re-upload and calling it an IBM model.**

## Toolchain

The model's own card says to install `transformers` from source, and it means
it: the architecture id is `granite_speech5_ctc` and released `transformers`
5.15.1 does not know it. 5.16.0.dev0 from git does.

```shell
python3 -m venv .venv-granite
.venv-granite/bin/pip install torch onnx onnxruntime soundfile numpy torchaudio
.venv-granite/bin/pip install git+https://github.com/huggingface/transformers.git
```

`torchaudio` is not optional — `GraniteSpeech5FeatureExtractor` refuses to load
without it.

## The one patch, and why it is safe

The encoder's subsampling block pools time by two with

```python
pooled = hidden_states.unfold(1, 2, 2).mean(-1)
```

and `aten::unfold` cannot be exported once the frame count is symbolic; the
tracer reports _"Unsupported: ONNX export of operator Unfold, input size not
accessible"_. Exporting at a fixed length would dodge it and is the wrong
trade — dictation is variable-length by nature.

`avg_pool1d(kernel_size=2, stride=2)` computes exactly the same thing (the mean
of each disjoint pair, dropping a trailing odd frame) and lowers to ONNX
`AveragePool`, which takes a dynamic length natively. `--check-patch` asserts
the two agree before exporting; on an odd-length input it reports a max delta of
**0.00e+00** — bit-identical, not merely close.

## The warning that looks fatal and is not

Tracing emits:

```
TracerWarning: Converting a tensor to a Python boolean ...
  if num_padded > 0:
```

Block self-attention right-pads the sequence to a multiple of `context_size`
(128), and that `if` is baked in as a constant. It is worth understanding why
this does _not_ poison the graph: the **branch** is frozen, the **pad amount**
is not. The frozen branch is "do pad", and when a length happens to be an exact
multiple of 128 the computed pad is 0 — a no-op. So the traced graph is correct
for every length, which the verification below demonstrates rather than assumes.

## Verification

`model.onnx` was checked against PyTorch across lengths that specifically
include the exact multiples of 128 where the frozen branch could have been
wrong:

| frames | audio   | out frames | max delta |
| ------ | ------- | ---------- | --------- |
| 64     | 1.28 s  | 16         | 0.00005   |
| 128    | 2.56 s  | 32         | 0.00006   |
| 256    | 5.12 s  | 64         | 0.00006   |
| 317    | 6.34 s  | 79         | 0.00005   |
| 512    | 10.24 s | 128        | 0.00013   |
| 900    | 18.00 s | 225        | 0.00056   |

On a real 6.3 s clip, PyTorch, fp32 ONNX and int8 ONNX all produce the same
transcript, character for character.

Dynamic int8 quantisation (per-channel) takes the graph from 1.89 GB to
**544 MB**, and on this machine's CPU runs at **RTFx 44** — 142 ms for 6.3 s of
audio — with no change to the transcript.

## Feature layout

The processor emits `[batch, frames, 320]`, and the 320 is worth spelling out
because the featurizer has to reproduce it exactly:

```
80 log-mel bins  +  80 delta coefficients  =  160
160  ×  stack_factor 2 (two adjacent frames concatenated)  =  320
```

Frames are therefore 20 ms apart, not 10 ms. The STFT itself —
16 kHz, `n_fft 512`, `win_length 400`, `hop_length 160` — is already what
`apps/desktop/src/main/engines/stt/onnx/featurizer.ts` computes for Parakeet;
only `nMels` (128 → 80), the deltas and the stacking are new.

The encoder subsamples by 4, so output frames ≈ input frames / 4.

## Decoding

Greedy CTC, blank id 0:

```
argmax over vocab → collapse runs of equal ids → drop blank
```

That is the whole decoder — considerably simpler than the TDT loop Parakeet
needs, which has to carry duration skips and LSTM state.

## The integration

The conversion is half of it. The other half is a front end that reproduces
IBM's extractor exactly, because a wrong one does not crash — it transcribes a
little worse, forever.

- **`onnx/granite-features.ts`** — the 320-value layout above. Kept separate
  from `computeLogMel` rather than adding flags to it: the two share an STFT and
  a filterbank and then agree on nothing. Parakeet pre-emphasises, zero-pads,
  uses a symmetric window and Slaney-normalised filters, takes a natural log
  with an additive guard and normalises each band; Granite does none of those.
  Pinned by `test/granite-featurizer-parity.test.ts` against IBM's own output.
- **`onnx/ctc-decode.ts`** — greedy collapse and byte-level detokenisation.
  Checked in `test/granite-decode.test.ts` against the argmax of real logits, so
  it reproduces the reference transcript rather than my idea of CTC.
- **`onnx/protocol.ts`** — `detectFamily` gained `granite-ctc`, recognised by
  exclusion: "one graph and a vocabulary" is the weakest signal of the three and
  would otherwise swallow the other two.
- **`onnx/host.ts`** — a loader and a transcribe path. `LoadedModel.decoder` is
  now nullable, because a CTC model genuinely has no decoder to step.

Writing the featurizer found a real defect in the shared code: `melFilterbank`
called `hzToMel` without passing a scale, so it silently placed every filter on
Slaney's curve whatever the config said. `MelConfig` now carries `melScale`
explicitly and Parakeet states the Slaney value it always had — which the
Parakeet parity fixture confirms is unchanged.

## End to end

Downloaded through the app's own downloader (which verifies the SHA-256),
selected as the STT engine, and run against a real recording through the file
transcription path:

> the quick brown fox jumps over the lazy dog this recording was made to test
> file transcription and murmur

Character for character what PyTorch produces.

## Running it

```shell
.venv-granite/bin/python scripts/models/export_granite_speech.py \
    --out build/granite-speech-5.0-470m-onnx --check-patch
```
