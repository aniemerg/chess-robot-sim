"""
Convert our episodes (recorder format: frames.jsonl + base/ + wrist/ jpgs) into a
LeRobotDataset for fine-tuning π0.5. Works on the REAL data (rollouts/full/...) or
our SYNTHETIC data (synth/...) — both share the layout.

Features match our 5-DOF robot: observation.images.{base,wrist} + observation.state
+ action (all [x,y,z,yaw,gripper]) + task string.

Run (in the venv):
  .venv/bin/python eval/convert_to_lerobot.py \
      --src rollouts/full/chess_moves_v2/episodes --repo-id chess_xarm/real_moves \
      --root data/lerobot/real_moves --limit 5     # small test; drop --limit for all
"""
import argparse
import glob
import json
import os

import numpy as np
from PIL import Image

STATE_NAMES = ["x", "y", "z", "yaw", "gripper"]


def load_episode(ep_dir):
    task = json.load(open(f"{ep_dir}/episode.json"))["task"]
    frames = [json.loads(l) for l in open(f"{ep_dir}/frames.jsonl")]
    return task, frames


def img(path):
    return np.asarray(Image.open(path).convert("RGB"), dtype=np.uint8)  # (H,W,3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="dir containing episode_XXXXXX/ folders")
    ap.add_argument("--repo-id", required=True)
    ap.add_argument("--root", required=True, help="local output dir (gitignored)")
    ap.add_argument("--fps", type=int, default=15)
    ap.add_argument("--limit", type=int, default=0, help="0 = all episodes")
    args = ap.parse_args()

    from lerobot.datasets.lerobot_dataset import LeRobotDataset

    eps = sorted(glob.glob(os.path.join(args.src, "episode_*")))
    if args.limit:
        eps = eps[: args.limit]
    if not eps:
        raise SystemExit(f"no episodes under {args.src}")
    # probe image size
    h, w, _ = img(sorted(glob.glob(f"{eps[0]}/base/*.jpg"))[0]).shape

    features = {
        "observation.images.base": {"dtype": "video", "shape": (h, w, 3), "names": ["height", "width", "channels"]},
        "observation.images.wrist": {"dtype": "video", "shape": (h, w, 3), "names": ["height", "width", "channels"]},
        "observation.state": {"dtype": "float32", "shape": (5,), "names": STATE_NAMES},
        "action": {"dtype": "float32", "shape": (5,), "names": STATE_NAMES},
    }
    ds = LeRobotDataset.create(repo_id=args.repo_id, fps=args.fps, features=features,
                               root=args.root, robot_type="xarm5", use_videos=True)

    for i, ep in enumerate(eps):
        task, frames = load_episode(ep)
        bpaths = sorted(glob.glob(f"{ep}/base/*.jpg"))
        wpaths = sorted(glob.glob(f"{ep}/wrist/*.jpg"))
        n = min(len(frames), len(bpaths), len(wpaths))
        for k in range(n):
            ds.add_frame({
                "observation.images.base": img(bpaths[k]),
                "observation.images.wrist": img(wpaths[k]),
                "observation.state": np.asarray(frames[k]["state"], np.float32),
                "action": np.asarray(frames[k]["action"], np.float32),
                "task": task,
            })
        ds.save_episode()
        print(f"[{i+1}/{len(eps)}] {os.path.basename(ep)}  {n} frames  | {task}")

    print(f"\nwrote LeRobotDataset '{args.repo_id}' -> {args.root}  ({len(eps)} episodes)")
    print("Next: compute quantile stats, then `lerobot-train --policy.type=pi05 "
          "--policy.pretrained_path=lerobot/pi05_base --dataset.repo_id=<...> --policy.device=mps` "
          "(see docs/pi05_integration.md).")


if __name__ == "__main__":
    main()
