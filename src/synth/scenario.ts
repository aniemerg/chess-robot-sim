import * as THREE from "three";
import { squareCenter } from "../xarm5/board";
import { PieceType, PieceColor, pieceHeight } from "../pieces";
import { Primitive, MotionParams, sampleMotionParams } from "./motion";
import { SceneSpec, sampleSceneRandomization, CameraSpec } from "./scene";
import { PIECE_SET_IDS, pieceSetLicense } from "./piece_models";
import { Rng, mulberry32, uniform, gauss, pick, randInt } from "./rng";

/**
 * Scenario generator: (scenario name, seed) -> a fully resolved episode spec
 * (scene + motion primitive + task text) plus a flat manifest recording every
 * sampled value for ablations. The parametric-core families from the plan §3.
 */

export const ENGINE_VERSION = "synth-0.1";
const BASE_YAW_OFFSET = -Math.PI / 2; // calibration offset validated in replay.ts

// Calibrated overhead presets to jitter around (from episodes.ts).
// Overhead framed to keep the whole chessboard footprint in view with margin
// (used for board moves AND bare-table pickups, so the framing is consistent).
const OVERHEAD_BOARD: CameraSpec = { pos: [0.4667, 0.4617, 0.9797], target: [0.4226, 0.0223, 0.2235], fov: 52 };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const FILES = "abcdefgh";
const sqName = (f: number, r: number) => `${FILES[f]}${r + 1}`;
const sqMM = (f: number, r: number): [number, number] => {
  const c = squareCenter(f, r, new THREE.Vector3());
  return [c.x * 1000, c.y * 1000];
};

/** Near-real shade tint (slight per-channel variation around neutral). */
function sampleTint(rng: Rng, color: PieceColor): number {
  const base = color === "white" ? 0.95 : 1.0;
  const r = Math.min(1, base + gauss(rng, 0, 0.05));
  const g = Math.min(1, base + gauss(rng, 0, 0.05));
  const b = Math.min(1, base + gauss(rng, 0, 0.05));
  return new THREE.Color(r, g, b).getHex();
}

function samplePieceSpec(rng: Rng, type: PieceType, color: PieceColor) {
  return {
    type,
    color,
    model: pick(rng, PIECE_SET_IDS), // procedural or a sourced set
    tint: sampleTint(rng, color),
    roughness: uniform(rng, 0.42, 0.6),
    metalness: uniform(rng, 0.05, 0.2),
    scale: gauss(rng, 1.0, 0.02),
  };
}

export interface ResolvedEpisode {
  scenario: string;
  task: string;
  template: string;
  spec: SceneSpec;
  primitive: Primitive;
  motion: MotionParams;
  manifest: Record<string, unknown>;
}

const PICKUP_PIECES: PieceType[] = ["king", "bishop", "rook", "pawn", "knight", "queen"];

