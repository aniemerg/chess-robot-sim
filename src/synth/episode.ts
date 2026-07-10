import * as THREE from "three";
import { resolveScenario } from "./scenario";
import { buildScene } from "./scene";
import { plan, TrueFrame, Waypoint } from "./motion";
import { sampleHold, duplicateFraction, LoggedFrame } from "./quantize";
import { mulberry32 } from "./rng";
import { pieceSetLicense } from "./piece_models";
import { Xarm5Robot } from "../xarm5/robot";

/**
 * Shared episode builder used by BOTH the headless writer (generate.ts) and the
 * interactive viewer (viewer.ts), so they pose the arm and the piece identically.
 *
 * Pipeline: scenario+seed -> scene spec + motion plan -> per-frame IK on the TRUE
 * pose -> sample-held logged `state`. Exposes a `poseFrame(i)` that drives the
 * robot + the held piece for any frame (rendered by whichever camera the caller
 * chooses).
 */

export interface BuiltEpisode {
  scenario: string;
  seed: number;
  task: string;
  scene: THREE.Scene;
  robot: Xarm5Robot;
  overhead: THREE.PerspectiveCamera;
  wrist: THREE.PerspectiveCamera;
  piece: THREE.Group;
  tableZ: number;
  trueFrames: TrueFrame[];
  solvedAngles: number[][];
  grip: number[];
  logged: LoggedFrame[];
  waypoints: Waypoint[];
  attachFrame: number;
  detachFrame: number;
  numFrames: number;
  fps: number;
  episodeJson: { index: number; task: string; num_frames: number; success: boolean; duration_s: number };
  manifest: Record<string, unknown>;
  stats: Record<string, number>;
  poseFrame: (f: number) => void;
}

export async function buildEpisode(
  scenario: string,
  seed: number,
  opts: { index?: number; setOverride?: string | null } = {}
): Promise<BuiltEpisode> {
  const ep = resolveScenario(scenario, seed);
  if (opts.setOverride) {
    ep.spec.piece.model = opts.setOverride;
    const p0 = (ep.manifest.pieces as Array<Record<string, unknown>>)[0];
    p0.model = opts.setOverride;
    p0.license = pieceSetLicense(opts.setOverride);
  }

  const built = await buildScene(ep.spec, mulberry32(seed ^ 0x9e3779b9));
  const { scene, robot, overhead, wrist, piece, tableZ } = built;

  // Plan motion, then solve IK once per TRUE frame (the image uses the true pose).
  const planned = plan(ep.primitive, ep.motion, mulberry32(seed ^ 0x1234));
  const _t = new THREE.Vector3();
  const solvedAngles: number[][] = [];
  const grip: number[] = [];
  let maxErr = 0, sumErr = 0;
  for (const f of planned.frames) {
    _t.set(f.x / 1000, f.y / 1000, f.z / 1000);
    const r = robot.solveIK(_t, { tolerance: 0.004, maxIterations: 100 });
    robot.setAnglesDeg(r.angles);
    solvedAngles.push(r.angles.slice());
    grip.push(f.grip);
    const e = robot.getTCP(new THREE.Vector3()).distanceTo(_t);
    maxErr = Math.max(maxErr, e); sumErr += e;
  }

  const logged = sampleHold(planned.frames, 4.5, mulberry32(seed ^ 0x55aa));

  // Held piece: not rigidly parented — each frame it is placed at the fingertips
  // with its base clamped to the surface (so it can't be dragged through it).
  const attachFrame = planned.graspFrame;
  const detachFrame = planned.releaseFrame; // -1 for pickup
  const isMove = ep.primitive.kind === "move";
  const _tcp = new THREE.Vector3();
  let applied = 0;
  let graspOffset = 0.045;
  const updatePiece = (f: number): void => {
    if (applied < 1 && attachFrame >= 0 && f >= attachFrame) {
      robot.getTCP(_tcp);
      graspOffset = _tcp.z - tableZ;
      applied = 1;
    }
    if (applied < 2 && detachFrame >= 0 && isMove && f >= detachFrame) {
      piece.position.z = tableZ;
      piece.rotation.set(Math.PI / 2, 0, 0);
      applied = 2;
    }
    if (applied === 1) {
      robot.getTCP(_tcp);
      piece.position.set(_tcp.x, _tcp.y, Math.max(tableZ, _tcp.z - graspOffset));
      piece.rotation.set(Math.PI / 2, 0, 0);
    }
  };

  // Piece follow is stateful (applied advances monotonically); reset when a frame
  // is posed out of order (e.g. scrubbing backward in the viewer).
  let lastPosed = -1;
  const poseFrame = (f: number): void => {
    const clamped = Math.max(0, Math.min(solvedAngles.length - 1, f));
    if (clamped < lastPosed) {
      applied = 0;
      piece.position.set(ep.spec.pieceStartMM[0] / 1000, ep.spec.pieceStartMM[1] / 1000, tableZ);
      piece.rotation.set(Math.PI / 2, 0, 0);
      lastPosed = -1;
    }
    robot.setAnglesDeg(solvedAngles[clamped]);
    robot.setGripper(grip[clamped]);
    robot.root.updateMatrixWorld(true);
    for (let k = Math.max(0, lastPosed + 1); k <= clamped; k++) updatePiece(k);
    lastPosed = clamped;
  };

  const duration = planned.duration;
  const episodeJson = {
    index: opts.index ?? 0,
    task: ep.task,
    num_frames: logged.length,
    success: true,
    duration_s: +duration.toFixed(3),
  };

  return {
    scenario, seed, task: ep.task,
    scene, robot, overhead, wrist, piece, tableZ,
    trueFrames: planned.frames, solvedAngles, grip, logged,
    waypoints: planned.waypoints,
    attachFrame, detachFrame,
    numFrames: logged.length,
    fps: ep.motion.fps,
    episodeJson,
    manifest: ep.manifest,
    stats: {
      maxErr_mm: +(maxErr * 1000).toFixed(2),
      meanErr_mm: +((sumErr / planned.frames.length) * 1000).toFixed(2),
      dupFraction: +duplicateFraction(logged).toFixed(3),
      graspFrame: attachFrame,
      releaseFrame: detachFrame,
      duration_s: +duration.toFixed(3),
    },
    poseFrame,
  };
}
