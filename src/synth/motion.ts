import { Rng, uniform, gauss } from "./rng";

/**
 * Motion planner — reproduces the measured Magnus motion profile
 * (docs/full_dataset_analysis.md) as a sequence of timed segments, then samples
 * them at the camera rate into the TRUE per-frame TCP path. The true path feeds
 * the renderer and IK; a separate sample-hold (quantize.ts) produces the logged
 * `state`. All positions in mm, yaw in degrees, gripper 0..1 (1=open), time in s.
 */

export interface Pose {
  x: number;
  y: number;
  z: number;
  yaw: number; // deg
  grip: number; // 0..1
}

export interface TrueFrame extends Pose {
  t: number; // seconds from episode start
}

export type PrimitiveKind = "move" | "pickup";

export interface Primitive {
  kind: PrimitiveKind;
  graspXY: [number, number]; // mm
  placeXY?: [number, number]; // mm (move only)
  graspZ: number; // mm TCP height at grasp
  placeZ?: number; // mm TCP height at place (move)
  pickupLiftZ?: number; // mm high hold (pickup)
}

export interface MotionParams {
  home: [number, number, number]; // mm
  travelZ: number; // mm carry height
  speed: number; // mm/s
  gripperOpen: number;
  gripperClosed: number;
  yawDeg: number; // 0 or 90, held through the pick-place
  dwellClose: number; // s, gripper close ramp at grasp
  dwellOpen: number; // s, gripper open ramp at place
  settle: number; // s, low-z settle each end
  fps: number; // nominal camera fps
  dtJitter: number; // fractional per-frame dt jitter
}

export interface PlanResult {
  frames: TrueFrame[]; // true per-frame poses (mm/deg)
  duration: number; // s
  graspFrame: number; // frame index where the gripper has closed on the piece
  releaseFrame: number; // frame index where it reopens (move); -1 for pickup
}

interface Segment {
  from: Pose;
  to: Pose;
  dur: number; // s
}

const dist3 = (a: Pose, b: Pose) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/** Default measured motion params with small per-episode jitter (all logged). */
export function sampleMotionParams(rng: Rng, yawDeg: number): MotionParams {
  return {
    home: [gauss(rng, 257, 4), gauss(rng, -33, 5), gauss(rng, 313, 4)],
    travelZ: gauss(rng, 318, 3),
    speed: gauss(rng, 372, 12),
    gripperOpen: 1.0,
    gripperClosed: uniform(rng, 0.22, 0.26),
    yawDeg,
    dwellClose: uniform(rng, 0.6, 0.8),
    dwellOpen: uniform(rng, 0.5, 0.7),
    settle: uniform(rng, 0.15, 0.3),
    fps: gauss(rng, 13.9, 0.25),
    dtJitter: 0.06,
  };
}

/** Build the timed segment list for a primitive, tagging grasp/release times. */
function buildSegments(p: Primitive, m: MotionParams, rng: Rng): { segs: Segment[]; graspT: number; releaseT: number } {
  const O = m.gripperOpen, C = m.gripperClosed, Y = m.yawDeg;
  const [gx, gy] = p.graspXY;
  const gZ = p.graspZ;
  const home: Pose = { x: m.home[0], y: m.home[1], z: m.home[2], yaw: 0, grip: O };
  const aboveGrasp = (yaw: number, grip: number): Pose => ({ x: gx, y: gy, z: m.travelZ, yaw, grip });
  const atGrasp = (yaw: number, grip: number): Pose => ({ x: gx, y: gy, z: gZ, yaw, grip });

  const segs: Segment[] = [];
  const spatial = (from: Pose, to: Pose) => segs.push({ from, to, dur: Math.max(1e-3, dist3(from, to) / m.speed) });
  const hold = (pose: Pose, to: Pose, dur: number) => segs.push({ from: pose, to, dur });

  // Approach: home -> above grasp (yaw blends 0 -> Y) -> descend to grasp.
  spatial(home, aboveGrasp(Y, O));
  spatial(aboveGrasp(Y, O), atGrasp(Y, O));
  // Close on the piece (grip O -> C), then settle. graspT = end of the close ramp.
  hold(atGrasp(Y, O), atGrasp(Y, C), m.dwellClose);
  let acc = segs.reduce((s, g) => s + g.dur, 0);
  const graspT = acc;
  hold(atGrasp(Y, C), atGrasp(Y, C), m.settle);

  let releaseT = -1;
  if (p.kind === "move" && p.placeXY && p.placeZ != null) {
    const [px, py] = p.placeXY, pZ = p.placeZ;
    const abovePlace = (grip: number): Pose => ({ x: px, y: py, z: m.travelZ, yaw: Y, grip });
    const atPlace = (grip: number): Pose => ({ x: px, y: py, z: pZ, yaw: Y, grip });
    spatial(atGrasp(Y, C), aboveGrasp(Y, C)); // lift
    spatial(aboveGrasp(Y, C), abovePlace(C)); // traverse
    spatial(abovePlace(C), atPlace(C)); // descend to place
    hold(atPlace(C), atPlace(O), m.dwellOpen); // open
    acc = segs.reduce((s, g) => s + g.dur, 0);
    releaseT = acc;
    hold(atPlace(O), atPlace(O), m.settle);
    spatial(atPlace(O), abovePlace(O)); // lift
    spatial(abovePlace(O), { ...home, yaw: 0 }); // return home (yaw Y -> 0)
  } else {
    // Pickup: lift high and hold (no place).
    const liftZ = p.pickupLiftZ ?? 364;
    const high: Pose = { x: gx, y: gy, z: liftZ, yaw: Y, grip: C };
    spatial(atGrasp(Y, C), high);
    hold(high, high, uniform(rng, 0.6, 1.2)); // brief inspect hold at the top
  }
  return { segs, graspT, releaseT };
}

export function plan(p: Primitive, m: MotionParams, rng: Rng): PlanResult {
  const { segs, graspT, releaseT } = buildSegments(p, m, rng);
  const starts: number[] = [];
  let total = 0;
  for (const s of segs) {
    starts.push(total);
    total += s.dur;
  }

  // Sample at the camera rate with mild per-frame dt jitter.
  const frames: TrueFrame[] = [];
  let t = 0, si = 0;
  const poseAt = (time: number): Pose => {
    while (si < segs.length - 1 && starts[si] + segs[si].dur < time) si++;
    const s = segs[si];
    const u = s.dur > 1e-9 ? Math.min(1, Math.max(0, (time - starts[si]) / s.dur)) : 1;
    return {
      x: lerp(s.from.x, s.to.x, u),
      y: lerp(s.from.y, s.to.y, u),
      z: lerp(s.from.z, s.to.z, u),
      yaw: lerp(s.from.yaw, s.to.yaw, u),
      grip: lerp(s.from.grip, s.to.grip, u),
    };
  };
  while (t <= total + 1e-6) {
    frames.push({ t, ...poseAt(Math.min(t, total)) });
    const dt = (1 / m.fps) * (1 + (rng() - 0.5) * 2 * m.dtJitter);
    t += dt;
  }

  const frameForTime = (time: number) => {
    if (time < 0) return -1;
    let idx = 0;
    for (let i = 0; i < frames.length; i++) if (frames[i].t <= time) idx = i; else break;
    return idx;
  };
  return { frames, duration: total, graspFrame: frameForTime(graspT), releaseFrame: frameForTime(releaseT) };
}
