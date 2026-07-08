# Official xArm5 Reference Files

Fetched from UFACTORY's official `xArm-Developer/xarm_ros` repository.

- `xarm5_default_kinematics.yaml`: fixed parent-to-joint origin transforms used by the simulator.
- `xarm5.urdf.xacro`: joint axes and limits used by the simulator.
- `xarm5_robot_macro.xacro`: wrapper macro reference.
- `public/assets/xarm5/visual/*.stl`: official xArm5 visual meshes copied from `xarm_description/meshes/xarm5/visual/`.
- `public/assets/end_tool/visual/end_tool_1300.stl`: official end-tool visual mesh copied from `xarm_description/meshes/end_tool/visual/`.

The current Three.js model uses the official xArm5 kinematic frame structure:

- Each joint group applies the fixed `origin xyz/rpy`.
- Each child frame applies the revolute joint rotation.
- All five joints rotate around local z after the fixed origin transform.
- The official ROS `Z-up` kinematic tree is mounted into the Three.js `Y-up` scene with a `-90 deg` X rotation at the kinematics root.

The gripper and chess pieces remain simplified custom geometry.
