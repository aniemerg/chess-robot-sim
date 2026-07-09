# Magnus Rollout Data — Analysis & Incorporation Plan

Analysis of the 8-episode sample bundle (`rollouts/samples/`) with an eye toward
**exceptionally close replication** of the real episodes in our simulator.

> **Headline:** Yes — the bundle contains the full **path taken by the robot**
> (per-frame TCP pose + gripper), plus the **commanded action** at each step.
> It also, as a bonus, lets us recover the **exact board pose in the robot
> frame** to sub-millimeter accuracy. This turns replication from "eyeball the
> cameras" into "drive the arm along the recorded trajectory."

---

## 1. What the bundle contains

```
rollouts/samples/
  README.md
  <dataset>/                       # chess_moves_v2  and  chess_all
    meta.json                      # fps, camera names, state/action schema
    stats.json                     # normalization stats over the FULL dataset
    episodes/episode_XXXXXX/
      episode.json                 # task, num_frames, success, duration_s
      frames.jsonl                 # one JSON per frame: i, t, state[5], action[5]
      base/000000.jpg  ...         # overhead camera, 320x240
      wrist/000000.jpg ...         # wrist camera,   320x240
```

Two datasets, 8 sample episodes total (the same 8 we already have as videos):

| dataset | episodes | task shape |
|---|---|---|
| `chess_moves_v2` | 001, 135, 267, 399 | "move the white queen from _X_ to _Y_" |
| `chess_all` | 011, 016, 036, 045 | "pick up the _piece_" and one move (045) |

The README states these are real **UFactory xArm 5 + xArm Gripper** episodes
used to fine-tune **pi0.5** (a VLA policy). Full datasets are ~420 episodes each.

---

## 2. The trajectory schema (the path)

`frames.jsonl`, one line per frame:

```json
{"i": 0, "t": 0.0,
 "state":  [268.755, -33.295, 311.285, 0.0, 1.001],
 "action": [252.197, -34.801, 318.980, 0.0, 1.0]}
```

`state` and `action` are both `[x, y, z, yaw, gripper]`:

| field | units | meaning |
|---|---|---|
| `x, y, z` | **mm**, arm-base frame | TCP (tool center point) position |
| `yaw` | **degrees** | TCP yaw. **roll=180°, pitch=0° are fixed** (5-DOF arm) |
| `gripper` | 0–1 | normalized (**1 = open**, SDK units / 850) |

- **`state[i]`** is the measured TCP pose at frame `i` → **this is the path**.
- **`action[i]`** is the commanded/next-step target (standard VLA convention).

### Arm-base frame convention (recovered)
- **+x** = forward, away from the base (the reach direction)
- **+y** = to the arm's left
- **+z** = up; **desk surface is z ≈ 0**

---

## 3. Empirical findings (from the 8 sample episodes)

Measured directly from `frames.jsonl`:

- **Timing:** frames are ~**14 fps** (mean Δt ≈ 0.072 s), not exactly the 15 fps
  in `meta.json`. About **34 % of frames repeat the previous state** — the
  camera logs faster than the teleop pose updates (holds/dwell).
- **`yaw` is effectively constant** at 0° (max seen 0.008°) in **every** sample
  episode. The gripper never rotates about vertical here — it always points
  straight down. **This matches our simulator's vertical-tool IK exactly.**
- **`gripper`** is a clean open→close→open story:
  - Move tasks: start open (~1.0), **close (~0.24–0.34) to grasp**, carry
    closed, **reopen to release**, end open. (e.g. ep001: close @frame 62,
    reopen @139 of 182.)
  - Pick tasks (011/016): approach open, **close near the end** to grab.
- **Workspace** (full-dataset `stats.json`, `chess_moves_v2`, 420 eps / 71k frames):
  `x ∈ [250, 660]`, `y ∈ [-186, 224]`, `z ∈ [45, 320]` mm.
  `z_min ≈ 45 mm` is the grasp height; `z ≈ 318 mm` is the travel height.
- **`action` predicts `state[i+1]` to a few mm** (mean abs error x 3.1, y 1.5,
  z 3.6 mm; yaw 0; gripper 0.09). The commanded per-step delta
  (`action[i] − state[i]`) averages ~6–8 mm, max ~28 mm. So the arm tracks the
  command tightly, and the control is a stream of small Cartesian increments.
