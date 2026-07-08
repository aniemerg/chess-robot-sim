import * as THREE from "three";
import { Xarm5Robot } from "./robot";
import { createPiece } from "../pieces";

/**
 * Trajectory replay: drive the official xArm5 along a recorded rollout `state`
 * path (per-frame IK to the TCP + gripper), render the overhead|wrist composite.
 *
 * Everything is in the ROS arm-base frame (Z up, meters), so the recorded state
 * (mm) maps in 1:1 after mm->m. The board is placed from the data-derived pose.
 */

const W = 640, H = 272, HALF = 320;

// Board grid fitted from grasp/release anchors (see docs/rollout_data_analysis).
// square_center(file,rank) in mm:  x = 1.61f + 56.81r + 251.49 ; y = -56.89f + 1.28r + 211.65
const A1 = new THREE.Vector3(0.25149, 0.21165, 0);
const U_FILE = new THREE.Vector3(0.00161, -0.05689, 0); // per file (a->h)
const V_RANK = new THREE.Vector3(0.05681, 0.00128, 0); // per rank (1->8)
const SQUARE = 0.0569;

function squareCenter(file: number, rank: number): THREE.Vector3 {
  return A1.clone().addScaledVector(U_FILE, file).addScaledVector(V_RANK, rank);
}
const parseSquare = (s: string): [number, number] => [s.charCodeAt(0) - 97, Number(s[1]) - 1];

interface Frame { i: number; t: number; state: number[]; action: number[]; }

// --- Scene ------------------------------------------------------------------
const glCanvas = document.createElement("canvas");
const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const out = document.getElementById("out") as HTMLCanvasElement;
out.width = W; out.height = H;
const ctx = out.getContext("2d")!;

const scene = new THREE.Scene();
const TABLE = 0xcdb488;
scene.background = new THREE.Color(TABLE).multiplyScalar(0.85);
scene.add(new THREE.HemisphereLight(0xffffff, 0xa8a99c, 1.15));
const key = new THREE.DirectionalLight(0xffffff, 0.9);
key.position.set(0.4, -0.3, 1.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.1; key.shadow.camera.far = 5;
key.shadow.radius = 3;
scene.add(key);
scene.add(new THREE.DirectionalLight(0xffffff, 0.3));

const desk = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ color: TABLE, roughness: 0.9 }));
desk.position.z = -0.004; desk.receiveShadow = true; // clearly below the board (board bottom at z=0)
scene.add(desk);

const robot = new Xarm5Robot();
scene.add(robot.root);

// --- Board (data pose) ------------------------------------------------------
const boardGroup = new THREE.Group();
scene.add(boardGroup);
const boardYaw = Math.atan2(V_RANK.y, V_RANK.x);
const lightMat = new THREE.MeshStandardMaterial({ color: 0xe7e2d0, roughness: 0.6 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x2f6b43, roughness: 0.6 });
// Board sits on the desk: border 0..0.006, tiles on top 0.005..0.009.
const tileGeo = new THREE.BoxGeometry(SQUARE, SQUARE, 0.004);
for (let f = 0; f < 8; f++) for (let r = 0; r < 8; r++) {
  const isLight = (f + r) % 2 === 1; // a1 (0,0) dark, standard
  const tile = new THREE.Mesh(tileGeo, isLight ? lightMat : darkMat);
  const c = squareCenter(f, r);
  tile.position.set(c.x, c.y, 0.007);
  tile.rotation.z = boardYaw;
  tile.receiveShadow = true;
  boardGroup.add(tile);
}
{
  const c = squareCenter(3.5, 3.5);
  const border = new THREE.Mesh(new THREE.BoxGeometry(SQUARE * 8 + 0.02, SQUARE * 8 + 0.02, 0.006),
    new THREE.MeshStandardMaterial({ color: 0xd8d1bb, roughness: 0.7 }));
  border.position.set(c.x, c.y, 0.003); border.rotation.z = boardYaw; border.receiveShadow = true;
  boardGroup.add(border);
}
const BOARD_TOP = 0.009;
// labels
function labelMesh(txt: string): THREE.Mesh {
  const cv = document.createElement("canvas"); cv.width = cv.height = 64;
  const g = cv.getContext("2d")!; g.fillStyle = "#20242b"; g.font = "bold 44px sans-serif";
  g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(txt, 32, 34);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.03, 0.03),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
  m.rotation.z = boardYaw; return m;
}
for (let f = 0; f < 8; f++) { const c = squareCenter(f, -0.8); const l = labelMesh("abcdefgh"[f]); l.position.set(c.x, c.y, BOARD_TOP + 0.001); boardGroup.add(l); }
for (let r = 0; r < 8; r++) { const c = squareCenter(-0.8, r); const l = labelMesh(String(r + 1)); l.position.set(c.x, c.y, BOARD_TOP + 0.001); boardGroup.add(l); }

// --- Cameras ----------------------------------------------------------------
const boardCenter = squareCenter(3.5, 3.5);
const overhead = new THREE.PerspectiveCamera(42, HALF / H, 0.01, 50);
overhead.up.set(0, 0, 1);
overhead.position.set(boardCenter.x - 0.02, -0.62, 0.92);
overhead.lookAt(boardCenter.x, boardCenter.y, 0.02);

