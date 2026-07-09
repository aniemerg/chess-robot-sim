# Existing Collected Dataset — Catalog

A plain-language inventory of the **real teleoperated data we were given**
(collected by someone else, used to fine-tune pi0.5). This documents *what tasks
are present and how much data there is* — a reference for anyone who hasn't
reviewed it. (For the motion/trajectory analysis see
`docs/full_dataset_analysis.md`; for the sample-bundle format see
`docs/rollout_data_analysis.md`.)

## What this is
Real **UFACTORY xArm 5 + gripper** episodes, teleoperated, over a chessboard on a
desk. Each episode is a natural-language **task** + a recorded **trajectory**
(TCP pose + gripper per frame) + two camera streams (**base** overhead and
**wrist**, 320×240). It's split into two datasets that were collected somewhat
differently.

## Totals at a glance

| | episodes | frames | images (2 cams) | footage | on disk (tar) |
|---|---|---|---|---|---|
| `chess_moves_v2` | 417 | 70,614 | 141,228 | ~83 min | ~2.9 GB |
| `chess_all` | 376 | 71,859 | 143,718 | ~88 min | ~3.1 GB |
| **TOTAL** | **793** | **142,473** | **~284,946** | **~171 min (2.85 h)** | **~6 GB** |

- **All 793 episodes are marked `success: true`** (no failures in the set).
- Source archives in `rollouts/archives/` (`chess_moves_v2.tar.gz.part00..05`,
  `chess_all.tar.gz.part00..06`); extracted full dataset (trajectories **and**
  images) in `rollouts/full/`. A curated 8-episode sample lives in
  `rollouts/samples/`. See `rollouts/README.md` for the layout.

## The tasks — full breakdown

There are **only two task templates** across the entire dataset:
`move the {color} {piece} from {square} to {square}` and
`pick up the {color} {piece}`.

### `chess_moves_v2` — 417 episodes, ALL moves
- Every episode: **"move the white queen from A to B."** Only the *white queen*
  ever moves.
- **Square coverage**: all **64** from-squares and **63/64** to-squares are used;
  **374 distinct (from→to) pairs**, 41 pairs repeated. So it broadly samples
  queen moves across the whole board.
- yaw is always 0° (gripper never rotates).
- Duration 8.3–15.9 s (mean 11.9); frames p10/p50/p90 = 140/171/196, max 226.

### `chess_all` — 376 episodes: 331 moves + 45 pickups
- **331 moves**: again all **"move the white queen from A to B"** (same template).
  Uses 48/64 squares, 308 distinct pairs. **40% of these rotate the tool to
  yaw = 90°** for the pick-place (vs 0% in `chess_moves_v2`).
- **45 pickups** — "pick up the {color} {piece}" — the *only* place with piece
  variety. These are the first 45 episodes (`episode_000000`–`000044`):

  | piece | count | episode range |
  |---|---|---|
  | black queen | 15 | 000000–000014 |
  | white king | 9 | 000015–000023 |
  | black bishop | 6 | 000024–000029 |
  | white bishop | 9 | 000030–000038 |
  | white rook | 6 | 000039–000044 |

  Pickups run longer (up to 367 frames / 31.5 s) — they descend, grasp, and lift
  the piece high (no place phase).

### Piece / color coverage summary
- **Moves** (748 total): only ever the **white queen**.
- **Pickups** (45 total): **black queen, white king, black bishop, white bishop,
  white rook** — 5 of the 12 possible {color × piece} identities.
- Pieces never seen acting: **pawn, knight** (any color), **black king, black
  rook, white queen-pickup**, and any *move* of a non-queen piece.

## What one episode contains
```
episode_XXXXXX/
  episode.json   # { index, task, num_frames, success, duration_s }
  frames.jsonl   # one line/frame: { i, t, state[5], action[5] }
                 #   state/action = [x, y, z (mm), yaw (deg), gripper (0-1, 1=open)]
  base/*.jpg     # overhead camera, 320x240, one per frame
  wrist/*.jpg    # wrist camera,    320x240, one per frame
```
Dataset-level `meta.json` (fps 15, cameras, state/action names, image size) and
`stats.json` (normalization mean/std/min/max/q01/q99 over the full set).

## The shape of the distribution (what it is — and isn't)
- **Very narrow task language**: two templates; the overwhelming majority
  (748/793) is "move the white queen." Only 45 episodes touch other pieces, and
  only as pickups.
- **No** captures, multi-step tasks, board setup/reset, non-queen *moves*,
  pawns/knights, or any task beyond move/pick.
- **Highly consistent execution**: 100% success, tight motion profile (fixed
  home pose, ~318 mm travel height, ~46 mm grasp height, ~370 mm/s), gripper
  0.24↔1.0, yaw ∈ {0°, 90°}.

This narrowness is precisely the gap the **synthetic data plan**
(`docs/synthetic_data_plan.md`) targets: keep this exact motion style, but
broaden pieces, squares, task types, and visual variety.
