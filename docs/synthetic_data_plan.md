# Synthetic Trajectory Generation — Plan

Goal: build a **pipeline** that generates synthetic xArm5 episodes that are as
**in-distribution** as possible with the real Magnus rollouts (see
`docs/existing_dataset_catalog.md` and `docs/full_dataset_analysis.md`), to serve
as **mid-train** augmentation before final training on the real episodes. Every
generated episode carries a **manifest** recording every randomized variable, so
we can run ablations and slice results later.

We are **starting with a few scenarios** to prove the pipeline end-to-end. Target
counts, family splits, and the render compute story are deliberately **out of
scope for now** — we'll set those once a handful of episodes look right.

Decisions locked (this doc builds on them):
- Engine: **Three.js / kinematic** (reuse the existing xArm5 pipeline; no physics).
- Output: **folders of per-frame JPGs** (base + wrist) — *not* video files —
  plus `frames.jsonl` in the recorder's format. `state` is **sample-held**
  (updates ~every 3rd frame); the rendered image advances **every** frame.
- Datasets: emit as new **`synth_*`** datasets, mirroring the real layout.
- Pieces: **source 3D piece-model sets from online libraries** where possible
  (plus procedural fallbacks); each model id + license logged per episode.
- Randomization: **exhaustive**, but **meticulously logged** per episode.

---

## 1. Output format (must match the recorder exactly)

Per synthetic episode, mirror the real dataset layout — **a folder of frames, not
a video**:
```
synth_<name>/episodes/episode_XXXXXX/
  episode.json     # task, num_frames, success, duration_s
  frames.jsonl     # per frame: i, t, state[5], action[5]   (state SAMPLE-HELD)
  base/000000.jpg  # overhead, 320x240   (rendered at the true pose FOR THAT FRAME)
  wrist/000000.jpg # wrist,    320x240
  manifest.json    # NEW: every sampled scenario + randomization variable
```
Plus dataset-level `meta.json` and a recomputed `stats.json`.

### Frames vs. state — how they relate (measured, not assumed)
There is no "video." We generate a folder of still frames at the camera rate
(~13.7 fps; use the recorded per-frame Δt spread). Two distinct things per frame:

- **The image** is rendered at the arm's **true pose for that frame** — the pose
  advances every frame, so consecutive JPGs show incremental motion. Verified in
  the real data: consecutive `base/*.jpg` differ by ~1.8–2.7 mean pixel value
  **even across frames where the logged state was identical** — i.e. the real
  camera is continuous while state is polled slower. Our frames must do the same,
  or "runs of identical images" would be a trivial synthetic tell.
- **`state[i]`** is a **sample-and-hold** of that true pose: it only "updates"
  ~every 3rd frame (run-lengths 2–3, occasionally more; ~4.5 Hz effective),
  holding the last updated value in between — reproducing the recorder's polling
  artifact. `action[i] = state[i+1]` (also quantized).

So: read only `frames.jsonl` and synthetic ≈ real (same stair-stepped state);
look at the frames and the motion is continuous like real. Neither channel
reveals "synthetic."

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
existing `Xarm5Robot` (grasp offset already handled correctly). The **true**
per-frame poses feed the renderer; a **sample-held** copy feeds `frames.jsonl`.

---

## 3. Scenario & task types (what we can generate)

