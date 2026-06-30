# xArm 5 Chessboard Simulator Plan

## Goal

Build a standalone browser-based 3D simulator for a simplified UFACTORY xArm 5 robot arm operating over a chessboard. The visual model can be crude, but the joint hierarchy, degrees of motion, target reaching, and animation behavior should be useful for reasoning about how the arm can move through space.

## Target Outcome

The first complete version should provide:

- A Three.js scene with orbit camera controls, lights, ground plane, chessboard, and a few chess pieces.
- A simplified 5-axis robot arm with correct parent-child joint hierarchy.
- Manual controls for each joint using sliders.
- Forward kinematics visualization of the current end-effector position.
- `x`, `y`, `z` target inputs for moving the end effector to a requested coordinate.
- Approximate inverse kinematics for position-only targeting.
- Animated movement from the current pose to the solved target pose.
- Clickable chessboard squares or chess pieces that set the target coordinate.
- A clear indication when a target is unreachable or the solver fails to converge.

## Reference Sources

Use these as the primary references while implementing:

- UFACTORY xArm ROS repository: <https://github.com/xArm-Developer/xarm_ros>
- xArm description / URDF resources: <https://github.com/xArm-Developer/xarm_ros/tree/master/xarm_description/urdf>
- xArm ROS examples and Cartesian/joint command notes: <https://github.com/xArm-Developer/xarm_ros>

If the official/supported URDF files are easy to consume, use them to verify link lengths, joint axes, and joint limits. If importing the real meshes slows the prototype down, keep the visible model as primitive cylinders/boxes and document the approximations.

## Technical Direction

Use a Vite + Three.js app.

Recommended initial dependencies:

- `three`
- `@types/three`
- `vite`
- `typescript`
- Optional: `lil-gui` or custom HTML controls for sliders and target inputs

Avoid Blender for the first milestone. Blender may be useful later for visual refinement, but Three.js is a better fit for interactive kinematics, clickable targets, and browser-based iteration.

## Coordinate System

Use a simple world coordinate convention:

- `X`: board left/right
- `Y`: height above table
- `Z`: board forward/back
- Robot base located beside or behind the chessboard
- Chessboard lies flat on the `X/Z` plane

Document all units. Prefer meters internally if using real xArm dimensions; otherwise use a consistent scene scale and expose labels clearly.

## Robot Model

Model the arm as a hierarchy of `THREE.Group` objects:

- `base`
- `joint1`
- `link1`
- `joint2`
- `link2`
- `joint3`
- `link3`
- `joint4`
- `link4`
- `joint5`
- `wrist/endEffector`

Each joint group should rotate around its local axis. The exact visual geometry can be simple:

- Cylinders for rotating joints.
- Rectangular boxes or capsules for links.
- Small sphere or cone marker for the end effector.

The important part is that child transforms are attached correctly so rotating an upstream joint moves all downstream links.

## Degrees Of Freedom

The simulator should model five revolute joints. The exact axis mapping should be verified against xArm 5 references, but the first implementation can use this practical approximation:

- Joint 1: base yaw around vertical axis.
- Joint 2: shoulder pitch.
- Joint 3: elbow pitch.
- Joint 4: wrist pitch.
- Joint 5: wrist roll or yaw depending on the xArm 5 reference data.

Since the arm has 5 DOF, solve position only for `x`, `y`, `z`. Do not require arbitrary end-effector orientation in the first milestone.

## Forward Kinematics

Implement forward kinematics through Three.js transforms first:

- Store joint angles in a central state object.
- Apply each angle to the corresponding joint group.
- Use `endEffector.getWorldPosition()` to report the current end-effector coordinate.
- Render a small marker at the current end-effector location.

This keeps the first version simple and makes visual debugging straightforward.

## Inverse Kinematics

Implement an approximate IK solver for target position.

Preferred first solver:

- Cyclic coordinate descent, also known as CCD.
- Iterate from the wrist joint back toward the base.
- For each joint, rotate it to reduce the distance between end effector and target.
- Clamp each joint to its configured min/max limit.
- Stop when the end effector is within a small tolerance or after a maximum iteration count.

