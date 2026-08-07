#!/usr/bin/env python3
"""Export NVIDIA Parakeet-TDT to ONNX, first-party.

Read `export-parakeet.md` first. It explains why this exists — NVIDIA ships
`.nemo`, not ONNX, and Murmur's provenance policy does not list community
conversions — and, more importantly, what has to be *verified* before the output
may enter the catalog.

## This no longer needs NeMo

The original plan installed `nemo_toolkit[asr]`: a very large dependency, a GPU,
and a `.nemo` bundle that only NeMo can open. NVIDIA has since published the
same weights in Hugging Face `transformers` format — `model.safetensors` plus a
`ParakeetForTDT` architecture — so the export runs from `transformers` and
`torch` alone. Same weights, same provenance, a fraction of the toolchain:

    python3.12 -m venv .venv-parakeet && source .venv-parakeet/bin/activate
    pip install torch transformers onnx onnxruntime librosa
    python3 scripts/models/export_parakeet.py \\
        --model nvidia/parakeet-tdt-0.6b-v3 \\
        --out   build/parakeet-tdt-0.6b-v3-onnx

## What comes out

A transducer is three graphs, because they run at different rates: the encoder
once per utterance, the decoder once per emitted token, the joint once per
(frame, token) step. Exporting them as one graph would force the whole decode
loop into ONNX control flow; keeping them separate is what lets `tdt-decode.ts`
own the loop, which is where the duration-skip semantics live.

    encoder.onnx   [B, T, 128] log-mel  -> [B, T', 640] encoder states
    decoder.onnx   token + LSTM state   -> [B, 1, 640] prediction state
    joint.onnx     (enc_t, dec_u)       -> [B, 8198] logits

plus `vocab.json` and `config.json` recording the vocabulary, blank id, duration
bins and the mel front-end the featurizer has to match.

Note the encoder graph folds in `encoder_projector` (1024 -> 640): the joint
expects projected states, and leaving the projection out of the graph is an easy
way to produce an export that runs and transcribes nonsense.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

MEL_BINS = 128


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="nvidia/parakeet-tdt-0.6b-v3")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument(
        "--quantize",
        action="store_true",
        help="Also emit per-channel int8 graphs — what the catalog ships.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    try:
        import torch
        from transformers import AutoConfig, AutoModel, AutoProcessor
    except ImportError as error:  # pragma: no cover - operator-facing
        print(f"missing dependency: {error}. See scripts/models/export-parakeet.md.", file=sys.stderr)
        return 1

    print(f"loading {args.model}")
    config = AutoConfig.from_pretrained(args.model)
    model = AutoModel.from_pretrained(args.model, dtype=torch.float32).eval()
    processor = AutoProcessor.from_pretrained(args.model)

    hidden = model.encoder_projector.out_features
    layers = model.decoder.lstm.num_layers

    # -- encoder ------------------------------------------------------------
    # Wrapped so the projection travels with it; see the module docstring.
    class Encoder(torch.nn.Module):
        def __init__(self, inner):
            super().__init__()
            self.inner = inner

        def forward(self, input_features):
            out = self.inner.encoder(input_features)
            states = out.last_hidden_state if hasattr(out, "last_hidden_state") else out[0]
            return self.inner.encoder_projector(states)

    print("exporting encoder")
    torch.onnx.export(
        Encoder(model),
        (torch.randn(1, 200, MEL_BINS),),
        str(args.out / "encoder.onnx"),
        input_names=["input_features"],
        output_names=["encoder_states"],
        dynamic_axes={"input_features": {0: "batch", 1: "frames"},
                      "encoder_states": {0: "batch", 1: "enc_frames"}},
        opset_version=args.opset,
        # The TorchScript exporter, not the dynamo one. Dynamo cannot decompose
        # the Conformer attention's `reshape(*input_shape, -1)` once the frame
        # count is symbolic — it fails on a view whose strides it cannot prove —
        # and the whole point of the export is a graph that takes variable-length
        # audio. Tracing does not care, and the three graphs here are simple
        # feed-forward blocks with no data-dependent control flow to lose.
        dynamo=False,
    )

    # -- decoder (prediction network) ---------------------------------------
    # State in and state out, explicitly: the decode loop advances one token at
    # a time and must be able to carry the LSTM state itself.
    class Decoder(torch.nn.Module):
        def __init__(self, inner):
            super().__init__()
            self.embedding = inner.decoder.embedding
            self.lstm = inner.decoder.lstm
            self.projector = inner.decoder.decoder_projector

        def forward(self, token, h_in, c_in):
            x = self.embedding(token)
            y, (h_out, c_out) = self.lstm(x, (h_in, c_in))
            return self.projector(y), h_out, c_out

    print("exporting decoder")
    torch.onnx.export(
        Decoder(model),
        (torch.zeros(1, 1, dtype=torch.long),
         torch.zeros(layers, 1, hidden),
         torch.zeros(layers, 1, hidden)),
        str(args.out / "decoder.onnx"),
        input_names=["token", "h_in", "c_in"],
        output_names=["decoder_state", "h_out", "c_out"],
        dynamic_axes={"token": {0: "batch"}, "h_in": {1: "batch"}, "c_in": {1: "batch"},
                      "decoder_state": {0: "batch"}, "h_out": {1: "batch"}, "c_out": {1: "batch"}},
        opset_version=args.opset,
        # The TorchScript exporter, not the dynamo one. Dynamo cannot decompose
        # the Conformer attention's `reshape(*input_shape, -1)` once the frame
        # count is symbolic — it fails on a view whose strides it cannot prove —
        # and the whole point of the export is a graph that takes variable-length
        # audio. Tracing does not care, and the three graphs here are simple
        # feed-forward blocks with no data-dependent control flow to lose.
        dynamo=False,
    )

    # -- joint --------------------------------------------------------------
    class Joint(torch.nn.Module):
        def __init__(self, inner):
            super().__init__()
            self.joint = inner.joint

        def forward(self, decoder_state, encoder_state):
            out = self.joint(decoder_state, encoder_state)
            return out[0] if isinstance(out, (tuple, list)) else out

    print("exporting joint")
    torch.onnx.export(
        Joint(model),
        (torch.randn(1, 1, hidden), torch.randn(1, 1, hidden)),
        str(args.out / "joint.onnx"),
        input_names=["decoder_state", "encoder_state"],
        output_names=["logits"],
        dynamic_axes={"decoder_state": {0: "batch"}, "encoder_state": {0: "batch"},
                      "logits": {0: "batch"}},
        opset_version=args.opset,
        # The TorchScript exporter, not the dynamo one. Dynamo cannot decompose
        # the Conformer attention's `reshape(*input_shape, -1)` once the frame
        # count is symbolic — it fails on a view whose strides it cannot prove —
        # and the whole point of the export is a graph that takes variable-length
        # audio. Tracing does not care, and the three graphs here are simple
        # feed-forward blocks with no data-dependent control flow to lose.
        dynamo=False,
    )

    # -- vocabulary + config ------------------------------------------------
    tokenizer = processor.tokenizer
    size = getattr(tokenizer, "vocab_size", None) or len(tokenizer.get_vocab())
    vocab = [tokenizer.convert_ids_to_tokens(i) for i in range(size)]
    (args.out / "vocab.json").write_text(json.dumps(vocab, ensure_ascii=False))

    extractor = processor.feature_extractor
    meta = {
        "model": args.model,
        "vocabSize": int(config.vocab_size),
        "blankTokenId": int(config.blank_token_id),
        "durations": list(config.durations),
        "maxSymbolsPerStep": int(config.max_symbols_per_step),
        "hiddenSize": int(hidden),
        "decoderLayers": int(layers),
        "mel": {
            "sampleRate": int(extractor.sampling_rate),
            "nFft": int(extractor.n_fft),
            "winLength": int(extractor.win_length),
            "hopLength": int(extractor.hop_length),
            "nMels": int(extractor.feature_size),
            "preEmphasis": float(extractor.preemphasis),
            # Spelled out because each is a way to be silently wrong; see the
            # parity notes in export-parakeet.md.
            "melScale": "slaney",
            "melNorm": "slaney",
            "window": "symmetric",
            "padMode": "constant",
            "normalize": "per_feature",
            "logZeroGuard": 2**-24,
        },
    }
    (args.out / "config.json").write_text(json.dumps(meta, indent=2))

    # The joint's width is the one shape that silently invalidates the decode
    # loop's duration arithmetic, so assert it here rather than discover it as
    # bad transcripts.
    expected = meta["vocabSize"] + len(meta["durations"])
    actual = model.joint.head.out_features
    if actual != expected:
        print(f"joint width {actual} != vocab {meta['vocabSize']} + durations "
              f"{len(meta['durations'])}; PARAKEET_DURATIONS must change with it.",
              file=sys.stderr)
        return 1

    if args.quantize:
        # **Per-channel, and it is not optional.** Plain dynamic int8 loses
        # words: measured against transformers on 10 utterances it scored 8/10
        # exact, turning "Please add murmur" into "Plead murmur". Per-channel
        # with reduced range scores 10/10 at the same 631 MB and the same 17x
        # realtime, so the only thing default quantisation buys is errors.
        from onnxruntime.quantization import QuantType, quantize_dynamic  # noqa: PLC0415

        quantised = args.out.parent / f"{args.out.name}-int8"
        quantised.mkdir(parents=True, exist_ok=True)
        for name in ("encoder", "decoder", "joint"):
            print(f"quantising {name}")
            quantize_dynamic(
                str(args.out / f"{name}.onnx"),
                str(quantised / f"{name}.onnx"),
                weight_type=QuantType.QInt8,
                per_channel=True,
                reduce_range=True,
            )
        for name in ("config.json", "vocab.json"):
            (quantised / name).write_bytes((args.out / name).read_bytes())
        print(f"quantised graphs in {quantised}")

    for f in sorted(args.out.iterdir()):
        print(f"  {f.name}  {f.stat().st_size / 1e6:.1f} MB")
    print(f"\nwrote {args.out}. Validate before cataloguing — see export-parakeet.md.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
