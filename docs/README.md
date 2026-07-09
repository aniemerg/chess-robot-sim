# docs/

Analysis and planning for the xArm5 chess project. Read in this order to follow
the story (project overview lives in the top-level `README.md`).

## The real data (understand it)
- **`existing_dataset_catalog.md`** — what's actually in the ~793 real episodes:
  the two task templates, episode counts, piece/color/square coverage, data
  volume. Start here if you haven't seen the data.
- **`full_dataset_analysis.md`** — the measured **motion profile** across all
  episodes: home pose, travel/grasp heights, speed, gripper, yaw, logging
  quantization, board geometry. The reference for in-distribution synthesis.
- **`rollout_data_analysis.md`** — deep-dive on the 8-episode sample bundle
  (`rollouts/samples/`): trajectory schema, how we recover board pose, and how
  the sim replicates episodes.

## The synthetic generator (build it)
- **`synthetic_data_plan.md`** — the plan for generating synthetic episodes:
  output format (per-frame JPGs + sample-held state), motion model, scenario/task
  types, domain-randomization catalog, per-episode manifest, validation, and the
  start-small approach.

## Reference
- **`xarm_ros_official/`** — official UFACTORY xArm 5 URDF / kinematics files the
  current sim is built from.
- **`original-simulator-plan.md`** — historical: the original crude-simulator
  build plan (predates everything above).

See also `rollouts/README.md` for the layout of the real data on disk.
