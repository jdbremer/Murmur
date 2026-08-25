"""Export Granite Speech 5.0 TurboCTC to ONNX, first-party.

Granite Speech 5.0 ships as PyTorch `safetensors` with a custom architecture and
no GGUF, so — exactly as with Parakeet (see `export-parakeet.md`) — Murmur does
the conversion itself rather than listing somebody else's re-upload. The output
is one graph: stacked log-mel features in, CTC logits out.

## The one patch this needs, and why it is safe

The encoder's subsampling block pools time by two with

    pooled = hidden_states.unfold(1, 2, 2).mean(-1)

and `aten::unfold` cannot be exported once the frame count is symbolic — the
tracer reports "input size not accessible". Exporting at a fixed length would
avoid it and is the wrong trade: dictation is variable-length by nature, and a
graph that only accepts 6.3 seconds of audio is not a graph we can ship.

`avg_pool1d(kernel_size=2, stride=2)` computes precisely the same thing — the
mean of each disjoint pair, dropping a trailing odd frame — and lowers to ONNX
`AveragePool`, which handles a dynamic length natively. The patch returns the
pooled value with a trailing axis of size 1 so the caller's `.mean(-1)` stays a
no-op, which keeps the change to a single tensor op rather than a copy of a
forward method that upstream may revise. `--check-patch` asserts the two agree
to floating-point noise before anything is exported.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="models/granite-speech-5.0-470m-turboctc")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--opset", type=int, default=17)
    parser.add_argument(
        "--check-patch",
        action="store_true",
        help="Assert the avg_pool1d replacement matches unfold before exporting.",
    )
    return parser.parse_args()


def install_unfold_patch(torch):
    """Route the subsampling block's `unfold(1, 2, 2)` through `avg_pool1d`."""
    original = torch.Tensor.unfold

    def patched(self, dimension, size, step):
        if dimension == 1 and size == 2 and step == 2 and self.dim() == 3:
            pooled = torch.nn.functional.avg_pool1d(self.transpose(1, 2), 2, 2).transpose(1, 2)
            # `.mean(-1)` over a length-1 axis returns `pooled` unchanged.
            return pooled.unsqueeze(-1)
        return original(self, dimension, size, step)

    torch.Tensor.unfold = patched
    return original


def main() -> int:
    args = parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    try:
        import torch
        from transformers import AutoModelForCTC
    except ImportError as error:  # pragma: no cover - operator-facing
        print(f"missing dependency: {error}. See export-granite-speech.md.", file=sys.stderr)
        return 1

    if args.check_patch:
        sample = torch.randn(1, 317, 64)  # odd length: the trailing frame must drop
        reference = sample.unfold(1, 2, 2).mean(-1)
        original = install_unfold_patch(torch)
        patched = sample.unfold(1, 2, 2).mean(-1)
        torch.Tensor.unfold = original
        assert reference.shape == patched.shape, f"{reference.shape} != {patched.shape}"
        delta = (reference - patched).abs().max().item()
        assert delta < 1e-6, f"pooling patch changes the result by {delta}"
        print(f"patch verified: identical to unfold (max delta {delta:.2e})")

    print(f"loading {args.model}")
    model = AutoModelForCTC.from_pretrained(
        args.model, trust_remote_code=True, dtype=torch.float32
    ).eval()

    class Graph(torch.nn.Module):
        """Features in, raw CTC logits out. Argmax is invariant under softmax."""

        def __init__(self, inner):
            super().__init__()
            self.inner = inner

        def forward(self, input_features):
            out = self.inner(input_features=input_features)
            return out.logits if hasattr(out, "logits") else out

    install_unfold_patch(torch)

    dummy = torch.randn(1, 316, 320)
    print("exporting encoder + CTC head")
    torch.onnx.export(
        Graph(model),
        (dummy,),
        str(args.out / "model.onnx"),
        input_names=["input_features"],
        output_names=["logits"],
        dynamic_axes={
            "input_features": {0: "batch", 1: "frames"},
            "logits": {0: "batch", 1: "out_frames"},
        },
        opset_version=args.opset,
        # TorchScript, not dynamo — same reasoning as the Parakeet export: the
        # conformer attention reshapes in ways dynamo cannot prove once the
        # frame count is symbolic, and tracing does not care.
        dynamo=False,
    )
    print(f"wrote {args.out / 'model.onnx'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
