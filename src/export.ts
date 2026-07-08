import * as THREE from "three";
import { Robot } from "./robot";
import { Chessboard, BoardConfig } from "./chessboard";
import { solveVerticalIK } from "./ik";
import { pieceHeight, PieceType } from "./pieces";
import { EPISODES, Episode, parseSquare, OverheadPreset } from "./replication/episodes";

// --- Output geometry (matches the source clips) -----------------------------
const W = 640;
const H = 272;
const HALF = 320;
const FPS = 15;

// --- Tunables ---------------------------------------------------------------
// Overhead camera per setup: eye/target in world meters, vertical FOV, and a
// roll (deg) to match the board's rotation in frame.
interface CamPreset {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
  roll: number; // degrees
}
const OVERHEAD: Record<OverheadPreset, CamPreset> = {
  A: { pos: [0.0, 0.42, -0.5], target: [0, 0.02, 0.18], fov: 46, roll: 0 },
  B: { pos: [0.0, 0.62, -0.1], target: [0, 0.02, 0.16], fov: 40, roll: 0 },
  C: { pos: [-0.049, 0.912, 0.486], target: [0, 0.02, 0.17], fov: 43, roll: 6 },
};

// Wrist camera for replication: straight down the tool (angle 0), no egocentric
// roll; ROLL orients the board in the wrist image.
const WRIST_ANGLE_DEG = 0;
const WRIST_ROLL_DEG = 180; // orient the wrist view so a1 is bottom-left (matches source)
const WRIST_FOV = 52; // narrower than the app's egocentric cam, to frame the board

const HOME_HEIGHT = 0.4; // arm hover height over board center for the framing pose
const HOVER = 0.06; // approach height above a square
const TABLE_COLOR = 0xcdb488;

