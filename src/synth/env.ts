import * as THREE from "three";
import { resolveScenario } from "./scenario";
import { buildScene } from "./scene";
import { mulberry32 } from "./rng";
import { Xarm5Robot } from "../xarm5/robot";

/**
 * Closed-loop environment for policy control (e.g. π0.5 via openpi). Unlike the
 * generator (which plans a full trajectory), the env is driven step-by-step by
 * external actions: reset(scenario, seed) -> obs; step([x,y,z,yaw,grip]) -> obs;
 * success() -> goal check. Grasping is DYNAMIC (emerges from the gripper action),
 * so a policy has to actually close on the piece to move it.
 *
 * Units match the dataset: action/state = [x, y, z (mm), yaw (deg), gripper 0..1].
 * Exposed on window.ENV for tools/sim-server.mjs.
 */

const IMG_W = 320, IMG_H = 240, JPEG_Q = 0.85;
const HOME_MM: [number, number, number] = [257, -33, 313];
const BASE_YAW_OFFSET = -Math.PI / 2;
const CLOSE_THRESH = 0.5;   // gripper < this = closing
const OPEN_THRESH = 0.6;    // gripper > this = open
const GRASP_DIST = 0.05;    // m: TCP must be within this of the piece to grab it

const canvas = (document.getElementById("out") as HTMLCanvasElement) ?? document.createElement("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(IMG_W, IMG_H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

interface EnvState {
  scene: THREE.Scene;
  robot: Xarm5Robot;
  overhead: THREE.PerspectiveCamera;
  wrist: THREE.PerspectiveCamera;
  piece: THREE.Group;
  tableZ: number;
  task: string;
  goalKind: "move" | "pickup";
  graspXY: [number, number];
  placeXY: [number, number] | null;
  holding: boolean;
  released: boolean;
  graspOffset: number;
  lastYaw: number;
  maxLiftZ: number;
  steps: number;
}
let S: EnvState | null = null;
const _v = new THREE.Vector3();

function poseTo(robot: Xarm5Robot, mm: [number, number, number], yawDeg: number, grip: number): void {
  robot.toolYawTarget = BASE_YAW_OFFSET + (yawDeg * Math.PI) / 180;
  _v.set(mm[0] / 1000, mm[1] / 1000, mm[2] / 1000);
  const r = robot.solveIK(_v, { tolerance: 0.004, maxIterations: 100 });
  robot.setAnglesDeg(r.angles);
  robot.setGripper(grip);
  robot.root.updateMatrixWorld(true);
}

function renderCam(cam: THREE.PerspectiveCamera): string {
  cam.aspect = IMG_W / IMG_H;
  cam.updateProjectionMatrix();
  renderer.setViewport(0, 0, IMG_W, IMG_H);
  renderer.render(S!.scene, cam);
  return canvas.toDataURL("image/jpeg", JPEG_Q).split(",")[1]; // base64 (no prefix)
}

function obs(): Record<string, unknown> {
  const tcp = S!.robot.getTCP(new THREE.Vector3());
  return {
    base: renderCam(S!.overhead),
    wrist: renderCam(S!.wrist),
    state: [tcp.x * 1000, tcp.y * 1000, tcp.z * 1000, S!.lastYaw, S!.robot.getGripper()],
  };
}

async function reset(scenario: string, seed: number): Promise<Record<string, unknown>> {
  const ep = resolveScenario(scenario, seed);
  const built = await buildScene(ep.spec, mulberry32(seed ^ 0x9e3779b9));
  const yawDeg = ep.primitive.kind === "move" && ep.manifest.motion ? (ep.manifest.motion as Record<string, number>).yawDeg ?? 0 : 0;
  S = {
    scene: built.scene, robot: built.robot, overhead: built.overhead, wrist: built.wrist,
    piece: built.piece, tableZ: built.tableZ, task: ep.task,
    goalKind: ep.primitive.kind, graspXY: ep.primitive.graspXY, placeXY: ep.primitive.placeXY ?? null,
    holding: false, released: false, graspOffset: 0.045, lastYaw: 0, maxLiftZ: built.tableZ * 1000, steps: 0,
  };
  // Piece at its start; arm at the home pose (gripper open).
  S.piece.position.set(S.graspXY[0] / 1000, S.graspXY[1] / 1000, S.tableZ);
  S.piece.rotation.set(Math.PI / 2, 0, 0);
  poseTo(S.robot, HOME_MM, 0, 1.0);
  void yawDeg; // yaw is commanded by the policy via the action, not preset
  const o = obs();
  return { ...o, task: S.task, goalKind: S.goalKind };
}

function step(action: number[]): Record<string, unknown> {
  if (!S) throw new Error("env not reset");
  const [x, y, z, yaw, grip] = action;
  S.lastYaw = yaw;
  poseTo(S.robot, [x, y, z], yaw, grip);
  const tcp = S.robot.getTCP(new THREE.Vector3());

  // Dynamic grasp: close near the piece -> attach; open while holding -> release.
  if (!S.holding && !S.released && grip < CLOSE_THRESH) {
    const pw = S.piece.getWorldPosition(new THREE.Vector3());
    if (tcp.distanceTo(pw) < GRASP_DIST) { S.holding = true; S.graspOffset = tcp.z - S.tableZ; }
  } else if (S.holding && grip > OPEN_THRESH) {
    S.holding = false; S.released = true;
    S.piece.position.z = S.tableZ;
    S.piece.rotation.set(Math.PI / 2, 0, 0);
  }
  if (S.holding) {
    S.piece.position.set(tcp.x, tcp.y, Math.max(S.tableZ, tcp.z - S.graspOffset));
    S.piece.rotation.set(Math.PI / 2, 0, 0);
  }
  S.maxLiftZ = Math.max(S.maxLiftZ, S.piece.getWorldPosition(new THREE.Vector3()).z * 1000);
  S.steps++;
  return obs();
}

function success(): Record<string, unknown> {
  if (!S) throw new Error("env not reset");
  const pw = S.piece.getWorldPosition(new THREE.Vector3());
  if (S.goalKind === "move") {
    if (!S.placeXY) return { success: false, reason: "no goal" };
    const dist = Math.hypot(pw.x * 1000 - S.placeXY[0], pw.y * 1000 - S.placeXY[1]);
    return { success: S.released && dist < 30, released: S.released, dist_mm: +dist.toFixed(1) };
  }
  // pickup: piece lifted well above the table at some point
  return { success: S.maxLiftZ > 150, maxLiftZ_mm: +S.maxLiftZ.toFixed(1), holding: S.holding };
}

(window as unknown as Record<string, unknown>).ENV = {
  ready: true,
  reset: (scenario: string, seed: number) => reset(scenario, seed),
  step: (action: number[]) => step(action),
  success: () => success(),
  info: () => (S ? { task: S.task, goalKind: S.goalKind, graspXY: S.graspXY, placeXY: S.placeXY, steps: S.steps, holding: S.holding, released: S.released } : null),
};
