"""
Closed-loop chess evaluation. Drives the sim env (tools/sim-server.mjs) with a
policy (oracle | random | openpi/π0.5), over many tasks, and reports success.

Usage:
    # 1) start the sim server:   node tools/sim-server.mjs
    # 2) run the eval:
    python eval/eval_chess.py --policy oracle --n 10
    python eval/eval_chess.py --policy openpi --policy-host <gpu-host> --n 30
"""
import argparse
import base64
import json
import os
import subprocess
import time
from collections import defaultdict

from sim_client import SimClient
from policies import make_policy
from tasks import build_tasks, SCENARIOS


def _save_video(frames_b64, path):
    """Write base64 base-cam frames to a folder + ffmpeg an mp4 (best effort)."""
    d = path + "_frames"
    os.makedirs(d, exist_ok=True)
    for i, b in enumerate(frames_b64):
        with open(f"{d}/{i:05d}.jpg", "wb") as f:
            f.write(base64.b64decode(b))
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "20", "-i", f"{d}/%05d.jpg",
                        "-pix_fmt", "yuv420p", path], check=True)
    except Exception:
        pass


def run_episode(sim, policy, scenario, seed, max_infer, exec_horizon, record=False):
    obs = sim.reset(scenario, seed)
    info = sim.info()
    info["task"] = obs.get("task", "")
    policy.reset(info)
    frames = [obs["base"]] if record else None
    succ = {"success": False}
    for _ in range(max_infer):
        chunk = policy.infer(obs)
        n = len(chunk) if exec_horizon is None else min(exec_horizon, len(chunk))
        for a in chunk[:n]:
            obs = sim.step(a)
            if record:
                frames.append(obs["base"])
        succ = sim.success()
        if succ.get("success"):
            break
    return {"scenario": scenario, "seed": seed, "task": info["task"], **succ}, frames


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--policy", default="oracle", choices=["oracle", "random", "openpi"])
    ap.add_argument("--policy-host", default="localhost")
    ap.add_argument("--policy-port", type=int, default=8000)
    ap.add_argument("--sim-host", default="localhost")
    ap.add_argument("--sim-port", type=int, default=8010)
    ap.add_argument("--n", type=int, default=10, help="tasks per scenario")
    ap.add_argument("--scenarios", nargs="*", default=SCENARIOS)
    ap.add_argument("--max-infer", type=int, default=80, help="max policy calls per episode")
    ap.add_argument("--exec-horizon", type=int, default=None, help="actions to execute per policy call (default: all)")
    ap.add_argument("--out", default="results.json")
    ap.add_argument("--save-video", type=int, default=0, help="save base-cam rollout mp4 for the first N episodes")
    args = ap.parse_args()

    sim = SimClient(args.sim_host, args.sim_port)
    if not sim.health():
        raise SystemExit(f"sim server not reachable at {args.sim_host}:{args.sim_port} — run `node tools/sim-server.mjs` first")
    policy = make_policy(args.policy, host=args.policy_host, port=args.policy_port)

    tasks = build_tasks(args.scenarios, args.n)
    print(f"policy={args.policy}  tasks={len(tasks)}  ({args.n}/scenario)")
    results, t0 = [], time.time()
    for i, (sc, sd) in enumerate(tasks):
        record = i < args.save_video
        r, frames = run_episode(sim, policy, sc, sd, args.max_infer, args.exec_horizon, record=record)
        results.append(r)
        if record and frames:
            os.makedirs("rollouts", exist_ok=True)
            _save_video(frames, f"rollouts/{args.policy}_{sc}_{sd}.mp4")
        print(f"[{i+1}/{len(tasks)}] {sc} seed={sd} -> {'OK ' if r['success'] else 'FAIL'}  {r.get('dist_mm', r.get('maxLiftZ_mm',''))}  | {r['task']}")

    by = defaultdict(lambda: [0, 0])
    for r in results:
        by[r["scenario"]][0] += int(bool(r["success"]))
        by[r["scenario"]][1] += 1
    total = sum(int(bool(r["success"])) for r in results)
    print("\n=== baseline ===")
    for sc, (ok, n) in by.items():
        print(f"  {sc:20} {ok}/{n}  ({100*ok/n:.0f}%)")
    print(f"  {'TOTAL':20} {total}/{len(results)}  ({100*total/len(results):.0f}%)   in {time.time()-t0:.0f}s")

    with open(args.out, "w") as f:
        json.dump({"policy": args.policy, "results": results,
                   "summary": {sc: {"success": ok, "n": n} for sc, (ok, n) in by.items()}}, f, indent=2)
    print(f"  wrote {args.out}")


if __name__ == "__main__":
    main()
