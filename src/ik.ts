import * as THREE from "three";
import { Robot } from "./robot";

export interface IKResult {
  angles: number[]; // solved joint angles (radians): [J1..J5]
  error: number; // distance from grasp point to target (meters)
  iterations: number; // kept for UI compatibility (analytic: 1)
  success: boolean; // within tolerance AND inside joint limits
  reachable: boolean; // geometrically within the arm's reach envelope
}

export interface IKOptions {
  tolerance?: number; // meters
}

/**
 * Analytical inverse kinematics that keeps the gripper pointing straight DOWN
 * (vertical) for any target — exactly what pick-and-place over a board needs.
 *
 * Because the tool must be vertical, the wrist (J4) sits directly above the
 * target by the tool length. That reduces the problem to:
 *   1. J1 yaw aims the arm plane at the target.
 *   2. A planar 2-link solve (J2, J3) places the wrist above the target.
 *   3. J4 = whatever makes the cumulative pitch point the tool down.
 *   4. J5 roll is free (does not affect position); left unchanged.
 *
 * Both elbow configurations are tried; the first that respects every joint
 * limit wins. If the target is out of reach, the arm is posed as close as the
 * geometry allows and the result is flagged unreachable.
 */
export function solveVerticalIK(
  robot: Robot,
  target: THREE.Vector3,
  options: IKOptions = {}
): IKResult {
  const tol = options.tolerance ?? 0.004;
  const a = robot.upperLength;
  const b = robot.foreLength;
  const base = robot.root.position;

  const [j1, j2, j3, j4] = robot.joints;

  // Horizontal aim.
  const dx = target.x - base.x;
  const dz = target.z - base.z;
  const r = Math.hypot(dx, dz);
  const theta1 = clampToJoint(Math.atan2(dx, dz), j1);

  // Wrist (J4) target sits directly above the grasp target by the tool length.
  const vt = target.y + robot.toolLength - (base.y + robot.shoulderHeight);
  const D = Math.hypot(r, vt);

  const reachable = D <= a + b + 1e-6 && D >= Math.abs(a - b) - 1e-6;

  // Elbow interior angle via law of cosines (clamped for the unreachable case).
  const cosE = THREE.MathUtils.clamp((D * D - a * a - b * b) / (2 * a * b), -1, 1);
  const E = Math.acos(cosE);
  const psi = Math.atan2(r, vt); // angle of wrist target from vertical
  const delta = Math.atan2(b * Math.sin(E), a + b * Math.cos(E));

  const j5Angle = robot.joints[4].angle;
  let best: { angles: number[]; error: number; ok: boolean } | null = null;

  for (const elbowSign of [-1, 1]) {
    const phi2 = psi - elbowSign * delta; // upper-arm angle from vertical
    const phi3 = phi2 + elbowSign * E; // forearm angle from vertical

    // Convert absolute segment angles to stored joint values via axis signs.
    const th2 = phi2 / j2.sign;
    const th3 = (phi3 - phi2) / j3.sign;
    const th4 = (Math.PI - phi3) / j4.sign;

    const angles = [theta1, th2, th3, th4, j5Angle];
    const ok =
      reachable &&
      within(th2, j2) &&
      within(th3, j3) &&
      within(th4, j4);

    const error = measure(robot, angles, target);
    if (!best || (ok && !best.ok) || (ok === best.ok && error < best.error)) {
      best = { angles, error, ok };
    }
  }

  const angles = best!.angles;
  // Clamp the chosen solution to limits (matters for the unreachable case).
  const clamped = angles.map((v, i) => clampToJoint(v, robot.joints[i]));
  const error = measure(robot, clamped, target);

  return {
    angles: clamped,
    error,
    iterations: 1,
    success: error <= tol && best!.ok,
    reachable,
  };
}

function within(v: number, j: { min: number; max: number }): boolean {
  return v >= j.min - 1e-6 && v <= j.max + 1e-6;
}

function clampToJoint(v: number, j: { min: number; max: number }): number {
  return Math.min(j.max, Math.max(j.min, v));
}

const _ee = new THREE.Vector3();
/** Apply angles, measure grasp-point error, restore the prior pose. */
function measure(robot: Robot, angles: number[], target: THREE.Vector3): number {
  const start = robot.getAngles();
  robot.setAngles(angles);
  const err = robot.getEndEffectorPosition(_ee).distanceTo(target);
  robot.setAngles(start);
  return err;
}