// --- Scene ------------------------------------------------------------------
const glCanvas = document.getElementById("gl") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({
  canvas: glCanvas,
  antialias: true,
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const outCanvas = document.getElementById("out") as HTMLCanvasElement;
outCanvas.width = W;
outCanvas.height = H;
const ctx = outCanvas.getContext("2d")!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(TABLE_COLOR).multiplyScalar(0.85);

scene.add(new THREE.HemisphereLight(0xffffff, 0xa8a99c, 1.15));
const key = new THREE.DirectionalLight(0xffffff, 0.85);
key.position.set(0.25, 1.7, 0.35);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 0.1;
key.shadow.camera.far = 5;
for (const s of ["left", "right", "top", "bottom"] as const)
  (key.shadow.camera as unknown as Record<string, number>)[s] = s === "left" || s === "bottom" ? -1 : 1;
key.shadow.bias = -0.0004;
key.shadow.radius = 3;
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.3);
fill.position.set(-0.6, 0.8, -0.4);
scene.add(fill);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(6, 6),
  new THREE.MeshStandardMaterial({ color: TABLE_COLOR, roughness: 0.9 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.0015;
ground.receiveShadow = true;
scene.add(ground);

// --- Episode ----------------------------------------------------------------
const params = new URLSearchParams(location.search);
const ep: Episode = EPISODES[params.get("episode") ?? "v2_001"];

const robot = new Robot();
robot.root.position.set(...ep.base);
robot.setWristCameraAngle((WRIST_ANGLE_DEG * Math.PI) / 180, (WRIST_ROLL_DEG * Math.PI) / 180);
scene.add(robot.root);

let board: Chessboard | null = null;
let piece: THREE.Group | null = null;
const boardCenter = new THREE.Vector3(0, 0, 0.16);
if (ep.board) {
  const cfg: BoardConfig = {
    squareSize: 0.05,
    center: boardCenter.clone(),
    lightColor: 0xe7e2d0,
    darkColor: 0x2f6b43,
    frameColor: 0xd8d1bb,
    labels: true,
    mirrorFiles: ep.mirrorFiles ?? false,
  };
  board = new Chessboard(cfg);
  board.clearBoard();
  board.group.rotation.y = ((ep.boardRotation ?? 0) * Math.PI) / 180;
  board.group.updateMatrixWorld(true);
  scene.add(board.group);
}

// Overhead camera.
const overhead = new THREE.PerspectiveCamera(OVERHEAD[ep.preset].fov, HALF / H, 0.01, 50);
{
  const p = OVERHEAD[ep.preset];
  overhead.position.set(...p.pos);
  overhead.up.set(0, 1, 0);
  overhead.lookAt(new THREE.Vector3(...p.target));
  overhead.rotateZ((p.roll * Math.PI) / 180);
}
const wroll = Number(params.get("wroll") ?? WRIST_ROLL_DEG);
robot.setWristCameraAngle((WRIST_ANGLE_DEG * Math.PI) / 180, (wroll * Math.PI) / 180);
const wristCam = robot.wristCamera;
wristCam.fov = WRIST_FOV;
wristCam.updateProjectionMatrix();

// --- Kinematic helpers ------------------------------------------------------
const _v = new THREE.Vector3();
function squareTarget(sq: string, extra: number): THREE.Vector3 {
  const [f, r] = parseSquare(sq);
  board!.worldSquareCenter(f, r, _v);
  return new THREE.Vector3(_v.x, _v.y + extra, _v.z);
}
function ik(target: THREE.Vector3): number[] {
  return solveVerticalIK(robot, target).angles;
}
const graspExtra = (pc: PieceType) => pieceHeight(pc) * 0.6;

// Poses.
const HOME = ik(new THREE.Vector3(boardCenter.x, HOME_HEIGHT, boardCenter.z));

// --- Timeline (deterministic per-frame state) -------------------------------
type Step =
  | { kind: "hold"; frames: number }
  | { kind: "arm"; frames: number; to: number[] }
  | { kind: "grip"; frames: number; to: number }
  | { kind: "attach" }
  | { kind: "detach"; sq: string };

function buildSteps(): Step[] {
  if (ep.action.kind === "move" && board) {
    const a = ep.action;
    const aboveFrom = ik(squareTarget(a.from, HOVER));
    const graspFrom = ik(squareTarget(a.from, graspExtra(a.piece)));
    const aboveTo = ik(squareTarget(a.to, HOVER));
    const graspTo = ik(squareTarget(a.to, graspExtra(a.piece)));
    return [
      { kind: "hold", frames: 8 },
      { kind: "arm", frames: 14, to: aboveFrom },
      { kind: "arm", frames: 10, to: graspFrom },
      { kind: "grip", frames: 4, to: 0 },
      { kind: "attach" },
      { kind: "arm", frames: 10, to: aboveFrom },
      { kind: "arm", frames: 18, to: aboveTo },
      { kind: "arm", frames: 10, to: graspTo },
      { kind: "grip", frames: 4, to: 1 },
      { kind: "detach", sq: a.to },
      { kind: "arm", frames: 10, to: aboveTo },
      { kind: "arm", frames: 14, to: HOME },
      { kind: "hold", frames: 10 },
    ];
  }
  // Pick task (board or bare table).
  const a = ep.action as { kind: "pick"; piece: PieceType; at: string };
  const above = ik(squareTarget(a.at, HOVER));
  const grasp = ik(squareTarget(a.at, graspExtra(a.piece)));
  return [
    { kind: "hold", frames: 8 },
    { kind: "arm", frames: 16, to: above },
    { kind: "arm", frames: 10, to: grasp },
    { kind: "grip", frames: 4, to: 0 },
    { kind: "attach" },
    { kind: "arm", frames: 14, to: above },
    { kind: "hold", frames: 12 },
  ];
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerpA = (a: number[], b: number[], e: number) => a.map((v, i) => v + (b[i] - v) * e);

// Expand steps into a per-frame timeline plus ordered scene-graph events.
interface FrameState { angles: number[]; grip: number; }
const timeline: FrameState[] = [];
const events: { frame: number; type: "attach" | "detach"; sq?: string }[] = [];
{
  let pose = HOME.slice();
  let grip = 1;
  robot.setAngles(pose);
  robot.setGripper(grip);
  // place the piece on its start square
  if (ep.action.kind === "move" && board) {
    const [f, r] = parseSquare(ep.action.from);
    piece = board.addPiece(ep.action.piece, ep.action.color, f, r);
  } else if (board && ep.action.kind === "pick") {
    const [f, r] = parseSquare(ep.action.at);
    piece = board.addPiece(ep.action.piece, ep.action.color, f, r);
  }

  for (const step of buildSteps()) {
    if (step.kind === "attach") {
      events.push({ frame: timeline.length, type: "attach" });
      continue;
    }
    if (step.kind === "detach") {
      events.push({ frame: timeline.length, type: "detach", sq: step.sq });
      continue;
    }
    const armTo = step.kind === "arm" ? step.to : pose;
    const gripTo = step.kind === "grip" ? step.to : grip;
    for (let k = 0; k < step.frames; k++) {
      const e = easeInOut((k + 1) / step.frames);
      timeline.push({ angles: lerpA(pose, armTo, e), grip: grip + (gripTo - grip) * e });
    }
    pose = armTo;
    grip = gripTo;
  }
}
const totalFrames = timeline.length;

// --- Rendering --------------------------------------------------------------
let applied = 0; // index into events already applied (monotonic playback)
function applyEventsUpTo(frame: number): void {
  while (applied < events.length && events[applied].frame <= frame) {
    const ev = events[applied++];
    if (!piece) continue;
    if (ev.type === "attach") robot.gripper.attach(piece);
    else if (ev.type === "detach" && ev.sq && board) {
      const [f, r] = parseSquare(ev.sq);
      board.placePieceOnSquare(piece, f, r);
    }
  }
}

function drawCaption(text: string): void {
  ctx.fillStyle = "rgba(0,0,0,0.42)";
  ctx.fillRect(0, 0, W, 24);
  ctx.font = "600 15px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillStyle = "#f4f4f4";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 8, 13);
}

function renderComposite(): void {
  renderer.setScissorTest(true);
  // overhead (left)
  renderer.setViewport(0, 0, HALF, H);
  renderer.setScissor(0, 0, HALF, H);
  renderer.render(scene, overhead);
  // wrist (right)
  wristCam.aspect = HALF / H;
  wristCam.updateProjectionMatrix();
  renderer.setViewport(HALF, 0, HALF, H);
  renderer.setScissor(HALF, 0, HALF, H);
  renderer.render(scene, wristCam);
  renderer.setScissorTest(false);

  ctx.clearRect(0, 0, W, H);
  ctx.drawImage(glCanvas, 0, 0);
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillRect(HALF - 1, 0, 2, H); // subtle divider
  drawCaption(ep.task);
}

function renderFrame(i: number): string {
  const f = Math.max(0, Math.min(totalFrames - 1, i));
  applyEventsUpTo(f);
  robot.setAngles(timeline[f].angles);
  robot.setGripper(timeline[f].grip);
  robot.root.updateMatrixWorld(true);
  renderComposite();
  return outCanvas.toDataURL("image/png");
}

// Expose for the headless driver.
(window as unknown as Record<string, unknown>).EXPORT = {
  fps: FPS,
  totalFrames,
  width: W,
  height: H,
  renderFrame,
};

// Render one frame immediately (for quick visual tuning: ?frame=N).
renderFrame(Number(params.get("frame") ?? 0));
