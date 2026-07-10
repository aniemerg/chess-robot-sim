"""Prove π0.5 INFERENCE runs on Apple-Silicon MPS (not just loading): build a
raw observation matching pi05_base's input features, run the preprocess ->
select_action -> postprocess pipeline, and time it.

Run:  .venv/bin/python eval/pi05_infer.py
"""
import time
import numpy as np
import torch

MODEL = "lerobot/pi05_base"
device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
print(f"device={device}")

from lerobot.policies.pi05 import PI05Policy
from lerobot.policies.factory import make_pre_post_processors

t0 = time.time()
policy = PI05Policy.from_pretrained(MODEL).to(device).eval()
print(f"load: {time.time()-t0:.0f}s  params={sum(p.numel() for p in policy.parameters())/1e9:.2f}B")

preprocess, postprocess = make_pre_post_processors(
    policy.config, MODEL, preprocessor_overrides={"device_processor": {"device": str(device)}}
)

# Raw observation matching the pi05_base input features (3 cams + 32-dim state).
def rand_img():
    return (np.random.rand(224, 224, 3) * 255).astype(np.uint8)

frame = {
    "observation.images.base_0_rgb": rand_img(),
    "observation.images.left_wrist_0_rgb": rand_img(),
    "observation.images.right_wrist_0_rgb": rand_img(),
    "observation.state": np.zeros(32, dtype=np.float32),
    "task": "move the white queen from e5 to g5",
}

for i in range(3):
    t = time.time()
    batch = preprocess(frame)
    with torch.inference_mode():
        action = policy.select_action(batch)
    action = postprocess(action)
    if hasattr(action, "detach"):
        action = action.detach().cpu().numpy()
    dt = time.time() - t
    print(f"infer {i}: {dt*1000:.0f} ms  action shape={np.asarray(action).shape}")

print("INFERENCE OK on", device)