This is easier to implement and debug than a full analytical solver, and it is adequate for the first prototype.

IK behavior requirements:

- Accept target as `{ x, y, z }`.
- Return solved joint angles, final distance error, iteration count, and success/failure.
- Keep the wrist orientation simple, preferably pointing generally down toward the board when possible.
- If the target is unreachable, move to the nearest pose found and show a warning/status.

## Animation

When a target solve succeeds or partially succeeds:

- Keep the current joint angles as the start pose.
- Solve the target pose.
- Interpolate each joint angle over a short duration.
- Use easing so movement is readable but not overly stylized.
- Update FK and UI during the animation.

Manual sliders should immediately update the robot pose and current end-effector coordinate.

## Chessboard Scene

Create a board with:

- 8x8 squares.
- Alternating light/dark materials.
- World coordinates assigned to each square center.
- A few simple pieces as primitive geometry, such as cylinders, cones, and spheres.

Click behavior:

- Clicking a square sets the target to the square center, optionally slightly above the board.
- Clicking a piece sets the target to a point above that piece.
- Target marker moves to the selected coordinate.
- The user can then press a move button, or click can immediately trigger movement if that feels better after testing.

## UI

Provide a compact control panel:

- Five joint sliders with degree labels.
- Numeric `x`, `y`, `z` target inputs.
- `Move to target` button.
- `Reset pose` button.
- Current end-effector position readout.
- Solver status: success, final error, iterations, or unreachable.

The simulator should be usable without reading instructions inside the app.

## Milestones

### Milestone 1: Project Scaffold

- Create Vite + TypeScript + Three.js app.
- Add basic scene, camera, renderer, resize handling, and orbit controls.
- Add ground plane and lighting.

Acceptance:

- App runs locally.
- Scene is visible on desktop and mobile-sized viewport.
- Camera controls work.

### Milestone 2: Chessboard

- Add 8x8 chessboard.
- Add a few primitive chess pieces.
- Add raycasting for clickable board squares and pieces.

Acceptance:

- Board and pieces are visible.
- Clicking a target updates a visible target marker and target coordinate inputs.

### Milestone 3: Robot FK

- Add simplified xArm 5 hierarchy.
- Add joint sliders.
- Apply joint limits.
- Display end-effector world position.

Acceptance:

- Moving each slider rotates the expected section of the arm.
- Parent-child movement is correct.
- End-effector readout updates live.

### Milestone 4: IK Target Solving

- Implement CCD IK against `x`, `y`, `z` target.
- Add solver result status.
- Clamp joint angles to configured limits.

Acceptance:

- Entering a reachable coordinate produces a plausible arm pose.
- Unreachable targets are reported clearly.
- Solver does not produce unstable or explosive rotations.

### Milestone 5: Animation

- Animate from current pose to solved target pose.
- Keep UI and target/end-effector markers updated during motion.

Acceptance:

- Movement is smooth and readable.
- Manual controls still work after animation.
- Repeated target selections do not break state.

### Milestone 6: Verification And Polish

- Verify the app in a browser using screenshots.
- Test desktop and mobile-sized viewports.
- Check that the 3D scene is nonblank and framed correctly.
- Check that text and controls do not overlap.
- Add concise README usage notes if needed.

Acceptance:

- App can be started from documented commands.
- Core interaction works: slider control, coordinate target, animation, clickable board targets.
- Known approximations are documented.

## Open Assumptions

- The first version prioritizes motion behavior over visual fidelity.
- Position-only IK is acceptable because xArm 5 has 5 DOF and cannot satisfy arbitrary 6D poses.
- Primitive geometry is acceptable unless importing the official URDF/meshes proves easy.
- Chess pieces only need to be visual targets for now, not full chess gameplay.

## Future Enhancements

- Import or convert official xArm geometry from URDF/mesh assets.
- Add a gripper model.
- Add collision hints for table, board, and pieces.
- Add path preview or ghost pose.
- Add saved poses.
- Add chess-piece pickup/drop-off workflow.
- Add a stricter analytical IK solver if the CCD solver is not reliable enough.