- **Path length** (ep001) ≈ 1.47 m of TCP travel over ~13 s.

---

## 4. Board pose recovered from the data (high value)

Because every move episode grasps at the *from* square and releases at the *to*
square — both at `z ≈ 46 mm` — the grasp/release TCP positions are **known
(file, rank) → (x, y) correspondences**. Fitting an affine grid to 8 such
anchors from 4 episodes gives, in the **arm-base frame (mm)**:

```
x_mm = 1.61·file + 56.81·rank + 251.49
y_mm = -56.89·file + 1.28·rank + 211.65      (file: a=0..h=7, rank: 1=0..8=7)
```

- **Fit residual: mean 0.52 mm, max 0.91 mm** — the model is essentially exact.
- **Square pitch ≈ 56.9 mm** (a standard tournament board).
- **rank axis ≈ +x**, **file axis ≈ −y**, board skewed only ~1.5°.
- `a1 center ≈ (251.5, 211.6)`, `h8 center ≈ (660.5, −177.6)`.
- Physically: **rank 1 is nearest the base, rank 8 farthest; the a-file is on
  the arm's +y (left) side, the h-file on the −y (right) side.**

This means we do **not** need to guess board placement — the data pins it down.

---

## 5. Cameras

- Raw frames are **320 × 240**, two views: `base` (overhead) and `wrist`.
- Our existing gallery videos are **640 × 272**: the two 320-wide views placed
  **side by side** (640 × 240) with a **~32 px caption bar** on top → 272.
  (So the video layout we already reproduce is exactly `[caption | base | wrist]`.)
- No camera **extrinsics/intrinsics** are provided. Overhead/wrist poses still
  have to be calibrated visually (as we did for v2_001), OR — better — derived
  by projecting the known 3-D board corners onto the images (see §8).

---

## 6. The "inputs" / control model (the implicit buttons)

The user's question: these were human-teleoperated, so what were the operator's
inputs, and are they in the data?

**What is in the data:** the `action` stream — a ~14 Hz sequence of commanded
TCP targets `[x, y, z, yaw, gripper]`. **Raw device/button events are NOT
stored.** So we recover the input at the level of *Cartesian commands*, not
keystrokes.

**What the inputs must have been:** since `yaw` never moves and only `x, y, z,
gripper` change, the operator controlled **4 degrees of freedom**:
translate-X, translate-Y, translate-Z, and gripper open/close. That is the
signature of a **3-axis Cartesian jog (e.g. SpaceMouse / leader-arm / arrow
keys) + a gripper toggle** — roll/pitch/yaw were locked by the teleop rig.

We can model the input at two levels:

1. **Low-level (exact):** the per-step command is `Δ = action[i] − state[i]`
   (a small Cartesian increment) plus a gripper command. Replaying this is an
   exact open-loop reproduction of what the operator did.
2. **High-level (inferred "buttons"):** segment each episode into primitives —
   `GO_TO(square) · DESCEND · GRIP · LIFT · GO_TO(square) · DESCEND · RELEASE ·
   LIFT · HOME`. The gripper transitions and z-plateaus make these segments
   trivially detectable (§3). This is the abstract "button" schema; it is
   *inferred*, not recorded.

**Determining the input schema** (an open task, §9) means deciding which of
these we drive the sim with, and — if we want to *generate* new paths — fitting
a small model `input → trajectory` (e.g. a trapezoidal-velocity move-to-target
primitive whose speed/accel we tune to match the real Δ statistics).

---

## 7. Normalization stats (`stats.json`)

Per-channel `mean/std/min/max/q01/q99` for `state` and `action`, computed over
the **full** dataset (420 eps). Needed only if we train/evaluate a policy; the
README warns not to recompute from the 8 samples. Not required for geometric
replication, but useful for sanity-checking that our simulated trajectories fall
in-distribution.

---

## 8. How to incorporate this into the simulator

Ordered from highest fidelity / lowest effort to most ambitious.

