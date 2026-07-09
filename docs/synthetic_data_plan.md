# Synthetic Trajectory Generation — Plan

Goal: generate **~10× the recorded data** (~8,000 synthetic episodes) that is as
**in-distribution** as possible to the real Magnus rollouts, to serve as a
**mid-train** augmentation before final training on the real episodes. Every
generated episode carries a **manifest** recording every randomized variable, so
we can run ablations and slice results later.

Decisions locked (this doc builds on them):
- Engine: **Three.js / kinematic** (reuse the existing xArm5 pipeline; no physics).
- Fidelity: **stair-stepped `state`** (matches the recorder), **smooth video**.
- Scope: **parametric moves + pickups, any piece** is the core; complex
  Claude-in-the-loop scenarios layered on.
- Randomization: **exhaustive**, but **meticulously logged** per episode.

References: `docs/full_dataset_analysis.md` (measured motion profile + logging).

---

## 1. Output format (must match the recorder exactly)

Per synthetic episode, mirror the real dataset layout:
```
<dataset>/episodes/episode_XXXXXX/
  episode.json     # task, num_frames, success, duration_s
  frames.jsonl     # per frame: i, t, state[5], action[5]   (STAIR-STEPPED)
  base/000000.jpg  # overhead, 320x240   (SMOOTH true pose each frame)
  wrist/000000.jpg # wrist,    320x240   (SMOOTH)
  manifest.json    # NEW: every sampled scenario + randomization variable
```
Plus dataset-level `meta.json` and a recomputed `stats.json`.

### The stair-step / smooth split (key)
- The **true motion** is a smooth waypoint trajectory (§3), sampled at the camera
  rate (~13.7 fps; use the recorded per-frame Δt distribution).
- **Images** render the *true* pose at every frame → smooth video.
- **`state[i]`** is a **sample-and-hold** of the true pose: the state only
  "updates" every ~3 frames (run-lengths 2–3, occasionally more; ~4.5 Hz
  effective), holding the last updated value in between — reproducing the
  recorder's polling artifact. `action[i] = state[i+1]` (also quantized).
- Result: given only `frames.jsonl`, synthetic ≈ real; given the video, motion
  is smooth like real. A model can't trivially learn "smooth ⇒ synthetic."

---

## 2. Motion model (the measured primitives)

All values from `docs/full_dataset_analysis.md`, with small per-episode jitter to
avoid degenerate identical trajectories (jitter ranges are randomization knobs,
logged in the manifest):

| primitive | value (jitter) |
|---|---|
| Home / start & end pose | (257, −33, 313) mm (± a few mm) |
| Travel (carry) height | 318 mm (± 4) |
| Grasp/place height (queen) | 46 mm; pickups piece-dependent 39 ± 11 |
| Peak TCP speed | 372 mm/s (± ~5%) — constant-velocity segments |
| Gripper open / closed | 1.0 (or ~0.5) / 0.24 |
| Grip-plane yaw | ∈ {0°, 90°}, per-episode; 90° held through the pick-place |
| Low-z dwell at grasp/place | ~0.5 s each |

**Phase machine** (a move):
`home → approach+descend (+opt yaw 0→90) → descend to grasp(z≈46) → close →
lift to travel(318) → traverse → descend to place → open → lift → retract home
(+opt yaw 90→0)`.
**Pickup** = same up to grasp, then lift high (~364) and hold (no place).

The planner emits waypoints, interpolates at the target speed (trapezoid-ish but
near-constant velocity to match the data), times the gripper open/close to the
low-z dwells, and blends yaw over the approach/retract. IK per frame via the
existing `Xarm5Robot` (grasp offset already handled correctly).

---

## 3. Scenario & task taxonomy (how we reach 10×)

The real set is ~793 episodes of essentially two templates. We widen along
**pieces × locations × task-type × randomization**. Proposed families:

**A. Parametric core (algorithmic, the bulk — target ~70%)**
1. `move the {color} {piece} from {A} to {B}` — all 12 piece identities, all
   from/to squares. Optionally a few distractor pieces on the board.
2. `pick up the {color} {piece}` — any piece, board or bare-table, varied
   location (like chess_all pickups).

**B. Compound (algorithmic — target ~20%)**
3. `move … then move …` (2–3 chained moves in one episode).
4. Captures: move onto an occupied square, remove the captured piece
   (attach/despawn), matching a "take" motion.
5. Tidy/sort: move N pieces off the board / into a group.

**C. Claude-in-the-loop scenarios (target ~10%)**
6. `reset the chessboard` — Claude proposes an interesting scrambled start
   position and the standard target, then we sequence the many moves.
7. `set up position <FEN / description>` — Claude picks piece placements.
8. Semantically-guided clutter/backgrounds — Claude proposes plausible desk
   scenes (mugs, phones, keyboards — like the real backgrounds).

Every scenario resolves to a **list of (piece, from, to / pickup)** primitives +
a **scene spec** (board on/off, piece inventory & placements, randomization
seed). The planner then runs the motion model per primitive.

Collision note: travel height (318) is far above pieces (≤76), so traverses are
collision-free; only dense placements need a reachability/adjacency check on the
descend — flag & re-sample if the grasp column is blocked.

