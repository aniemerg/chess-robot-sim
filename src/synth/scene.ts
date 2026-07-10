import * as THREE from "three";
import { Xarm5Robot } from "../xarm5/robot";
import { PieceType, PieceColor } from "../pieces";
import { buildBoard, BOARD_TOP } from "../xarm5/board";
import { makePiece } from "./piece_models";
import { FloorSpec, sampleFloor, makeFloorMaterial } from "./floors";
import { Rng, uniform, gauss, pick, chance, randInt } from "./rng";

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
export interface DirLightSpec {
  azimuthDeg: number; // horizontal direction the light comes from
  elevationDeg: number; // angle above the table
  intensity: number;
  color: number; // color temperature (hex)
  shadow: boolean;
  softness: number; // shadow blur radius
}
export interface LightingSpec {
  ambient: number;
  ambientColor: number;
  hemi: number; // hemisphere intensity (0 = off)
  hemiSky: number;
  hemiGround: number;
  dir: DirLightSpec[]; // 1-3 sun-like directional sources at varied angles
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
  floor: FloorSpec;
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
  // Background wall tinted from the floor color so the scene reads coherently.
  scene.background = new THREE.Color(spec.floor.color).multiplyScalar(spec.floor.bgScale);

  const L = spec.lighting;
  scene.add(new THREE.AmbientLight(L.ambientColor, L.ambient));
  if (L.hemi > 0) scene.add(new THREE.HemisphereLight(L.hemiSky, L.hemiGround, L.hemi));
  const workCenter = new THREE.Vector3(0.42, 0, 0.12);
  for (const d of L.dir) {
    const light = new THREE.DirectionalLight(d.color, d.intensity);
    const el = (d.elevationDeg * Math.PI) / 180, az = (d.azimuthDeg * Math.PI) / 180, D = 2.4;
    light.position.set(
      workCenter.x + Math.cos(el) * Math.cos(az) * D,
      workCenter.y + Math.cos(el) * Math.sin(az) * D,
      workCenter.z + Math.sin(el) * D
    );
    const tgt = new THREE.Object3D();
    tgt.position.copy(workCenter);
    scene.add(tgt);
    light.target = tgt;
    if (d.shadow) {
      light.castShadow = true;
      light.shadow.mapSize.set(2048, 2048);
      light.shadow.camera.near = 0.1;
      light.shadow.camera.far = 6;
      const cam = light.shadow.camera as THREE.OrthographicCamera;
      cam.left = -1.2; cam.right = 1.2; cam.top = 1.2; cam.bottom = -1.2;
      cam.updateProjectionMatrix();
      light.shadow.radius = d.softness;
    }
    scene.add(light);
  }

  const deskMat = makeFloorMaterial(spec.floor, rng);
  const desk = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), deskMat);
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

// Light color temperatures from warm (tungsten) through neutral to cool (shade/sky).
const LIGHT_COLORS = [0xffffff, 0xfff1e0, 0xffe6c0, 0xffd9a8, 0xf3f6ff, 0xdfeaff, 0xcfe0ff, 0xfff8ee];

/** Sample a lighting rig: ambient + optional hemisphere + 1-3 sun-like directionals. */
function sampleLighting(rng: Rng): LightingSpec {
  const n = randInt(rng, 1, 3);
  const dir: DirLightSpec[] = [];
  for (let i = 0; i < n; i++) {
    dir.push({
      azimuthDeg: uniform(rng, 0, 360),
      elevationDeg: uniform(rng, 22, 82),
      // one bright key (casts shadow) + dimmer fills from other directions
      intensity: i === 0 ? uniform(rng, 0.65, 1.15) : uniform(rng, 0.15, 0.5),
      color: pick(rng, LIGHT_COLORS),
      shadow: i === 0,
      softness: uniform(rng, 1, 6),
    });
  }
  return {
    ambient: uniform(rng, 0.06, 0.45),
    ambientColor: pick(rng, LIGHT_COLORS),
    hemi: chance(rng, 0.6) ? uniform(rng, 0.2, 0.85) : 0,
    hemiSky: pick(rng, [0xffffff, 0xdfeaff, 0xfff1e0]),
    hemiGround: pick(rng, [0xa8a99c, 0x8a8f96, 0x6b5a3a, 0x555a52]),
    dir,
  };
}

/** Sample near-real lighting/camera/floor jitter around the calibrated setup. */
export function sampleSceneRandomization(
  rng: Rng,
  base: { overhead: CameraSpec; wristTilt: number }
): {
  lighting: LightingSpec;
  floor: FloorSpec;
  overhead: CameraSpec;
  wristTilt: number;
  boardOffset: { x: number; y: number; yaw: number };
} {
  return {
    lighting: sampleLighting(rng),
    floor: sampleFloor(rng),
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
