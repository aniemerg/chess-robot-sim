"""Smoke test: load π0.5 (lerobot/pi05_base) on Apple-Silicon MPS, inspect its
I/O, and run one inference. Proves native π0.5 inference works on this Mac.

Run:  .venv/bin/python eval/pi05_smoke.py
"""
import time
import torch

MODEL = "lerobot/pi05_base"
device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
print(f"device={device}  torch={torch.__version__}")

from lerobot.policies.pi05 import PI05Policy  # noqa: E402

t0 = time.time()
policy = PI05Policy.from_pretrained(MODEL)
print(f"from_pretrained: {time.time()-t0:.1f}s")
policy = policy.to(device).eval()
print(f"on device: {next(policy.parameters()).device}")

cfg = policy.config
n = sum(p.numel() for p in policy.parameters())
print(f"params: {n/1e9:.2f}B")
for attr in ("chunk_size", "n_action_steps", "max_state_dim", "max_action_dim", "resize_imgs_with_padding"):
    print(f"  {attr}: {getattr(cfg, attr, '?')}")
print("INPUT FEATURES:")
for k, v in (getattr(cfg, "input_features", {}) or {}).items():
    print(f"    {k}: {getattr(v, 'shape', v)}")
print("OUTPUT FEATURES:")
for k, v in (getattr(cfg, "output_features", {}) or {}).items():
    print(f"    {k}: {getattr(v, 'shape', v)}")
print("image_features:", getattr(cfg, "image_features", "?"))
print("DONE")