// Wrist camera — RIGIDLY ATTACHED to the wrist (endEffector frame). Since J5
// locks the tool yaw, the endEffector orientation is constant in world, so the
// camera holds a fixed orientation and only translates with the arm — exactly
// like the real wrist cam. Mount pose is tunable (to be PnP-calibrated later).
// Grip plane azimuth (world). The jaws (and the wrist camera mounted on them)
// rotate with this. 90deg puts the jaws perpendicular to the +x default.
robot.toolYawTarget = Math.PI / 2;
const wrist = new THREE.PerspectiveCamera(58, HALF / H, 0.005, 6);
robot.endEffector.add(wrist);
wrist.position.set(0, -0.075, -0.055); // local: beside + above the gripper
wrist.rotation.set(Math.PI - 0.42, 0, 0); // look down, tilted toward the gripper/board

// --- Episode setup ----------------------------------------------------------
const params = new URLSearchParams(location.search);
const epId = params.get("episode") ?? "v2_001";

let frames: Frame[] = [];
let task = "";
let solvedAngles: number[][] = [];
let grip: number[] = [];
let queen: THREE.Group | null = null;
let fromSq: [number, number] = [4, 6];
let toSq: [number, number] = [7, 0];
let attachFrame = -1, detachFrame = -1;

const _t = new THREE.Vector3();

async function load(): Promise<void> {
  const meta = await (await fetch(`/rollouts/${epId}/episode.json`)).json();
  task = meta.task;
  const text = await (await fetch(`/rollouts/${epId}/frames.jsonl`)).text();
  frames = text.trim().split("\n").map((l) => JSON.parse(l));

  // parse from/to from "... from e7 to h1"
  const m = task.match(/from ([a-h][1-8]) to ([a-h][1-8])/);
  if (m) { fromSq = parseSquare(m[1]); toSq = parseSquare(m[2]); }

  // queen at from-square
  queen = createPiece("queen", "white");
  queen.rotation.x = Math.PI / 2; // stand up in Z-up frame
  const fc = squareCenter(fromSq[0], fromSq[1]);
  queen.position.set(fc.x, fc.y, BOARD_TOP);
  scene.add(queen);

  // gripper transitions
  grip = frames.map((f) => f.state[4]);
  attachFrame = grip.findIndex((g) => g < 0.5);
  detachFrame = grip.findIndex((g, i) => i > attachFrame + 2 && g > 0.5);

  // precompute IK (warm-started for continuity)
  let maxErr = 0, sumErr = 0;
  for (let i = 0; i < frames.length; i++) {
    const s = frames[i].state;
    _t.set(s[0] / 1000, s[1] / 1000, s[2] / 1000);
    const r = robot.solveIK(_t, { tolerance: 0.004, maxIterations: 100 });
    robot.setAnglesDeg(r.angles);
    solvedAngles.push(r.angles.slice());
    const e = robot.getTCP(new THREE.Vector3()).distanceTo(_t);
    maxErr = Math.max(maxErr, e); sumErr += e;
  }
  (window as unknown as Record<string, unknown>).REPLAY = {
    totalFrames: frames.length,
    fps: 14,
    times: frames.map((f) => f.t),
    renderFrame,
    stats: { maxErr_mm: maxErr * 1000, meanErr_mm: (sumErr / frames.length) * 1000, attachFrame, detachFrame, task },
  };
  renderFrame(0);
}

let applied = 0; // 0=none, 1=attached, 2=detached
function applyGripState(i: number): void {
  if (!queen) return;
  if (applied < 1 && attachFrame >= 0 && i >= attachFrame) {
    robot.gripper.attach(queen); // preserve world transform
    applied = 1;
  }
  if (applied < 2 && detachFrame >= 0 && i >= detachFrame) {
    const tc = squareCenter(toSq[0], toSq[1]);
    scene.attach(queen);
    queen.position.set(tc.x, tc.y, BOARD_TOP);
    queen.rotation.set(Math.PI / 2, 0, 0);
    applied = 2;
  }
}

function renderComposite(): void {
  renderer.setScissorTest(true);
  renderer.setViewport(0, 0, HALF, H); renderer.setScissor(0, 0, HALF, H);
  renderer.render(scene, overhead);
  renderer.setViewport(HALF, 0, HALF, H); renderer.setScissor(HALF, 0, HALF, H);
  wrist.aspect = HALF / H; wrist.updateProjectionMatrix();
  renderer.render(scene, wrist);
  renderer.setScissorTest(false);

  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(glCanvas, 0, 0);
  ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect(HALF - 1, 0, 2, H);
  ctx.fillStyle = "rgba(0,0,0,0.42)"; ctx.fillRect(0, 0, W, 24);
  ctx.font = "600 15px system-ui, sans-serif"; ctx.fillStyle = "#f4f4f4"; ctx.textBaseline = "middle";
  ctx.fillText(task, 8, 13);
}

function renderFrame(i: number): string {
  const f = Math.max(0, Math.min(frames.length - 1, i));
  applyGripState(f);
  robot.setAnglesDeg(solvedAngles[f]);
  robot.setGripper(grip[f]);
  robot.root.updateMatrixWorld(true);
  renderComposite();
  return out.toDataURL("image/png");
}

load();
