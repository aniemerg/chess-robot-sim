import * as THREE from "three";
import { Xarm5Robot } from "../xarm5/robot";
import { PieceType, PieceColor } from "../pieces";
import { buildBoard, BOARD_TOP, makeFloorTexture } from "../xarm5/board";
import { makePiece } from "./piece_models";
import { Rng, uniform, gauss } from "./rng";

/**
 * Build a randomized synthetic scene (robot + table/board + piece + lights +
 * two cameras) from a resolved spec. Reuses the official xArm5 model, the
 * data-fitted board, and the Staunton pieces used for replication, so synthetic
 * renders share the exact geometry the sim was validated against.
 */

export interface CameraSpec {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
}
export interface LightingSpec {
  hemi: number;
  keyIntensity: number;
  keyPos: [number, number, number];
  fillIntensity: number;
}
export interface PieceSpec {
  type: PieceType;
  color: PieceColor;
  model: string; // piece-set id (procedural_lathe | polyhaven_chess_set | ...)
  tint: number; // multiply color (hex) for shade variation
  roughness: number;
  metalness: number;
  scale: number;
}
export interface SceneSpec {
  board: boolean;
  boardOffset: { x: number; y: number; yaw: number };
  piece: PieceSpec;
  pieceStartMM: [number, number];
  overhead: CameraSpec;
  wristTilt: number; // deg
  lighting: LightingSpec;
  floorRoughness: number;
  toolYawOffsetRad: number; // J5 grip-plane azimuth (BASE + data yaw)
}

export interface BuiltScene {
  scene: THREE.Scene;
  robot: Xarm5Robot;
  overhead: THREE.PerspectiveCamera;
  wrist: THREE.PerspectiveCamera;
  piece: THREE.Group;
  tableZ: number;
}

const IMG_W = 320, IMG_H = 240;

function recolorPiece(piece: THREE.Group, spec: PieceSpec): void {
  const tint = new THREE.Color(spec.tint);
  piece.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as THREE.MeshStandardMaterial;
    const m = src.clone();
    m.color = src.color.clone().multiply(tint);
    // Only override scalar roughness/metalness when the material has no PBR maps
    // (procedural pieces). For sourced glTF sets, keep their maps intact.
    if (!m.roughnessMap) m.roughness = spec.roughness;
    if (!m.metalnessMap) m.metalness = spec.metalness;
    mesh.material = m;
  });
}

export async function buildScene(spec: SceneSpec, rng: Rng): Promise<BuiltScene> {
  const scene = new THREE.Scene();
  const TABLE = 0xcdb488;
  scene.background = new THREE.Color(TABLE).multiplyScalar(uniform(rng, 0.8, 0.9));

  scene.add(new THREE.HemisphereLight(0xffffff, 0xa8a99c, spec.lighting.hemi));
  const key = new THREE.DirectionalLight(0xffffff, spec.lighting.keyIntensity);
  key.position.set(...spec.lighting.keyPos);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.1;
  key.shadow.camera.far = 5;
  key.shadow.radius = 3;
  scene.add(key);
  scene.add(new THREE.DirectionalLight(0xffffff, spec.lighting.fillIntensity));

  const desk = new THREE.Mesh(
    new THREE.PlaneGeometry(4, 4),
    new THREE.MeshStandardMaterial({ map: makeFloorTexture(), roughness: spec.floorRoughness })
  );
  desk.position.z = -0.004;
  desk.receiveShadow = true;
  scene.add(desk);

  const robot = new Xarm5Robot();
  robot.toolYawTarget = spec.toolYawOffsetRad;
  scene.add(robot.root);

  const tableZ = spec.board ? BOARD_TOP : 0;
  if (spec.board) {
    const bg = buildBoard();
    bg.position.set(spec.boardOffset.x, spec.boardOffset.y, 0);
    bg.rotation.z = (spec.boardOffset.yaw * Math.PI) / 180;
    scene.add(bg);
  }

  const piece = await makePiece(spec.piece.model, spec.piece.type, spec.piece.color);
  recolorPiece(piece, spec.piece);
  piece.rotation.x = Math.PI / 2; // stand up in Z-up frame
  // Multiply (not overwrite): keep the model's normalization / style scale and
  // apply the per-episode scale jitter on top.
  piece.scale.multiplyScalar(spec.piece.scale);
  piece.position.set(spec.pieceStartMM[0] / 1000, spec.pieceStartMM[1] / 1000, tableZ);
  scene.add(piece);

  const overhead = new THREE.PerspectiveCamera(spec.overhead.fov, IMG_W / IMG_H, 0.01, 50);
  overhead.up.set(0, 0, 1);
  overhead.position.set(...spec.overhead.pos);
  overhead.lookAt(spec.overhead.target[0], spec.overhead.target[1], spec.overhead.target[2]);

  const wrist = new THREE.PerspectiveCamera(58, IMG_W / IMG_H, 0.005, 6);
  robot.endEffector.add(wrist);
  wrist.position.set(0, -0.075, -0.055);
  wrist.rotation.set(Math.PI - (spec.wristTilt * Math.PI) / 180, 0, 0);

  return { scene, robot, overhead, wrist, piece, tableZ };
}

/** Sample near-real lighting/camera/floor jitter around the calibrated setup. */
export function sampleSceneRandomization(
  rng: Rng,
  base: { overhead: CameraSpec; wristTilt: number }
): {
  lighting: LightingSpec;
  floorRoughness: number;
  overhead: CameraSpec;
  wristTilt: number;
  boardOffset: { x: number; y: number; yaw: number };
} {
  return {
    lighting: {
      hemi: gauss(rng, 1.15, 0.12),
      keyIntensity: gauss(rng, 0.9, 0.1),
      keyPos: [gauss(rng, 0.4, 0.15), gauss(rng, -0.3, 0.15), gauss(rng, 1.6, 0.2)],
      fillIntensity: gauss(rng, 0.3, 0.06),
    },
    floorRoughness: uniform(rng, 0.82, 0.95),
    // Overhead is an EXTERNAL camera whose pose varies per real setup — jitter it.
    overhead: {
      pos: [
        base.overhead.pos[0] + gauss(rng, 0, 0.01),
        base.overhead.pos[1] + gauss(rng, 0, 0.01),
        base.overhead.pos[2] + gauss(rng, 0, 0.01),
      ],
      target: [
        base.overhead.target[0] + gauss(rng, 0, 0.005),
        base.overhead.target[1] + gauss(rng, 0, 0.005),
        base.overhead.target[2] + gauss(rng, 0, 0.005),
      ],
      fov: base.overhead.fov + gauss(rng, 0, 0.6),
    },
    // The wrist camera is a FIXED hardware mount — its orientation is constant
    // across all real episodes, so it must NOT be randomized.
    wristTilt: base.wristTilt,
    boardOffset: { x: gauss(rng, 0, 0.002), y: gauss(rng, 0, 0.002), yaw: gauss(rng, 0, 0.4) },
  };
}
