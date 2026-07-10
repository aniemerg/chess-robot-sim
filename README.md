# xArm5 Chess — simulator & synthetic training data

This project builds toward one goal: **generate large amounts of synthetic
training data** for a robot policy that drives a UFACTORY **xArm 5** arm to move
chess pieces — data that is as **in-distribution** as possible with a set of real
teleoperated episodes we were given (the "Magnus rollouts").

The synthetic data is meant as **mid-train augmentation**: broaden the pieces,
squares, tasks, scenes, lighting, and camera variety far beyond what the ~793
real episodes cover, while keeping the exact recorded motion style — then
fine-tune on the real episodes.

To get there we built a Three.js **kinematic simulator** of the arm and board,
proved it can **replicate** real episodes frame-for-frame (calibrated cameras +
recorded trajectories), and analyzed the real dataset in depth. The synthetic
generator is the next step.

## The story, in four workstreams

1. **Understand the real data.** ~793 real teleoperated episodes across two
   datasets, each = a natural-language task + per-frame TCP pose/gripper + base
   (overhead) and wrist camera JPGs. Cataloged and analyzed in `docs/`.
   → `docs/existing_dataset_catalog.md`, `docs/full_dataset_analysis.md`
2. **Simulate the arm.** A Three.js xArm 5 using the **official** UFACTORY
   kinematics + meshes, in the ROS arm-base frame, with a CCD IK solver that
   keeps the tool vertical and locks grip-plane yaw.
   → `src/xarm5/`
3. **Replicate real episodes.** Calibrate the overhead + wrist cameras to the
   real views, drive the arm along a recorded trajectory, and render a
   side-by-side comparison. This is how we validated the sim against reality.
   → `src/xarm5/replay.ts`, `src/xarm5/calibrate.ts`, `replicas/`
4. **Generate synthetic data (next).** A pipeline that plans in-distribution
   trajectories, renders per-frame base+wrist JPGs with domain randomization,
   and logs a per-episode manifest of every randomized variable for ablations.
   → `docs/synthetic_data_plan.md`, planned under `src/synth/`

## Repository map

```
README.md                This file — the project narrative.
docs/                    Analysis + plans (start at docs/README.md).
  existing_dataset_catalog.md   What tasks/how much data is in the real set.
  full_dataset_analysis.md      The real motion profile (heights, speed, yaw…).
  rollout_data_analysis.md      Deep-dive on the 8-episode sample bundle.
  synthetic_data_plan.md        Plan for the synthetic generator.
  original-simulator-plan.md    Historical: the original crude-sim build plan.
  xarm_ros_official/            Official xArm5 URDF/kinematics reference files.
rollouts/                The real robot data (gitignored; see rollouts/README.md).
src/xarm5/               CURRENT pipeline: official arm model, IK, replay, calibrate.
src/                     LEGACY interactive simulator (crude primitives) + its tools.
public/                  Static assets served to the browser (meshes, sample episodes).
tools/                   Headless (Playwright/ffmpeg) render + probe drivers.
replicas/                Rendered sim replicas of real episodes (gitignored outputs).
```

Two generations of the simulator live side by side. `src/xarm5/*` is the current
one (official model, ROS frame, real-data replication). The top-level `src/*.ts`
(`main.ts`, `robot.ts`, `chessboard.ts`, `pieces.ts`, `ik.ts`, plus
`export.ts` / `calibrate.ts` and `src/replication/`) is the **earlier** crude
simulator — a hand-built primitive arm with analytical vertical-tool IK and an
interactive board editor. It's kept for reference; new work is in `src/xarm5/`.

## Quick start

```bash
npm install
npm run dev        # start the Vite dev server (prints a localhost URL)
npm run build      # type-check + production build into dist/
npm run typecheck  # type-check only
npm run test:ik    # headless FK/IK sanity check (legacy sim; solves every square)
```

Entry points (Vite multi-page; open each at the dev URL):

| Page | Loads | What it is |
| --- | --- | --- |
| `index.html` (default) | `src/synth/viewer.ts` | **Synthetic scenario viewer** — generate a scenario, orbit/scrub the sim, see base+wrist cams, waypoints, and the episode.json/manifest/frames.jsonl behind it. |
| `synth.html` | `src/synth/generate.ts` | Headless synth episode (used by the batch writers). |
| `env.html` | `src/synth/env.ts` | Closed-loop policy env (reset/step/success) — driven by `tools/sim-server.mjs` for the π0.5 eval (`eval/`, see `docs/pi05_integration.md`). |
| `replay.html` | `src/xarm5/replay.ts` | Replay: drive the arm along a real recorded trajectory, render base+wrist. |
| `xarm5.html` | `src/xarm5/verify.ts` | Official arm model viewer / FK-IK verification. |
| `xarm5-calibrate.html` | `src/xarm5/calibrate.ts` | Interactive camera calibration against a real base image. |
| `legacy.html` | `src/main.ts` | Legacy crude simulator (board editor, manual IK); `calibrate.html`/`export.html` are its old tools. |

## Reference — the current (xarm5) model

- **Frame / units:** ROS arm-base frame — **Z up, +X forward, +Y left**,
  desk at z≈0, meters internally (real data is in **mm**). Base at the origin.
- **State / action** (as recorded): `[x, y, z (mm), yaw (deg), gripper (0–1, 1=open)]`;
  `action[i] ≈ state[i+1]` (the commanded next state).
- **Robot** (`src/xarm5/robot.ts`): official xArm 5 joint-origin kinematics and
  STL meshes (from `docs/xarm_ros_official/`), an inline +Z parallel-jaw gripper,
  and a CCD IK solver with a vertical-tool constraint and J5 yaw-locking (J5
  counter-rotates J1 so the grip plane + wrist camera hold a fixed orientation).
- **Board** (`src/xarm5/board.ts`): grid fitted from real grasp/release anchors
  (a1 ≈ (251, 212) mm, ~56.9 mm squares).

The legacy simulator uses a *different* convention (Y-up, crude primitive links,
analytical IK) — see `docs/original-simulator-plan.md` and the top-level `src/`
files. The published xArm 5 joint limits and the ROS URDF are the shared
reference for both.

## Known scope

- 5-DOF: the arm solves for position with the tool held vertical (grip-plane yaw
  via J5); it does not target arbitrary 6-D orientation (expected for xArm 5).
- The sim is **kinematic**, not physical (no dynamics/contact) — sufficient for
  matching the recorded pick-and-place motion and rendering camera views.
- Pieces are visual/graspable only; there is no chess-rules gameplay.
