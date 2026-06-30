// Headless check for the analytical vertical-tool IK (no DOM needed).
import * as THREE from "three";
import { Robot } from "./src/robot.ts";
import { solveVerticalIK } from "./src/ik.ts";

const robot = new Robot();
robot.root.position.set(0, 0, -0.12);
robot.root.updateMatrixWorld(true);

const ee = robot.getEndEffectorPosition();
console.log("Rest grasp point:", ee.toArray().map((v) => v.toFixed(3)).join(", "));

// World-down direction of the tool at rest (should be ~(0,-1,0)).
const down = new THREE.Vector3(0, 1, 0);
robot.endEffector.getWorldDirection(down); // tool local +Z; check tool axis instead
const toolAxis = new THREE.Vector3(0, 1, 0).applyQuaternion(
  robot.endEffector.getWorldQuaternion(new THREE.Quaternion())
);
console.log("Rest tool axis (want ~0,-1,0):", toolAxis.toArray().map((v) => v.toFixed(3)).join(", "));

// Sample every board square; verify reach AND that the tool stays vertical.
const sq = 0.05;
const half = (8 * sq) / 2;
const hoverY = 0.012 + 0.02; // just above the board surface
let pass = 0;
let total = 0;
let worstErr = 0;
let worstTilt = 0; // degrees off vertical
const q = new THREE.Quaternion();
const ty = new THREE.Vector3();
for (let r = 0; r < 8; r++) {
  for (let c = 0; c < 8; c++) {
    const x = -half + sq / 2 + c * sq;
    const z = 0.16 - half + sq / 2 + r * sq;
    const t = new THREE.Vector3(x, hoverY, z);
    const res = solveVerticalIK(robot, t, { tolerance: 0.004 });
    total++;
    if (res.success) {
      pass++;
      robot.setAngles(res.angles);
      robot.endEffector.getWorldQuaternion(q);
      ty.set(0, 1, 0).applyQuaternion(q);
      const tilt = THREE.MathUtils.radToDeg(ty.angleTo(new THREE.Vector3(0, -1, 0)));
      worstTilt = Math.max(worstTilt, tilt);
    } else {
      worstErr = Math.max(worstErr, res.error);
    }
  }
}
console.log(
  `Board squares solved: ${pass}/${total}  worst-miss=${(worstErr * 1000).toFixed(1)}mm  ` +
    `worst-tilt=${worstTilt.toFixed(2)}deg`
);

// Explicit reachable and unreachable targets.
for (const t of [new THREE.Vector3(0.0, 0.04, 0.16), new THREE.Vector3(1.5, 0.5, 1.5)]) {
  const res = solveVerticalIK(robot, t);
  console.log(
    `${res.success ? "OK  " : "MISS"} target(${t.toArray().map((v) => v.toFixed(2)).join(",")}) ` +
      `err=${(res.error * 1000).toFixed(1)}mm reachable=${res.reachable}`
  );
}

// Solve must not disturb the current pose.
const before = robot.getAngles();
solveVerticalIK(robot, new THREE.Vector3(0.1, 0.04, 0.1));
const after = robot.getAngles();
console.log(
  "Pose drift:",
  Math.max(...before.map((v, i) => Math.abs(v - after[i]))).toExponential(2)
);
