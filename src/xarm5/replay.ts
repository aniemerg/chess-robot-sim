import * as THREE from "three";
import { Xarm5Robot } from "./robot";
import { createPiece } from "../pieces";
import { squareCenter, buildBoard, BOARD_TOP, makeFloorTexture } from "./board";
import { XEPISODES } from "./episodes";

/**
 * Trajectory replay: drive the official xArm5 along a recorded rollout `state`
 * path (per-frame IK to the TCP + gripper), render the overhead|wrist composite.
 * ROS arm-base frame (Z up, meters); recorded state (mm) maps 1:1. Per-episode
 * scene + cameras come from episodes.ts.
 */

// Composite matches the source: 32px caption over two 320x240 camera images.
const W = 640, H = 272, HALF = 320, IMG_H = 240, CAP = H - IMG_H;
const OUTPUT_FPS = 30; // resample the ~14fps recorded states to smooth output

const parseSquare = (s: string): [number, number] => [s.charCodeAt(0) - 97, Number(s[1]) - 1];
interface Frame { t: number; state: number[]; }

const params = new URLSearchParams(location.search);
const epId = params.get("episode") ?? "v2_001";
const ep = XEPISODES[epId];

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

const desk = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ map: makeFloorTexture(), roughness: 0.9 }));
desk.position.z = -0.004; desk.receiveShadow = true;
scene.add(desk);

const robot = new Xarm5Robot();
robot.toolYawTarget = -Math.PI / 2; // J5 locks the grip plane; wrist cam follows
scene.add(robot.root);

const tableZ = ep.board ? BOARD_TOP : 0;
if (ep.board) {
  const bg = buildBoard();
  if (ep.boardOffset) {
    bg.position.set(ep.boardOffset.x, ep.boardOffset.y, 0);
    bg.rotation.z = (ep.boardOffset.yaw * Math.PI) / 180;
  }
  scene.add(bg);
}

// --- Cameras (per-episode calibration) --------------------------------------
const overhead = new THREE.PerspectiveCamera(ep.overhead.fov, HALF / IMG_H, 0.01, 50);
overhead.up.set(0, 0, 1);
overhead.position.set(...ep.overhead.pos);
overhead.lookAt(ep.overhead.target[0], ep.overhead.target[1], ep.overhead.target[2]);

// Wrist camera rigidly attached to the wrist; tilt from calibration.
const wrist = new THREE.PerspectiveCamera(58, HALF / IMG_H, 0.005, 6);
robot.endEffector.add(wrist);
wrist.position.set(0, -0.075, -0.055);
wrist.rotation.set(Math.PI - (ep.wristTilt * Math.PI) / 180, 0, 0);

// --- Episode data -----------------------------------------------------------
let frames: Frame[] = [];
let task = "";
let solvedAngles: number[][] = [];
let grip: number[] = [];
let piece: THREE.Group | null = null;
let attachFrame = -1, detachFrame = -1;
const _t = new THREE.Vector3();

async function load(): Promise<void> {
  task = (await (await fetch(`/rollouts/${epId}/episode.json`)).json()).task;
  const text = await (await fetch(`/rollouts/${epId}/frames.jsonl`)).text();
  frames = text.trim().split("\n").map((l) => JSON.parse(l));

  // Dedupe the ~14fps state stream (~1/3 duplicates) to distinct keyframes,
  // solve IK once each, then resample with interpolation for smooth output.
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

  // Grasp/release detection, adaptive to each episode's gripper range.
  const g = keys.map((k) => k.state[4]);
  const gmin = Math.min(...g), gmax = Math.max(...g), range = Math.max(1e-6, gmax - gmin);
  const closeT = gmin + 0.4 * range, openT = gmin + 0.5 * range;
  // A rough estimate only disambiguates the grasp from the release on moves.
  let estX = 0, estY = 0, hasEst = false;
  if (ep.from) { const [f, r] = parseSquare(ep.from); const c = squareCenter(f, r); estX = c.x * 1000; estY = c.y * 1000; hasEst = true; }
  else if (ep.atMM) { estX = ep.atMM[0]; estY = ep.atMM[1]; hasEst = true; }
  // Grasp = the LOWEST-Z closing frame (nearest the estimate, if any).
  let gi = -1, gz = Infinity;
  for (let i = 0; i < keys.length; i++) {
    const near = !hasEst || Math.hypot(keys[i].state[0] - estX, keys[i].state[1] - estY) < 130;
    if (g[i] < closeT && near && keys[i].state[2] < gz) { gz = keys[i].state[2]; gi = i; }
  }
  // Release (moves) = first reopen after the grasp near the placement height.
  let ri = -1;
  if (ep.to && gi >= 0) {
    for (let i = gi + 1; i < keys.length; i++) {
      if (g[i] > openT && keys[i].state[2] < gz + 80) { ri = i; break; }
    }
  }
  const tAttach = gi >= 0 ? keys[gi].t : -1;
  const tDetach = ri >= 0 ? keys[ri].t : -1;

  // Place the piece at the ACTUAL recorded grasp point (where the arm grabs it),
  // NOT an estimate — so the gripper closes around it with no snap/glitch.
  piece = createPiece(ep.piece, ep.color);
  piece.rotation.x = Math.PI / 2; // stand up in Z-up frame
  piece.position.set((gi >= 0 ? keys[gi].state[0] : estX) / 1000, (gi >= 0 ? keys[gi].state[1] : estY) / 1000, tableZ);
  scene.add(piece);

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
  attachFrame = tAttach >= 0 ? Math.round(tAttach * OUTPUT_FPS) : -1;
  detachFrame = tDetach >= 0 ? Math.round(tDetach * OUTPUT_FPS) : -1;

  (window as unknown as Record<string, unknown>).REPLAY = {
    totalFrames: solvedAngles.length,
    fps: OUTPUT_FPS,
    renderFrame,
    probe,
    stats: { maxErr_mm: maxErr * 1000, meanErr_mm: (sumErr / nKey) * 1000, keyframes: nKey, attachFrame, detachFrame, task },
  };
  renderFrame(0);
}