### Phase A — Path-follow replication (drive the sim from `state`)
Replace the hand-authored pick-and-place timeline (in `src/export.ts`) with the
**recorded trajectory**:
1. Load `frames.jsonl` for the episode.
2. For each frame, map `state`(x,y,z mm, arm-base) → sim world target (§ mapping
   below), solve the existing **vertical-tool IK**, set the gripper from
   `state.gripper`.
3. Render the composite at the recorded timestamps.

This reproduces the *actual* motion frame-for-frame (dwells, approach curves,
speed) instead of an idealized move — the biggest single fidelity win.

**Coordinate mapping (data arm-base → our world).** Our world is y-up with the
board at a chosen center; the data is z-up in the arm-base frame. A rigid map:
`world = R · (data_mm / 1000) + t`. We can fix `R, t` two ways:
- **Analytically:** the data board grid (§4) and our sim board squares are both
  known, so solve for the transform that maps data (a1, h1, a8) to our sim
  square centers. (Also repositions the robot base consistently.)
- Simplest realization: put the **sim's arm-base frame = the data frame** (align
  our robot base to the data origin, axes x-forward/y-left/z-up) and place the
  board via §4. Then `state` maps in almost 1:1 (just mm→m and the y-up swap).

### Phase B — Data-driven camera calibration
With the board's 3-D pose known (§4), project the board corners into the `base`
and `wrist` images and solve for each camera's pose (PnP). This replaces manual
camera calibration with a fitted extrinsic per dataset — much tighter than the
current eyeballed presets, and it gives us the wrist camera's real mounting.

### Phase C — Input-driven replication (generate paths)
Implement the two-level input model (§6):
- a **command replay** mode (feed `action`, integrate a simple tracking model
  `state[t+1] ≈ action[t]` validated at ~3 mm error), and
- a **primitive/"button" mode** that regenerates a comparable path from
  `GO_TO / DESCEND / GRIP / LIFT / RELEASE` given only the from/to squares,
  with velocity/accel tuned to the real Δ statistics.

This is what lets the sim produce *new* episodes that look operator-driven, not
just replay recorded ones.

### Phase D — Validation harness
- Overlay sim vs real: TCP position error over time (sim IK solution vs `state`).
- Frame-diff the rendered `base`/`wrist` against the real jpgs.
- Report per-episode residuals; target < a few mm TCP and visually-aligned views.

---

## 9. Open questions / decisions to make

1. **Which input to drive with** — exact `state` replay (Phase A), `action`
   replay, or inferred primitives (Phase C)? For "as close as possible," Phase A
   first; Phase C for generating new motion.
2. **The base↔world transform** — adopt the data's arm-base frame as our world
   frame (cleanest), or keep our current world and fit `R,t`? Affects everything
   downstream; recommend adopting the data frame.
3. **Camera extrinsics** — invest in PnP from the board corners (Phase B) for
   the base cam, and figure the wrist cam's true mount, vs. keep visual presets.
4. **Timing** — replay at the recorded per-frame Δt (~14 fps, with the natural
   dwells/duplicates) rather than a synthetic 15 fps, to match cadence.
5. **Gripper geometry** — the real `z_min ≈ 45 mm` at grasp implies a specific
   TCP-to-fingertip offset; we should match our gripper's grasp height to it so
   pieces meet the fingers at the same z.
6. **Scope** — 8 sample episodes now; the full 420-episode datasets exist if we
   want broader coverage or to fit the input model on real statistics.
7. **Non-vertical cases** — yaw is fixed here, but the full dataset may contain
   yaw motion; our vertical-tool IK would need a yaw DOF (we have J5) to cover
   that. Confirm before assuming vertical-only.

---

## 10. Summary

- The path **is** in the data: per-frame TCP pose (`state`) + commanded target
  (`action`), ~14 fps, mm / degrees / 0-1 gripper, arm-base frame.
- yaw is fixed (vertical tool) — perfectly compatible with our IK.
- The recorded grasp/release points recover the **board pose in the robot frame
  to ~0.5 mm**, removing all board-placement guesswork.
- Raw operator "buttons" are **not** stored; the recoverable input is a stream of
  Cartesian jog commands + gripper, which we can replay exactly or abstract into
  move-to-target primitives.
- Recommended path: **Phase A (trajectory replay)** for immediate, exceptionally
  close replication, then **B (data-fit cameras)** and **C (input model)**.
