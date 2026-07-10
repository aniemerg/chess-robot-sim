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
  pickupTargetDur?: number; // s, target total duration for pickups (real range 13-31s)
}

export interface Waypoint {
  pos: [number, number, number]; // mm
  label: string;
}

export interface PlanResult {
  frames: TrueFrame[]; // true per-frame poses (mm/deg)
  duration: number; // s
  graspFrame: number; // frame index where the gripper has closed on the piece
  releaseFrame: number; // frame index where it reopens (move); -1 for pickup
  waypoints: Waypoint[]; // key phase poses, for visualization
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
function buildSegments(p: Primitive, m: MotionParams, rng: Rng): { segs: Segment[]; graspT: number; releaseT: number; waypoints: Waypoint[] } {
  const O = m.gripperOpen, C = m.gripperClosed, Y = m.yawDeg;
  const [gx, gy] = p.graspXY;
  const gZ = p.graspZ;
  const waypoints: Waypoint[] = [];
  const key = (label: string, pose: Pose) => waypoints.push({ pos: [pose.x, pose.y, pose.z], label });
  const home: Pose = { x: m.home[0], y: m.home[1], z: m.home[2], yaw: 0, grip: O };
  const aboveGrasp = (yaw: number, grip: number): Pose => ({ x: gx, y: gy, z: m.travelZ, yaw, grip });
  const atGrasp = (yaw: number, grip: number): Pose => ({ x: gx, y: gy, z: gZ, yaw, grip });

  const segs: Segment[] = [];
  const spatial = (from: Pose, to: Pose) => segs.push({ from, to, dur: Math.max(1e-3, dist3(from, to) / m.speed) });
  const hold = (pose: Pose, to: Pose, dur: number) => segs.push({ from: pose, to, dur });
  // Slow SMOOTH drift around a center for `dur` seconds (the teleoperator holding
  // roughly still) — fills long pickup phases without freezing the frames and
  // without the jitter of random waypoints. Sum of low-frequency sines, enveloped
  // so it starts and ends at `center`; z is clamped to `zMin` (no clipping).
  const smoothDrift = (center: Pose, ampXY: number, ampZ: number, dur: number, zMin: number): void => {
    if (dur <= 0) return;
    const px = uniform(rng, 3.5, 6), py = uniform(rng, 4, 6.5), pz = uniform(rng, 4.5, 7);
    const phx = rng() * 6.283, phy = rng() * 6.283, phz = rng() * 6.283;
    const steps = Math.max(2, Math.round(dur / 0.4)); // fine sampling -> smooth
    let prev = center;
    for (let s = 1; s <= steps; s++) {
      const t = (s / steps) * dur;
      const env = Math.min(1, t / 1.2) * Math.min(1, (dur - t) / 1.2); // ease in/out
      const to: Pose = {
        x: center.x + ampXY * Math.sin((2 * Math.PI * t) / px + phx) * env,
        y: center.y + ampXY * Math.sin((2 * Math.PI * t) / py + phy) * env,
        z: Math.max(zMin, center.z + ampZ * Math.sin((2 * Math.PI * t) / pz + phz) * env),
        yaw: center.yaw,
        grip: center.grip,
      };
      hold(prev, to, dur / steps);
      prev = to;
    }
  };

  // Pickup timing: real pickups are long (~13-31s) — the operator hovers low
  // before grasping, then holds at the top. Size the low-z hover + top-hold to
  // hit the target duration; the grasp then happens late, as in the real data.
  let hoverLow = 0, holdHigh = uniform(rng, 0.6, 1.2);
  if (p.kind === "pickup" && m.pickupTargetDur) {
    const liftZ = p.pickupLiftZ ?? 364;
    const highPose: Pose = { x: gx, y: gy, z: liftZ, yaw: Y, grip: C };
    const tApproach = dist3(home, aboveGrasp(Y, O)) / m.speed + dist3(aboveGrasp(Y, O), atGrasp(Y, O)) / m.speed;
    const tLift = dist3(atGrasp(Y, C), highPose) / m.speed;
    const baseHold = 0.8;
    const extra = Math.max(0, m.pickupTargetDur - (tApproach + m.dwellClose + m.settle + tLift + baseHold));
    hoverLow = extra * 0.55; // ~half the slack as a low hover before grasp
    holdHigh = baseHold + extra * 0.45; // the rest as a hold at the top
  }

  // Approach: home -> above grasp (yaw blends 0 -> Y) -> descend to grasp.
  key("home", home);
  key("approach (travel height over piece)", aboveGrasp(Y, O));
  spatial(home, aboveGrasp(Y, O));
  if (p.kind === "pickup" && hoverLow > 0) {
    // Hover ABOVE the piece (not at grasp height) so the gentle drift can't clip
    // the piece or the table, then make a clean final descent to the grasp.
    const hoverZ = gZ + 45;
    const hoverPose: Pose = { x: gx, y: gy, z: hoverZ, yaw: Y, grip: O };
    spatial(aboveGrasp(Y, O), hoverPose);
    smoothDrift(hoverPose, 12, 10, hoverLow, gZ + 22);
    spatial(hoverPose, atGrasp(Y, O));
  } else {
    spatial(aboveGrasp(Y, O), atGrasp(Y, O));
  }
  // Close on the piece (grip O -> C), then settle. graspT = end of the close ramp.
  key("grasp (descend, close gripper)", atGrasp(Y, C));
  hold(atGrasp(Y, O), atGrasp(Y, C), m.dwellClose);
  let acc = segs.reduce((s, g) => s + g.dur, 0);
  const graspT = acc;
  hold(atGrasp(Y, C), atGrasp(Y, C), m.settle);

  let releaseT = -1;
  if (p.kind === "move" && p.placeXY && p.placeZ != null) {
    const [px, py] = p.placeXY, pZ = p.placeZ;
    const abovePlace = (grip: number): Pose => ({ x: px, y: py, z: m.travelZ, yaw: Y, grip });
    const atPlace = (grip: number): Pose => ({ x: px, y: py, z: pZ, yaw: Y, grip });
    key("lift to travel height", aboveGrasp(Y, C));
    key("traverse to target", abovePlace(C));
    key("place (descend, open gripper)", atPlace(O));
    spatial(atGrasp(Y, C), aboveGrasp(Y, C)); // lift
    spatial(aboveGrasp(Y, C), abovePlace(C)); // traverse
    spatial(abovePlace(C), atPlace(C)); // descend to place
    hold(atPlace(C), atPlace(O), m.dwellOpen); // open
    acc = segs.reduce((s, g) => s + g.dur, 0);
    releaseT = acc;
    hold(atPlace(O), atPlace(O), m.settle);
    spatial(atPlace(O), abovePlace(O)); // lift
    spatial(abovePlace(O), { ...home, yaw: 0 }); // return home (yaw Y -> 0)
    key("retract to home", { ...home, yaw: 0 });
  } else {
    // Pickup: lift high and hold (no place).
    const liftZ = p.pickupLiftZ ?? 364;
    const high: Pose = { x: gx, y: gy, z: liftZ, yaw: Y, grip: C };
    key("lift high and hold", high);
    spatial(atGrasp(Y, C), high);
    smoothDrift(high, 20, 16, holdHigh, high.z - 40); // gentle inspection drift at the top (high up, no clip)
  }
  return { segs, graspT, releaseT, waypoints };
}

export function plan(p: Primitive, m: MotionParams, rng: Rng): PlanResult {
  const { segs, graspT, releaseT, waypoints } = buildSegments(p, m, rng);
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
  return { frames, duration: total, graspFrame: frameForTime(graspT), releaseFrame: frameForTime(releaseT), waypoints };
}
