import * as THREE from "three";
import { Xarm5Robot } from "./robot";
import { createPiece } from "../pieces";
import { squareCenter, buildBoard, BOARD_TOP } from "./board";

/**
 * Trajectory replay: drive the official xArm5 along a recorded rollout `state`
 * path (per-frame IK to the TCP + gripper), render the overhead|wrist composite.
 *
 * Everything is in the ROS arm-base frame (Z up, meters), so the recorded state
 * (mm) maps in 1:1 after mm->m. The board is placed from the data-derived pose.
 */

// Composite matches the source: 32px caption over two 320x240 camera images.
const W = 640, H = 272, HALF = 320, IMG_H = 240, CAP = H - IMG_H; // CAP = 32
const OUTPUT_FPS = 30; // resample the ~14fps recorded states to smooth output

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
scene.add(buildBoard());

// --- Cameras ----------------------------------------------------------------
// Overhead pose from PnP fit to the real base image (tools/pnp-overhead.mjs).
const overhead = new THREE.PerspectiveCamera(44, HALF / IMG_H, 0.01, 50);
overhead.up.set(0, 0, 1);
overhead.position.set(0.4667, 0.4617, 0.9797);
overhead.lookAt(0.4226, 0.0223, 0.2235);

// Wrist camera — RIGIDLY ATTACHED to the wrist (endEffector frame). Since J5
// locks the tool yaw, the endEffector orientation is constant in world, so the
// camera holds a fixed orientation and only translates with the arm — exactly
// like the real wrist cam. Mount pose is tunable (to be PnP-calibrated later).
// Grip plane azimuth (world). The jaws (and the wrist camera mounted on them)
// rotate with this. The jaw plane is symmetric, so -90deg keeps the same grip
// plane as +90deg but flips the mounted camera 180deg into the correct view.
robot.toolYawTarget = -Math.PI / 2;
const wrist = new THREE.PerspectiveCamera(58, HALF / H, 0.005, 6);
robot.endEffector.add(wrist);
wrist.position.set(0, -0.075, -0.055); // local: beside + above the gripper
wrist.rotation.set(Math.PI - (2 * Math.PI) / 180, 0, 0); // wrist tilt = 2deg (calibrated)

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

  // The recorded state stream is ~14fps with ~1/3 exact-duplicate frames (state
  // logged slower than the camera). Dedupe to distinct keyframes, solve IK once
  // per keyframe, then RESAMPLE by interpolating at a smooth output framerate.
  const keys: { t: number; state: number[]; angles: number[] }[] = [];
  let maxErr = 0, sumErr = 0, nKey = 0;
  for (let i = 0; i < frames.length; i++) {
    const s = frames[i].state;
    const prev = keys[keys.length - 1];
    const dup = prev && Math.abs(prev.state[0] - s[0]) < 1e-4 &&
      Math.abs(prev.state[1] - s[1]) < 1e-4 && Math.abs(prev.state[2] - s[2]) < 1e-4;
    if (dup && i !== frames.length - 1) continue;
    _t.set(s[0] / 1000, s[1] / 1000, s[2] / 1000);
    const r = robot.solveIK(_t, { tolerance: 0.004, maxIterations: 100 });
    robot.setAnglesDeg(r.angles);
    keys.push({ t: frames[i].t, state: s, angles: r.angles.slice() });
    const e = robot.getTCP(new THREE.Vector3()).distanceTo(_t);
    maxErr = Math.max(maxErr, e); sumErr += e; nKey++;
  }

  // Resample to OUTPUT_FPS with linear interpolation between keyframes.
  const duration = frames[frames.length - 1].t;
  const nOut = Math.round(duration * OUTPUT_FPS) + 1;
  const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
  let ki = 0;
  for (let j = 0; j < nOut; j++) {
    const t = Math.min(duration, j / OUTPUT_FPS);
    while (ki < keys.length - 2 && keys[ki + 1].t < t) ki++;
    const a = keys[ki], b = keys[Math.min(ki + 1, keys.length - 1)];
    const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    solvedAngles.push(a.angles.map((v, c) => lerp(v, b.angles[c], u)));
    grip.push(lerp(a.state[4], b.state[4], u));
  }
  attachFrame = grip.findIndex((g) => g < 0.5);
  detachFrame = grip.findIndex((g, i) => i > attachFrame + 2 && g > 0.5);

  (window as unknown as Record<string, unknown>).REPLAY = {
    totalFrames: solvedAngles.length,
    fps: OUTPUT_FPS,
    renderFrame,
    stats: { maxErr_mm: maxErr * 1000, meanErr_mm: (sumErr / nKey) * 1000, keyframes: nKey, attachFrame, detachFrame, task },
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
  // Two 320x240 views sit BELOW the caption band. WebGL viewport origin is
  // bottom-left, so the images occupy y=0..IMG_H and the caption is the top CAP.
  renderer.setScissorTest(true);
  overhead.aspect = HALF / IMG_H; overhead.updateProjectionMatrix();
  renderer.setViewport(0, 0, HALF, IMG_H); renderer.setScissor(0, 0, HALF, IMG_H);
  renderer.render(scene, overhead);
  wrist.aspect = HALF / IMG_H; wrist.updateProjectionMatrix();
  renderer.setViewport(HALF, 0, HALF, IMG_H); renderer.setScissor(HALF, 0, HALF, IMG_H);
  renderer.render(scene, wrist);
  renderer.setScissorTest(false);

  ctx.clearRect(0, 0, W, H);
  // The GL render occupies the bottom IMG_H rows (WebGL origin is bottom-left);
  // copy that strip (source y = CAP) down below the caption band.
  ctx.drawImage(glCanvas, 0, CAP, W, IMG_H, 0, CAP, W, IMG_H);
  ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect(HALF - 1, CAP, 2, IMG_H);
  ctx.fillStyle = "rgba(0,0,0,0.62)"; ctx.fillRect(0, 0, W, CAP);
  ctx.font = "600 16px system-ui, sans-serif"; ctx.fillStyle = "#f4f4f4"; ctx.textBaseline = "middle";
  ctx.fillText(task, 8, CAP / 2);
}

function renderFrame(i: number): string {
  const f = Math.max(0, Math.min(solvedAngles.length - 1, i));
  applyGripState(f);
  robot.setAnglesDeg(solvedAngles[f]);
  robot.setGripper(grip[f]);
  robot.root.updateMatrixWorld(true);
  renderComposite();
  return out.toDataURL("image/png");
}

load();
