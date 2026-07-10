# Closed-loop chess eval (π0.5 / openpi)

Drive the Three.js xArm5 sim in **closed loop** with a policy and measure success
over many tasks. Full design + feasibility in `docs/pi05_integration.md`.

```
tools/sim-server.mjs  ──HTTP──►  env.html (Three.js closed-loop env)
        ▲ /reset /step /success
        │ HTTP
eval_chess.py ──► policies.py ─┬─ oracle (upper bound, scripted)
                               ├─ random (lower bound)
                               └─ openpi (real π0.5 via websocket → GPU server)
```

## Run (Mac)

```bash
pip install -r eval/requirements.txt

# terminal 1 — start the sim env server (spawns Vite + headless browser):
node tools/sim-server.mjs                 # serves http://localhost:8010

# terminal 2 — run the eval (from the eval/ dir):
cd eval
python3 eval_chess.py --policy oracle --n 10                 # upper bound
python3 eval_chess.py --policy random --n 10 --save-video 3  # lower bound + videos
```

Validated baselines (env sanity): **oracle ≈ 100%**, **random ≈ 0%**.

## Running real π0.5 — TWO ways (see docs/pi05_integration.md)

### A) Locally on this Mac (LeRobot + MPS) — verified
π0.5 loads + runs on Apple-Silicon MPS via LeRobot (`.venv/` here). One click first:
**accept the gated PaliGemma license** at <https://huggingface.co/google/paligemma-3b-pt-224>.
```bash
.venv/bin/python eval/pi05_smoke.py     # loads pi05_base on MPS (proof)
.venv/bin/python eval/pi05_infer.py     # runs an inference (needs the license above)
# eval with a FINE-TUNED chess checkpoint (pi05_base won't zero-shot our robot):
.venv/bin/python eval/eval_chess.py --policy lerobot --lerobot-model <ckpt_dir> --n 30
```
Fine-tune path: `eval/convert_to_lerobot.py` (our episodes → LeRobotDataset) then
`lerobot-train --policy.type=pi05 --policy.pretrained_path=lerobot/pi05_base
--policy.device=mps ...` (command in the integration doc).

### B) Remote GPU server (upstream openpi)
```bash
pip install "openpi-client @ git+https://github.com/Physical-Intelligence/openpi.git#subdirectory=packages/openpi-client"
python3 eval_chess.py --policy openpi --policy-host <gpu-host> --policy-port 8000 --n 30
```
Serve with `eval/serve_pi05_modal.py` (Modal skeleton) or any Linux+NVIDIA box.

> ⚠️ Both need a checkpoint whose action space is our 5-DOF `[x,y,z,yaw,gripper]`.
> Public base checkpoints don't match — fine-tune on our data first.

## Files
- `sim_client.py` — HTTP client for the sim server.
- `policies.py` — `OraclePolicy`, `RandomPolicy`, `OpenpiPolicy` (+ `make_policy`).
- `tasks.py` — `(scenario, seed)` task lists.
- `eval_chess.py` — the eval loop; writes `results.json`, optional `rollouts/*.mp4`.
- `serve_pi05_modal.py` — Modal GPU serving skeleton.
