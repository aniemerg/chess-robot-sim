# Full Rollout Dataset — Analysis (for synthetic data generation)

Analysis of the **complete** Magnus rollout datasets (reassembled from the
`.tar.gz.part*` files under `rollouts/`, metadata extracted to
`rollouts/full/`). This is the reference for building a synthetic-trajectory
generator whose output is as close **in-distribution** as possible to this real
data.

## 1. Inventory

| dataset | episodes | tasks | notes |
|---|---|---|---|
| `chess_moves_v2` | **417** | 100% "move the white queen from X to Y" | yaw always 0° |
| `chess_all` | **376** | 331 moves + **45 pickups** | 40% of episodes use yaw=90° |
| **total** | **793** | | all **100% success** |

- **Move** tasks (748): always the *white queen*; 374 distinct from→to strings
  in v2 alone; from/to cover ~all 64 squares.
- **Pickup** tasks (45, chess_all only): "pick up the {color} {piece}" — black
  queen ×15, white king ×9, white bishop ×9, black bishop ×6, white rook ×6.
- Only two task templates exist: `move … from A to B` and `pick up the …`.
  This is the *narrowness* the synthetic set should widen (more pieces, more
  task types, richer scenes) while keeping the recorded motion style.

## 2. Trajectory schema (unchanged from the sample bundle)

Per-frame `state` and `action` = `[x, y, z, yaw, gripper]`:
- `x,y,z` — TCP position in **mm**, arm-base frame (Z up, +X forward, +Y left,
  desk ≈ z 0).
- `yaw` — TCP yaw in **degrees** (roll=180, pitch=0 fixed; 5-DOF).
- `gripper` — 0–1, **1 = open**.
- `action[i]` ≈ `state[i+1]` (measured error 2–4 mm/axis) — commanded next state.
- Cameras: `base` (overhead) + `wrist`, **320×240**, logged fps 15.

## 3. The motion profile (the key to in-distribution synthesis)

The recorded motion is **remarkably regular and parametric** — a fixed-height,
fixed-speed pick-and-place. Aggregated over all 748 move episodes:

| quantity | value | notes |
|---|---|---|
| **Home pose** (start) | (257, −33, 313) mm ± (6,7,5) | episodes start here |
| **End pose** | (261, −32, 309) mm ± (8,10,6) | returns to ≈ home |
| **Travel height** (carry) | **318 ± 2 mm** | strikingly constant |
| **Grasp/place height** (moves) | **46 ± 0 mm** | fixed — the TCP always descends to 46 mm |
| **Peak TCP speed** | **372 ± 3 mm/s** | constant-velocity segments, not smooth accel/decel |
| **Low-z dwell** | ~16% of frames | grasp + place settle |

**Phase structure** (a move):
```
home → approach + descend (+ optional yaw 0→90) → descend to grasp (z=46)
     → close gripper → lift to travel height (318) → traverse to target
     → descend to place (z=46) → open gripper → lift → retract to home (+ yaw 90→0)
```

**Pickups** are the same up to the grasp, then **lift high (~364 mm) and hold**
(no place phase). Pickup grasp height is **39 ± 11 mm** (piece-dependent, unlike
the fixed 46 mm for the queen moves).

### Gripper
- Open ≈ **1.0** (some episodes only reopen to ~0.5), closed ≈ **0.24**.
- Closes at the grasp (over ~0.7 s), opens at the place.

### Yaw (grip-plane orientation) — bimodal
- **643/793 episodes: yaw = 0°** (jaws in the default orientation).
- **150/793 episodes: yaw = 90°** — all in `chess_all` (40% of it; v2 is 0%).
- It is **binary per episode** (nothing between 0 and 90): the tool rotates
  0→90° during the approach, holds 90° through grasp/carry/place, and 90→0°
  during retract. J5 provides this (the grip plane + wrist camera rotate with it).

## 4. Logging characteristics (matters for matching)

- Frames are logged at ~15 fps, but **~34–68% of consecutive states are exact
  duplicates** — the robot state is polled slower (~7–10 Hz) than the camera.
  The speed trace is a stair-step: `0, 0, 370, 0, 370, …`. The *true* motion is
  smooth ~370 mm/s; the *logged* state is quantized. (Our replay already dedupes
  + resamples; a synthetic generator must decide whether to reproduce this
  quantization to look identical to the recorder — see open questions.)

## 5. Board geometry (board scenes)

From the grasp/release anchors (earlier analysis): board is on the desk (z≈0),
a1 center ≈ (251, 212) mm, **56.9 mm squares**, rank axis ≈ +X, file axis ≈ −Y,
~1.5° skew. `chess_moves_v2` and `chess_all` board poses match to a few mm.

## 6. Implications for synthetic generation

1. **A waypoint generator can reproduce this closely.** The motion is fully
   described by: home pose, travel height (318), grasp height (46/piece), peak
   speed (~370 mm/s), gripper open/closed values, per-episode yaw ∈ {0,90}, and
   the from/to (or pickup) locations. Interpolate through the phase waypoints at
   the recorded speed and gripper timing → a trajectory statistically identical
   to the real ones.
2. **Extend variety along the axes the data lacks**: any piece/color, any
   from/to, pickups of any piece, and *new task templates* (multi-move,
   board-reset, etc.) — while keeping the motion primitives.
3. **Render both cameras per frame** (base + wrist, 320×240) to produce training
   pairs in the recorded format (`frames.jsonl` + `base/` + `wrist/` +
   `episode.json`).
4. **Domain randomization** (piece shade/geometry, lighting, floor/table
   texture, background objects, camera pose, wrist-mount angle) layered on top,
   in two tiers: small in-distribution jitter for the bulk, wider augmentation
   for generalization.
5. **Quantization**: to be indistinguishable from the recorder, optionally
   re-quantize the synthetic state stream to the same ~7–10 Hz stair-step and
   set `action[i] = state[i+1]`.
