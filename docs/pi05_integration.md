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

## Feasibility on this Mac (Apple Silicon)
- **Running the π0.5 model here: NOT feasible.** openpi inference needs an
  **NVIDIA GPU (≥8 GB, e.g. RTX 4090)** and is "tested with Ubuntu 22.04; other
  OSes not supported." No CUDA on Apple Silicon; the JAX/PyTorch stack + kernels
  won't run. → The **model server must run on a GPU host** (Modal — as the post
  used — or RunPod / Lambda / a Linux+NVIDIA box). See "Serving π0.5" below.
- **Running here: everything else.** The sim (env), the eval harness, the
  policy *client* (`openpi_client` is a light websocket+msgpack package, no CUDA),
  and stub/oracle/random policies all run on the Mac. So we build and validate the
  **entire closed loop locally against a stub policy**, then point the client at a
  remote π0.5 server with a one-line host change.

## ⚠️ Open blocker: a matching π0.5 checkpoint
π0.5 checkpoints are **per-embodiment**. The public ones (`pi05_droid`,
`pi05_libero`) have **different action spaces** (DROID ≈ 7-DOF, LIBERO) — their
actions are meaningless for our 5-DOF `[x,y,z,yaw,gripper]` env, so a *base*
checkpoint won't give a meaningful zero-shot baseline on our tasks. To evaluate
π0.5 on our env we need a checkpoint whose action space is **our** robot's:
1. **The post author's fine-tuned chess checkpoint** (not public — would be ideal;
   it *is* the model we ultimately want to reproduce), or
2. **Our own fine-tune**: define an openpi config for this xArm chess embodiment
   (`action_dim=5`, our norm stats) and LoRA-fine-tune π0.5 on the real episodes
   (and/or our synthetic ones) — this is the "later" step in the goal.

**Implication for "baseline now":** the *pipeline* is fully built and validated
with **oracle** (upper bound) and **random** (lower bound) policies. A real π0.5
number requires (1) a GPU server and (2) a chess-embodiment checkpoint. Until then
the harness is ready and the oracle/random baselines quantify the env itself.

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
**Done & validated on this Mac:**
- [x] Closed-loop sim env (`src/synth/env.ts` / `env.html`): reset/step/success,
      dynamic grasping, base+wrist obs, dataset-matched action/state units.
- [x] Sim HTTP server (`tools/sim-server.mjs`, port 8010) wrapping the env.
- [x] Python eval harness (`eval/`): `sim_client`, `policies`
      (oracle/random/openpi), `tasks`, `eval_chess.py` (+ rollout video capture).
- [x] End-to-end validated: **oracle 100%**, **random 0%** on moves + pickups.
- [x] `OpenpiPolicy` client wired to the openpi websocket API (obs keys, 224 resize,
      unnormalized state, prompt) — ready; needs a server to talk to.
- [x] Modal GPU serving skeleton (`eval/serve_pi05_modal.py`).

**Blocked (need a GPU host and/or a checkpoint — not this Mac):**
- [ ] Run a real π0.5 server (NVIDIA GPU, Ubuntu). Model can't run on Apple Silicon.
- [ ] A π0.5 checkpoint with **our** 5-DOF action space. Public checkpoints don't
      match; options: get the post author's fine-tuned chess ckpt, or fine-tune our
      own (openpi config for this embodiment + LoRA on the real/synthetic episodes).
- [ ] Real π0.5 baseline number (needs both of the above).

**Next steps when back / with a GPU:**
1. Stand up a GPU box (Modal via the skeleton, or RunPod/Lambda).
2. Obtain or fine-tune a chess-embodiment π0.5 checkpoint.
3. `python eval/eval_chess.py --policy openpi --policy-host <host> --n 50` for the baseline.
4. (Later) generate sim rollouts → fine-tune π0.5 → re-eval.

**Perf note:** each step is an HTTP roundtrip + 2 headless renders (~50–70 ms).
A few hundred tasks is fine (~minutes–tens of minutes); for large sweeps, shrink
obs images / batch / run the eval on the GPU box next to the server.