export function resolveScenario(scenario: string, seed: number): ResolvedEpisode {
  const rng = mulberry32(seed);

  let template: string, task: string, primitive: Primitive;
  let board: boolean, pieceType: PieceType, color: PieceColor;
  let baseOverhead: CameraSpec, pieceStartMM: [number, number];
  let yawDeg = 0;
  // Grasp height scales with the piece: ~46mm for the queen (matches real), less
  // for shorter pieces, so the fingers always close on the piece body (not above
  // it). This also keeps the piece near the fingertips in the wrist view.
  const graspHeight = (t: PieceType) => pieceHeight(t) * 1000 * uniform(rng, 0.66, 0.72);

  if (scenario === "queen_move" || scenario === "queen_move_yaw90") {
    board = true;
    pieceType = "queen";
    color = "white";
    yawDeg = scenario === "queen_move_yaw90" ? 90 : 0;
    baseOverhead = OVERHEAD_BOARD;
    // distinct from/to squares
    const ff = randInt(rng, 0, 7), fr = randInt(rng, 0, 7);
    let tf = randInt(rng, 0, 7), tr = randInt(rng, 0, 7);
    while (tf === ff && tr === fr) { tf = randInt(rng, 0, 7); tr = randInt(rng, 0, 7); }
    const from = sqName(ff, fr), to = sqName(tf, tr);
    pieceStartMM = sqMM(ff, fr);
    const placeMM = sqMM(tf, tr);
    const graspZ = graspHeight("queen");
    template = "move the {color} {piece} from {A} to {B}";
    task = `move the ${color} ${pieceType} from ${from} to ${to}`;
    primitive = { kind: "move", graspXY: pieceStartMM, placeXY: placeMM, graspZ, placeZ: graspZ + gauss(rng, 0, 0.8) };
  } else if (scenario === "table_pickup" || scenario === "table_pickup_slow") {
    board = false;
    pieceType = pick(rng, PICKUP_PIECES.filter((p) => p !== "queen")); // non-queen (like real)
    color = pick(rng, ["white", "black"] as PieceColor[]);
    // Place the piece within the chessboard's footprint so the workspace framing
    // (which keeps the board area in view even when no board is present) contains it.
    pieceStartMM = [clamp(gauss(rng, 456, 110), 285, 620), clamp(gauss(rng, 17, 110), -175, 190)];
    baseOverhead = OVERHEAD_BOARD; // frame the board-footprint region, board present or not
    template = "pick up the {color} {piece}";
    task = `pick up the ${color} ${pieceType}`;
    primitive = { kind: "pickup", graspXY: pieceStartMM, graspZ: graspHeight(pieceType), pickupLiftZ: gauss(rng, 364, 8) };
  } else {
    throw new Error(`unknown scenario: ${scenario}`);
  }

  const motion = sampleMotionParams(rng, yawDeg);
  // Pickups are FAST by default (approach -> grasp -> lift -> brief hold). The
  // slow, long-hover variant (matching the real 13.5-31.5s pickups) is gated
  // behind the explicit `table_pickup_slow` scenario.
  if (scenario === "table_pickup_slow") motion.pickupTargetDur = clamp(gauss(rng, 22, 4.5), 13.5, 31.5);
  const rand = sampleSceneRandomization(rng, { overhead: baseOverhead, wristTilt: 2 });
  const pieceSpec = samplePieceSpec(rng, pieceType, color);

  const spec: SceneSpec = {
    board,
    boardOffset: rand.boardOffset,
    piece: pieceSpec,
    pieceStartMM,
    overhead: rand.overhead,
    wristTilt: rand.wristTilt,
    lighting: rand.lighting,
    floor: rand.floor,
    toolYawOffsetRad: BASE_YAW_OFFSET + (yawDeg * Math.PI) / 180,
  };

  const manifest: Record<string, unknown> = {
    seed,
    scenario,
    engine_version: ENGINE_VERSION,
    tier: "in_distribution",
    task,
    template,
    pieces: [{
      type: pieceType,
      color,
      model: pieceSpec.model,
      license: pieceSetLicense(pieceSpec.model),
      tint: `#${pieceSpec.tint.toString(16).padStart(6, "0")}`,
      roughness: +pieceSpec.roughness.toFixed(3),
      metalness: +pieceSpec.metalness.toFixed(3),
      scale: +pieceSpec.scale.toFixed(3),
      startMM: pieceStartMM.map((v) => +v.toFixed(1)),
      graspMM: primitive.graspXY.map((v) => +v.toFixed(1)),
      placeMM: primitive.placeXY ? primitive.placeXY.map((v) => +v.toFixed(1)) : null,
    }],
    scene: {
      board,
      boardOffset: rand.boardOffset,
      floor: {
        family: rand.floor.family,
        color: `#${rand.floor.color.toString(16).padStart(6, "0")}`,
        color2: `#${rand.floor.color2.toString(16).padStart(6, "0")}`,
        roughness: +rand.floor.roughness.toFixed(3),
        repeat: +rand.floor.repeat.toFixed(2),
        rotationDeg: +rand.floor.rotationDeg.toFixed(1),
      },
    },
    motion: {
      yawDeg,
      travelZ: +motion.travelZ.toFixed(1),
      graspZ: +primitive.graspZ.toFixed(1),
      placeZ: primitive.placeZ != null ? +primitive.placeZ.toFixed(1) : null,
      speed: +motion.speed.toFixed(1),
      gripperOpen: motion.gripperOpen,
      gripperClosed: +motion.gripperClosed.toFixed(3),
      dwellClose: +motion.dwellClose.toFixed(3),
      dwellOpen: +motion.dwellOpen.toFixed(3),
      fps: +motion.fps.toFixed(2),
      home: motion.home.map((v) => +v.toFixed(1)),
    },
    cameras: { overhead: rand.overhead, wristTilt: +rand.wristTilt.toFixed(2) },
    lighting: rand.lighting,
  };

  return { scenario, task, template, spec, primitive, motion, manifest };
}
