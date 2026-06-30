# xArm 5 Chessboard Simulator

A standalone browser-based 3D simulator for a simplified UFACTORY xArm 5 robot
arm operating over a chessboard. Built with Vite + TypeScript + Three.js.

The visual model is deliberately crude (primitive cylinders/boxes), but the
joint hierarchy, degrees of motion, target reaching, and animation behavior are
faithful enough to reason about how the arm moves through space.

## Quick start

```bash
npm install
npm run dev        # start the dev server (prints a localhost URL)
```

Other commands:

```bash
npm run build      # type-check and produce a production build in dist/
npm run preview    # serve the production build
npm run typecheck  # type-check only
npm run test:ik    # headless FK/IK sanity check (solves every board square)
```

`npm run test:ik` runs a Node harness (`test-ik.mts`) with no browser: it builds
the arm, solves every chessboard square, verifies the gripper stays vertical
(0° tilt) at each one, confirms a far target is flagged unreachable, and checks
that solving does not disturb the current pose.

## Using the simulator

- **Orbit camera** — drag to rotate, scroll / pinch to zoom.
- **Pick and place** — click a chess piece to pick it up, then click a square to
  put it down. The arm approaches from above, lowers, grips, lifts, and places —
  with the parallel-jaw gripper held **vertical** the whole time.
- **Click an empty square** — sends the gripper just above that square (vertical).
- **Joint sliders** — five revolute joints (J1–J5); moving a slider immediately
  updates the arm and the end-effector readout (and takes over from any motion).
- **Target X/Y/Z** — type a coordinate (meters) and press **Move to target** to
  send the gripper there, kept vertical.
- **Reset pose** — opens the gripper and animates back to the home pose.
- **Wrist camera** — the inset viewport (lower-right) is a camera mounted just
  below joint 4, looking along the remaining arm toward the gripper. It rides
  the wrist, so it shows a gripper's-eye view of the target during pick-and-place.
  The image is rolled 180° for an egocentric orientation — the gripper sits at
  the bottom of the frame with the board ahead, like looking down at your hand.
- **Board editor** — toggle **Edit board** to rearrange the position by hand
  (the robot parks itself out of the way). Tools:
  - **Move** — click a piece to select it, then click a square to move it
    (capturing any occupant). The selected piece is highlighted with a ring.
  - **Erase** — click a piece to remove it (or use **Remove selected**).
  - **Pawn / Knight / Bishop / Rook / Queen / King** — click a square to add (or
    replace) that piece in the current brush color.
  - **Color** — toggles the brush between White/Black; also recolors the
    selected piece.
  - **Reset to start** restores the standard opening position; **Clear board**
    removes every piece.
- **Status** — live grasp-point position plus the IK result (reached /
  joint-limited / unreachable, with error).

## Coordinate system (units: meters)

- `X` — board left/right
- `Y` — height above the table (up)
- `Z` — board forward/back
- The robot base sits just behind the board at `(0, 0, -0.12)`.
- The board lies flat on the `X/Z` plane, centered at `(0, 0, 0.16)`.

## Robot model

A 5-DOF arm with a parallel-jaw gripper, in a parent-child hierarchy
(`base → J1 → link → J2 → link → J3 → link → J4 → link → J5 → gripper`).
Joint limits are the **published UFACTORY xArm 5 ranges**:

| Joint | Motion          | Local axis | Limit          |
| ----- | --------------- | ---------- | -------------- |
| J1    | base yaw        | Y          | ±360°          |
| J2    | shoulder pitch  | X          | −118°…120°     |
| J3    | elbow pitch     | X          | −225°…11°      |
| J4    | wrist pitch     | X          | −97°…180°      |
| J5    | wrist roll      | Y          | ±360°          |

Max joint speed on the real arm is 180°/s. At the model's zero pose the arm
points straight up; the home pose curls it forward with the gripper hanging
vertically over the board.

## Inverse kinematics

**Analytical, vertical-tool** IK (`src/ik.ts`). Because pick-and-place over a
board wants the gripper pointing straight down, the tool is constrained vertical
for every target. That makes the solve exact and fast:

1. **J1** yaws to aim the arm's plane at the target.
2. The wrist (J4) must sit directly above the target by the tool length, so a
   planar two-link solve (**J2, J3**) places it — both elbow configurations are
   tried and the first that respects all joint limits wins.
3. **J4** is set so the cumulative pitch points the tool straight down.
4. **J5** roll does not affect position and is left as-is.

If a target is out of reach or no configuration satisfies the joint limits, the
arm moves to the closest valid pose and the status panel reports
*unreachable* or *joint-limited*. The headless test confirms a 0° tilt (perfect
verticality) across all 64 squares.

## Chess pieces

Classic Staunton-style models (`src/pieces.ts`). The rotationally symmetric
pieces (pawn, rook, bishop, queen, king) are turned from hand-drawn silhouettes
with `THREE.LatheGeometry`; the knight uses an extruded horse-head profile on a
turned base. Recognizable toppers are added separately: rook crenellations,
bishop mitre ball, queen coronet, king cross. A full standard starting position
is set up on the board.

## Known approximations

- 5 DOF means the arm solves for position (`x, y, z`) with the tool held
  vertical — it does not target arbitrary 6-D orientation (expected for xArm 5).
- Link lengths are rounded proportions (see `src/robot.ts`) chosen so the whole
  board is reachable with the gripper vertical; they do not match the official
  URDF exactly. Joint *limit ranges* do match the published xArm 5 values, but
  the model's zero pose and axis signs are our own convention (we pick signs so
  natural board reaches land inside the real limits), not the factory home.
- Arm/gripper geometry is primitive (cylinders/boxes); no official meshes are
  imported. Reference: the xArm description URDF in the
  [xArm-Developer/xarm_ros](https://github.com/xArm-Developer/xarm_ros/tree/master/xarm_description/urdf)
  repository.
- Pieces are visual/graspable only — there is no chess-rules gameplay.

## Project structure

```
index.html          markup + control panel + wrist-cam frame
src/style.css        panel + layout styling
src/main.ts          wiring: scene, robot, board, raycasting, pick/place, wrist-cam inset
src/scene.ts         renderer, camera, lights, ground, orbit controls
src/robot.ts         xArm 5 joint hierarchy + gripper + wrist camera + forward kinematics
src/ik.ts            analytical vertical-tool inverse kinematics
src/chessboard.ts    8x8 board + Staunton set + pick/place + editing API
src/pieces.ts        Staunton-style chess piece geometry
src/ui.ts            HTML control panel controller
```