// The held piece is NOT rigidly parented; each frame it is placed at the
// fingertips (x,y from the TCP) with its base clamped to the surface, so it can
// never be dragged through the board/floor. graspOffset = grasp-moment TCP
// height above the surface (the height on the piece the fingers grab).
const _tcp = new THREE.Vector3();
let applied = 0; // 0=before grasp, 1=held, 2=released
let graspOffset = 0.045;
function updatePiece(f: number): void {
  if (!piece) return;
  if (applied < 1 && attachFrame >= 0 && f >= attachFrame) {
    robot.getTCP(_tcp);
    graspOffset = _tcp.z - tableZ;
    applied = 1;
  }
  if (applied < 2 && detachFrame >= 0 && ep.to && f >= detachFrame) {
    // Leave the piece exactly where the gripper released it; settle to surface.
    piece.position.z = tableZ;
    piece.rotation.set(Math.PI / 2, 0, 0);
    applied = 2;
  }
  if (applied === 1) {
    robot.getTCP(_tcp);
    piece.position.set(_tcp.x, _tcp.y, Math.max(tableZ, _tcp.z - graspOffset));
    piece.rotation.set(Math.PI / 2, 0, 0);
  }
}

function poseFrame(f: number): void {
  robot.setAnglesDeg(solvedAngles[f]);
  robot.setGripper(grip[f]);
  robot.root.updateMatrixWorld(true);
  updatePiece(f);
}

function renderComposite(): void {
  renderer.setScissorTest(true);
  overhead.aspect = HALF / IMG_H; overhead.updateProjectionMatrix();
  renderer.setViewport(0, 0, HALF, IMG_H); renderer.setScissor(0, 0, HALF, IMG_H);
  renderer.render(scene, overhead);
  wrist.aspect = HALF / IMG_H; wrist.updateProjectionMatrix();
  renderer.setViewport(HALF, 0, HALF, IMG_H); renderer.setScissor(HALF, 0, HALF, IMG_H);
  renderer.render(scene, wrist);
  renderer.setScissorTest(false);

  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(glCanvas, 0, CAP, W, IMG_H, 0, CAP, W, IMG_H);
  ctx.fillStyle = "rgba(255,255,255,0.25)"; ctx.fillRect(HALF - 1, CAP, 2, IMG_H);
  ctx.fillStyle = "rgba(0,0,0,0.62)"; ctx.fillRect(0, 0, W, CAP);
  ctx.font = "600 16px system-ui, sans-serif"; ctx.fillStyle = "#f4f4f4"; ctx.textBaseline = "middle";
  ctx.fillText(task, 8, CAP / 2);
}

function renderFrame(i: number): string {
  poseFrame(Math.max(0, Math.min(solvedAngles.length - 1, i)));
  renderComposite();
  return out.toDataURL("image/png");
}

// Debug probe: pose frame i and report actual world positions (no render).
function probe(i: number): Record<string, unknown> {
  const f = Math.max(0, Math.min(solvedAngles.length - 1, i));
  poseFrame(f);
  robot.getTCP(_tcp);
  const pb = piece ? piece.getWorldPosition(new THREE.Vector3()) : null;
  const fl = robot.gripper.getWorldPosition(new THREE.Vector3());
  return {
    i: f, grip: +grip[f].toFixed(3), applied,
    tcp: [_tcp.x, _tcp.y, _tcp.z].map((v) => +(v * 1000).toFixed(1)),
    piece: pb ? [pb.x, pb.y, pb.z].map((v) => +(v * 1000).toFixed(1)) : null,
    gripper: [fl.x, fl.y, fl.z].map((v) => +(v * 1000).toFixed(1)),
  };
}

load();