The real set is ~793 episodes of essentially two templates (all *moves* are the
white queen; piece variety appears only in 45 pickups — see
`docs/existing_dataset_catalog.md`). The synthetic pipeline widens along
**pieces × locations × task-type × randomization**. Task families, roughly in
build order (no target proportions yet — we'll tune the mix later):

**A. Parametric core (algorithmic — build first)**
1. `move the {color} {piece} from {A} to {B}` — all 12 piece identities, all
   from/to squares. Optionally a few distractor pieces on the board.
2. `pick up the {color} {piece}` — any piece, board or bare-table, varied
   location (like the chess_all pickups).

**B. Compound (algorithmic — later)**
3. `move … then move …` (2–3 chained moves in one episode).
4. Captures: move onto an occupied square, remove the captured piece
   (attach/despawn), matching a "take" motion.
5. Tidy/sort: move N pieces off the board / into a group.

**C. Claude-in-the-loop scenarios (later)**
6. `reset the chessboard` — Claude proposes a scrambled start position + the
   standard target, then we sequence the moves.
7. `set up position <FEN / description>` — Claude picks piece placements.
8. Semantically-guided clutter/backgrounds — Claude proposes plausible desk
   scenes (mugs, phones, keyboards — like the real backgrounds).

Every scenario resolves to a **list of (piece, from, to / pickup)** primitives +
a **scene spec** (board on/off, piece inventory & placements, randomization
seed). The planner then runs the motion model per primitive.

Collision note: travel height (318) is far above pieces (≤76), so traverses are
collision-free; only dense placements need a reachability/adjacency check on the
descend — flag & re-sample if the grasp column is blocked.

**First milestone scenarios (the "few"):** one white-queen `move` on a board
(the case we've already replicated), one `pick up` of a non-queen piece on the
bare table, and the same move with yaw=90° — enough to exercise every stage of
the pipeline (planner, IK, both cameras, state hold, manifest, validation).

---

## 4. Architecture

```
scenario generator ──► scene spec + manifest
       │                     │
       │             (algorithmic OR Claude-in-the-loop)
       ▼                     ▼
   motion planner ──► true TCP trajectory (waypoints @ measured speed)
       ▼
   Xarm5Robot IK (per frame) ──► joint angles
       ▼
   randomized renderer ──► base.jpg + wrist.jpg per frame (true per-frame pose)
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
episodes, small, near real) and **wide augmentation** (a fraction of episodes,
larger swings for generalization). Axes:

- **Pieces**: color/shade (continuous), material roughness/metalness, scale, and
  **geometry** — a library of **off-the-shelf 3D sets sourced online** (Staunton
  + novelty), each normalized to a common up-axis/scale and logged by model id +
  license; procedural lathe variants as a fallback / extra diversity. Candidate
  sources: **poly.pizza** (Google Poly archive, CC-BY, has low-poly chess),
  **Sketchfab** (filter to CC/downloadable), **Free3D / TurboSquid** free tiers,
  and printable STL sets (Thingiverse/Printables) converted to GLB. Store vetted
  models under `assets/pieces/<set>/` with a `LICENSE`/attribution file.
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

**Manifest schema** (per episode): `{ seed, dataset, task, template, pieces:[{id,color,geom,model,license,square/xy}], scene:{board, clutter[...]}, motion:{yaw, travelZ, graspZ, speed, dwell...}, cameras:{overhead, wrist}, lighting:{...}, textures:{...}, tier, engine_version }`. Flat, queryable, one row per episode for ablation slicing.

---

## 6. Validation (prove "in-distribution")

Automated, run over each synthetic batch and compared to the real distributions:
- **Motion stats**: travel height, grasp height, peak speed, phase durations,
  dwell fraction, gripper values, yaw split, home-pose spread — KS/overlap vs
  real. Gate the batch if any drifts out of the real spread.
- **State quantization**: hold-run-length histogram matches the real (2–3).
- **Frame continuity**: consecutive-frame image diff is non-zero during motion
  (no accidental duplicate/held frames), matching the real ~1.8–2.7 spread.
- **Reachability/IK**: TCP-follow error < a few mm; no IK failures.
- **Visual spot-checks**: sample frames vs real (as we've been doing).
- **Trajectory-space viz**: overlay synthetic vs real TCP paths.

---

## 7. Approach: start small, then widen

Deliberately no scale/compute plan yet — that's premature. Sequence:

1. **A few scenarios, end-to-end.** Generate the first-milestone scenarios (§3):
   one queen move, one bare-table pickup, one yaw=90° move. Confirm the output
   format, the frame-vs-held-state split, the manifest, and the validation
   harness all work and look right against real episodes.
2. **Widen the parametric core.** Any piece, any from/to, full randomization —
   still algorithmic. Review distributions vs real.
3. **Compound + Claude-in-the-loop** scenarios for task/scene diversity.
4. **Only then** decide counts, family mix, and render compute (local vs cloud)
   based on measured per-episode cost and how the reviewed episodes look.

---

## 8. Milestones

1. `src/synth/` scene+render module refactor from `src/xarm5/*`.
2. Motion planner (waypoint → true TCP) reproducing the measured profile;
   validate its stats match real.
3. State sample-and-hold + logger (frames.jsonl / episode.json / manifest.json)
   in the exact recorder format.
4. Piece-asset sourcing: vet a couple of online sets, normalize + load as GLB.
5. Randomization engine + manifest; scenario generator (parametric core).
6. Validation harness (distribution + frame-continuity matching).
7. **First few scenarios** rendered and reviewed against real episodes.
8. Widen the core; later add compound + Claude-in-the-loop.

---

## 9. Open decisions to confirm

1. **Piece sources**: OK to pull CC-licensed GLB sets from poly.pizza / Sketchfab
   (attribution kept in-repo), or do you want a specific/curated set?
2. **Wide-augmentation tier**: keep a two-tier (near-real jitter vs wide swings)
   scheme; what rough fraction goes "wide" (can defer until we see a few).
3. **Board realism**: the real boards are fairly plain — how far to push board
   texture/wear randomization vs staying close to the real look.

(Counts/splits and render compute intentionally deferred until the first few
scenarios are reviewed.)
