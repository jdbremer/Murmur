#!/usr/bin/env python3
"""Export NVIDIA Parakeet-TDT from .nemo to ONNX, first-party.

**Skeleton.** This has not been run — Murmur's development container has no
NeMo, no GPU and no 650 MB checkpoint — so treat every step below as the plan
rather than as tested code. Read `export-parakeet.md` first; it explains why
this exists at all (NVIDIA ships .nemo, not ONNX, and Murmur's provenance policy
does not list community conversions) and, more importantly, what has to be
*verified* before the output may enter the catalog.

Run it in a throwaway virtualenv:

    python3 -m venv .venv-nemo && source .venv-nemo/bin/activate
    pip install "nemo_toolkit[asr]" onnx onnxruntime
    python3 scripts/models/export_parakeet.py \
        --model nvidia/parakeet-tdt-0.6b-v3 \
        --out   build/parakeet-tdt-0.6b-v3-onnx

NeMo is deliberately not a dependency of this repo: this is an occasional
offline job whose output is a handful of files, not part of the app's build.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        default="nvidia/parakeet-tdt-0.6b-v3",
        help="Hugging Face model id or a local .nemo path.",
    )
    parser.add_argument("--out", required=True, type=Path, help="Output directory.")
    parser.add_argument(
        "--quantize",
        action="store_true",
        help="Also emit int8 dynamic-quantised graphs (what the catalog ships).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    try:
        import nemo.collections.asr as nemo_asr  # noqa: PLC0415
    except ImportError:
        print(
            "nemo_toolkit is not installed. See scripts/models/export-parakeet.md.",
            file=sys.stderr,
        )
        return 1

    print(f"loading {args.model}")
    model = nemo_asr.models.ASRModel.from_pretrained(model_name=args.model)
    model.eval()

    # NeMo's `export()` on a transducer writes the three graphs a transducer
    # needs, deriving their names from the stem it is given:
    #   <stem>-encoder-model.onnx / -decoder-model.onnx / -joiner-model.onnx
    #
    # The decoder ("prediction network") and joiner are separate graphs on
    # purpose — the decode loop in `tdt-decode.ts` calls them at different rates,
    # which is exactly what makes TDT fast.
    stem = args.out / "parakeet.onnx"
    print(f"exporting ONNX graphs into {args.out}")
    model.export(str(stem))

    # -- the tokenizer -------------------------------------------------------
    # `loadTokenizer()` on the TypeScript side reads a plain vocab.txt: one
    # SentencePiece piece per line, id = line number. Nothing more exotic is
    # needed because we only ever *de*tokenise.
    vocab_path = args.out / "vocab.txt"
    pieces = list(model.tokenizer.vocab)
    vocab_path.write_text("\n".join(pieces) + "\n", encoding="utf-8")
    print(f"wrote {vocab_path} ({len(pieces)} pieces)")

    # -- the constants the decode loop must agree with -----------------------
    # Every one of these has a matching constant in the TypeScript. If a future
    # Parakeet release changes any of them, the export must fail loudly rather
    # than produce a model that decodes to plausible nonsense.
    config = getattr(model, "cfg", {})
    durations = list(getattr(getattr(config, "model_defaults", {}), "tdt_durations", [0, 1, 2, 3, 4]))
    preprocessor = getattr(config, "preprocessor", {})

    metadata = {
        "source_model": args.model,
        "vocab_size": len(pieces),
        # `tdt-decode.ts` splits the joiner's output at `vocab_size + 1`; the
        # duration head is everything after it.
        "blank_index": len(pieces),
        "durations": durations,
        # `featurizer.ts` PARAKEET_MEL must match these exactly.
        "mel": {
            "sample_rate": int(getattr(preprocessor, "sample_rate", 16000)),
            "n_fft": int(getattr(preprocessor, "n_fft", 512)),
            "win_length": int(
                float(getattr(preprocessor, "window_size", 0.025))
                * int(getattr(preprocessor, "sample_rate", 16000))
            ),
            "hop_length": int(
                float(getattr(preprocessor, "window_stride", 0.01))
                * int(getattr(preprocessor, "sample_rate", 16000))
            ),
            "n_mels": int(getattr(preprocessor, "features", 80)),
            "window": str(getattr(preprocessor, "window", "hann")),
            "normalize": str(getattr(preprocessor, "normalize", "per_feature")),
            "preemph": float(getattr(preprocessor, "preemph", 0.97)),
            # The single most consequential value: it rescales every feature and
            # a wrong choice degrades accuracy silently. `featurizer.ts` defaults
            # to "slaney" (librosa's default, which NeMo passes through); the
            # parity check in export-parakeet.md is what confirms it.
            "mel_norm": str(getattr(preprocessor, "mel_norm", "slaney")),
        },
    }
    config_path = args.out / "config.json"
    config_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {config_path}")

    if args.quantize:
        # Dynamic int8 is what makes Parakeet real-time on CPU (PLAN §6.1) and
        # what the catalog's size estimate assumes.
        from onnxruntime.quantization import QuantType, quantize_dynamic  # noqa: PLC0415

        for graph in sorted(args.out.glob("*-model.onnx")):
            target = graph.with_name(graph.name.replace(".onnx", ".int8.onnx"))
            print(f"quantising {graph.name} → {target.name}")
            quantize_dynamic(str(graph), str(target), weight_type=QuantType.QInt8)

    print()
    print("Export finished. Do NOT add a catalog entry yet — run the validation")
    print("in scripts/models/export-parakeet.md first:")
    print("  1. featurizer parity against NeMo's preprocessor (max abs diff < 1e-3)")
    print("  2. decode parity against NeMo reference transcripts (identical strings)")
    print("  3. duration-bin sanity: joiner output width == vocab_size + 1 + len(durations)")
    print("  4. capture fixtures into apps/desktop/test/__fixtures__/parakeet/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