---

## 4. Architecture

```
scenario generator ──► scene spec + manifest
       │                     │
       │             (algorithmic OR Claude-in-the-loop)
       ▼                     ▼
   motion planner ──► smooth TCP trajectory (waypoints @ measured speed)
       ▼
   Xarm5Robot IK (per frame) ──► joint angles
       ▼
   randomized renderer ──► base.jpg + wrist.jpg per frame  (smooth)
       ▼
   logger ──► frames.jsonl (sample-held state), episode.json, manifest.json
```
- Build on `src/xarm5/*` (robot, board, replay scene). Factor the scene +
  render into a reusable `src/synth/` module; a headless driver renders episodes
  in batch (extend `tools/render-replay.mjs`).
- Determinism: a single integer **seed** per episode drives all sampling; the
  manifest records the seed + resolved values so any episode is reproducible.

---

## 5. Domain randomization catalog (exhaustive; all logged in manifest)

Two tiers per episode (tier is itself logged): **in-distribution jitter** (most
episodes, small, near real) and **wide augmentation** (a configurable fraction,
larger swings for generalization). Axes:

- **Pieces**: color/shade (continuous), material roughness/metalness, scale,
  and **geometry** — procedural lathe variants now; a library of off-the-shelf
  GLB Staunton/novelty sets later (each model id logged).
- **Board**: light/dark colors, square size, border, coordinate labels on/off,
  surface wear/texture, slight in-plane pose jitter.
- **Table/floor**: texture family (wood / stone / cloth / gradient / plain) and
  color; roughness.
- **Lighting**: number, direction, intensity, color temperature, shadow
  softness, ambient level.
- **Cameras**: overhead pose (position, target, fov, roll) jitter around the
  calibrated setups A/B/C; **wrist mount** offset/tilt/roll jitter.
- **Background**: 3D clutter objects (mugs, phone, keyboard, books) placed off
  the workspace, and/or an environment backdrop — to avoid a plain infinite bg.
- **Robot**: base position jitter (small), gripper finger geometry/width,
  optional link color.
- **Motion**: speed, travel/grasp heights, dwell times, yaw ∈ {0,90}, approach
  arc — small jitter within the measured spread.
- **Camera/sensor**: jpg quality, mild blur/noise/exposure (to match webcam look).

**Manifest schema** (per episode): `{ seed, dataset, task, template, pieces:[{id,color,geom,square/xy}], scene:{board, clutter[...]}, motion:{yaw, travelZ, graspZ, speed, dwell...}, cameras:{overhead, wrist}, lighting:{...}, textures:{...}, tier, engine_version }`. Flat, queryable, one row per episode for ablation slicing.

---

## 6. Validation (prove "in-distribution")

Automated, run over each synthetic batch and compared to the real distributions:
- **Motion stats**: travel height, grasp height, peak speed, phase durations,
  dwell fraction, gripper values, yaw split, home-pose spread — KS/overlap vs
  real. Gate the batch if any drifts out of the real spread.
- **State quantization**: hold-run-length histogram matches the real (2–3).
- **Reachability/IK**: TCP-follow error < a few mm; no IK failures.
- **Visual spot-checks**: sample composites vs real (as we've been doing).
- **Trajectory-space viz**: overlay synthetic vs real TCP paths.

---

## 7. Scale & compute (phased)

Rendering ~8,000 × ~180 frames × 2 cameras ≈ **~2.9M images** — the real cost.
- **Phase 0 — proof (≈50 episodes)**: end-to-end for the parametric core; verify
  format + stair-step/smooth split + validation harness + manifest.
- **Phase 1 — core at scale (few k)**: parametric moves + pickups, any piece,
  full randomization. Parallelize headless rendering (worker pool; each worker a
  headless context). Estimate throughput, decide **local vs cloud**.
- **Phase 2 — compound + Claude-in-the-loop** to fill the 10× and add diversity.
- **Phase 3 — full randomization sweep + validation + packaging**.

Open compute decision: single-machine (Mac, over days) vs a cloud render farm —
depends on the throughput measured in Phase 1.

---

## 8. Milestones

1. `src/synth/` scene+render module refactor from `src/xarm5/*`.
2. Motion planner (waypoint → smooth TCP) reproducing the measured profile;
   validate its stats match real.
3. State sample-and-hold + logger (frames.jsonl / episode.json / manifest.json)
   in the exact recorder format.
4. Randomization engine + manifest; scenario generator (parametric core).
5. Validation harness (distribution matching).
6. Phase-0 proof batch (~50), reviewed.
7. Scale + compound + Claude-in-the-loop scenarios.

---

## 9. Open decisions to confirm

1. **Target counts / split** across families A/B/C (I proposed 70/20/10).
2. **Compute**: local vs cloud for the ~3M-image render (decide after Phase-1
   throughput).
3. **Piece-model library**: procedural-only to start, or source GLB sets now?
4. **Dataset identity**: emit as new `synth_*` datasets, or mix into the real
   dataset layout for training?
5. **Randomization ranges**: I'll propose concrete numeric ranges per axis in the
   implementation; confirm the "wide augmentation" fraction (e.g. 15–25%).
