# π0.5 → our simulation: integration plan & status

Goal: let **π0.5** (Physical Intelligence's VLA, via **openpi**) drive our Three.js
xArm5 sim in **closed loop**, and evaluate it over many chess tasks to get a
**baseline** — then later do sim rollouts and fine-tune. This doc is the working
notebook: architecture, what's doable on this Mac, what needs a GPU, and status.

Context: the reference post (benedict.dev/robot-chess) is the **source of our own
dataset** — the same xArm 5-DOF (`[x, y, z (mm), yaw (deg), gripper 0..1]`), wrist
+ overhead cameras, ~400 scripted-teleop white-queen moves, π0.5 fine-tuned with
LoRA, served on a Jetson Orin with heavy compute offloaded to **Modal**. So our
action/observation format already matches π0.5's expected I/O for this robot.

## openpi interface (confirmed from the openpi docs)
- **Client:** `from openpi_client import websocket_client_policy, image_tools`;
  `client = websocket_client_policy.WebsocketClientPolicy(host, port=8000)`;
  `action_chunk = client.infer(observation)["actions"]` → shape `(action_horizon, action_dim)`.
- **Observation dict keys:**
  ```python
  {
    "observation/image":       uint8 HxWx3 (resize_with_pad → 224x224),
    "observation/wrist_image": uint8 HxWx3 (224x224),
    "observation/state":       state vector (UNNORMALIZED; server normalizes),
    "prompt":                  task instruction string,
  }
  ```
- **Server:** `uv run scripts/serve_policy.py policy:checkpoint --policy.config=pi05_droid --policy.dir=...` (port 8000).

## Feasibility on this Mac (Apple Silicon) — UPDATED

**π0.5 DOES run on this Mac** via **Hugging Face LeRobot + PyTorch MPS** (the
`openpi` repo itself is CUDA/Ubuntu-only, but LeRobot re-implements π0.5 with
explicit MPS support). Verified on this machine (M2 Max, **103 GB** unified
memory, macOS 15.7):
- `lerobot` **0.6.1** + `torch` **2.11** installed in a **Python 3.12** venv
  (`.venv/`; LeRobot needs ≥3.12, and the git clone needs `GIT_LFS_SKIP_SMUDGE=1`).
- `torch.backends.mps.is_available() == True`; `PI05Config` auto-selects `mps`.
- `PI05Policy.from_pretrained("lerobot/pi05_base")` loads on MPS (see
  `eval/pi05_smoke.py`). The checkpoint is a full VLA (PaliGemma VLM + flow
  action head), ~30+ GB on disk, comfortably within 103 GB RAM.

So we have **two** ways to run the model, and the eval harness supports both:
1. **Local, on this Mac** (LeRobot MPS) — `--policy lerobot` (no server, no GPU box).
2. **Remote GPU server** (openpi websocket) — `--policy openpi` — still useful for
   speed or to stay on upstream openpi.

π0.5 I/O (from `PI05Config`): outputs a **50-step action chunk**; state/action are
padded to **32 dims** (our 5-DOF fits); STATE/ACTION use **quantile** normalization.
Everything non-model (sim env, eval harness, oracle/random) also runs here.

## ⚠️ Two things needed for a real π0.5 baseline

### 1. Accept the PaliGemma license (one click — needs you) 🔑
π0.5's language tokenizer pulls Google's **gated** `google/paligemma-3b-pt-224`.
The model weights (`lerobot/pi05_base`, Apache-2.0) download + load on MPS fine,
but `make_pre_post_processors` / inference fails with **403 gated repo** until the
license is accepted. You (**niemerg**, already HF-logged-in on this Mac) just need
to click **"Agree and access repository"** at
<https://huggingface.co/google/paligemma-3b-pt-224>. After that,
`.venv/bin/python eval/pi05_infer.py` should run a full forward pass on MPS.

### 2. A checkpoint with OUR action space (fine-tune)
`pi05_base` is a generic 3-cam / 32-dim model — its actions aren't in our units,
so it won't zero-shot our robot. We need a checkpoint fine-tuned for this xArm
chess embodiment (2 cams, 5-DOF `[x,y,z,yaw,gripper]`). The path is built:
- **Convert** our episodes → LeRobotDataset: `eval/convert_to_lerobot.py`
  (works on the real `rollouts/full/...` and our synthetic `synth/...`).
- **Fine-tune on this Mac** (MPS) — π0.5 supports MPS training; use
  `train_expert_only`/`gradient_checkpointing` for memory:
  ```bash
  .venv/bin/lerobot-train --policy.type=pi05 --policy.pretrained_path=lerobot/pi05_base \
    --dataset.repo_id=chess_xarm/real_moves --dataset.root=data/lerobot/real_moves \
    --policy.device=mps --policy.dtype=bfloat16 --policy.gradient_checkpointing=true \
    --policy.train_expert_only=true --batch_size=1 --steps=3000 \
    --policy.max_state_dim=32 --policy.max_action_dim=32 --output_dir=outputs/pi05_chess
  ```
  (MPS training of a 4B VLA is slow — expect this to be the long pole; a GPU box
  is much faster. Start with a few hundred steps to validate the loop.)
- **Eval locally:** `python eval/eval_chess.py --policy lerobot --lerobot-model outputs/pi05_chess/<ckpt>`.

Until a fine-tuned checkpoint exists, the harness is validated with **oracle**
(upper bound) and **random** (lower bound); those quantify the env itself.

## Architecture
```
  Python eval harness (Mac)                       GPU host (Modal/cloud)
  ┌───────────────────────────┐   websocket    ┌─────────────────────────┐
  │ eval_chess.py             │◄──────────────►│ openpi serve_policy.py   │
  │  Policy: openpi | oracle  │  obs → actions  │  π0.5 (chess checkpoint) │
  │  drives sim over HTTP ────┼──┐             └─────────────────────────┘
  └───────────────────────────┘  │ HTTP /reset /step /success
                                  ▼
  ┌───────────────────────────────────────────┐
  │ tools/sim-server.mjs  (Node + Playwright)  │  headless browser runs env.html
  │   wraps window.ENV.{reset,step,success}    │  (Three.js xArm5 closed-loop env)
  └───────────────────────────────────────────┘
```
- **Env** (`src/synth/env.ts` / `env.html`): reuses `resolveScenario` + `buildScene`.
  `reset(scenario,seed)` sets up board/piece/robot-home and returns obs;
  `step([x,y,z,yaw,grip])` applies the commanded next state via IK, does **dynamic
  grasping** (close near piece → attach; open → release), renders base+wrist;
  `success()` checks the goal (piece within tol of the target square for a move;
  lifted above threshold for a pickup). Action semantics match the data
  (`action[i] ≈ state[i+1]`).
- **sim-server** exposes the env over HTTP so any client language can drive it.
- **eval harness** loops obs→policy→action-chunk→step over a task list, logs
  success + saves rollout videos, aggregates a baseline.

## Serving π0.5 (when a GPU + checkpoint are available)
- **Modal** (what the post used): wrap `scripts/serve_policy.py` in a Modal app on
  an A10/L4/A100, expose the websocket; set the eval `--policy-host` to it.
- **Any NVIDIA box / RunPod / Lambda:** `uv run scripts/serve_policy.py
  policy:checkpoint --policy.config=<chess_config> --policy.dir=<ckpt>`; tunnel
  port 8000 to the Mac (or run the eval on that box).
- Client stays identical; only `--policy-host/--policy-port` change.

## Status (as of this session)
**Done & validated on this Mac (M2 Max, 103 GB):**
- [x] Closed-loop sim env (`src/synth/env.ts` / `env.html`): reset/step/success,
      dynamic grasping, base+wrist obs, dataset-matched action/state units.
- [x] Sim HTTP server (`tools/sim-server.mjs`, port 8010) wrapping the env.
- [x] Python eval harness (`eval/`): `sim_client`, `policies`
      (oracle/random/openpi/**lerobot**), `tasks`, `eval_chess.py` (+ video capture).
- [x] End-to-end validated: **oracle 100%**, **random 0%** on moves + pickups.
- [x] **π0.5 runs on this Mac (MPS)** — `lerobot` 0.6.1 + `torch` 2.11 in a Py3.12
      venv; `PI05Policy.from_pretrained("lerobot/pi05_base")` loaded **4.14B params
      on `mps:0`** (`eval/pi05_smoke.py`). Inputs: 3 cams (3×224×224) + 32-dim state;
      output 32-dim × 50-step chunk.
- [x] `LeRobotPolicy` (local MPS inference) wired into the eval (`--policy lerobot`).
- [x] Fine-tune data path: `eval/convert_to_lerobot.py` → LeRobotDataset (tested on
      real episodes; encodes base+wrist to video + 5-DOF state/action + task).
- [x] `OpenpiPolicy` (remote GPU server) also wired + client verified installable.
- [x] Modal GPU serving skeleton (`eval/serve_pi05_modal.py`).

**Remaining (see the two blocks above):**
- [ ] 🔑 **Accept the PaliGemma license** (one click, needs you) — unblocks full
      inference: `.venv/bin/python eval/pi05_infer.py`.
- [ ] Fine-tune a chess-embodiment checkpoint (convert → `lerobot-train` on MPS or a
      GPU box), then `eval_chess.py --policy lerobot --lerobot-model <ckpt>` for the baseline.

**Env setup on this Mac (reproduce):** `uv venv .venv --python 3.12` then
`GIT_LFS_SKIP_SMUDGE=1 uv pip install --python .venv/bin/python "lerobot[pi,dataset]@git+https://github.com/huggingface/lerobot.git"`.

**Perf notes:** π0.5 load on MPS is slow (~min after the ~30 GB download; cached
after). Each sim step is an HTTP roundtrip + 2 headless renders (~50–70 ms). MPS
inference latency of a 4B VLA is seconds/chunk — fine for eval, and a GPU box is
faster for large sweeps or fine-tuning.
