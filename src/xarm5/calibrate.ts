import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Xarm5Robot } from "./robot";
import { buildBoard, squareCenter, BOARD_TOP } from "./board";
import { createPiece, PieceType, PieceColor } from "../pieces";

// Interactive calibration for the ROS-frame replay scene: orbit the overhead
// camera against the real base image, tune the wrist-camera tilt, and (for
// board scenes) nudge the board pose. Config-driven per episode.
interface EpCfg {
  board: boolean;
  piece: PieceType;
  color: PieceColor;
  from?: string; // move: start square (piece placed here)
  atMM?: [number, number]; // pick: piece world (x,y) mm on the table/board
}
const CFG: Record<string, EpCfg> = {
  v2_001: { board: true, piece: "queen", color: "white", from: "e7" },
  v2_135: { board: true, piece: "queen", color: "white", from: "c4" },
  v2_267: { board: true, piece: "queen", color: "white", from: "h3" },
  v2_399: { board: true, piece: "queen", color: "white", from: "c1" },
  all_011: { board: false, piece: "queen", color: "black", atMM: [245, 182] },
  all_016: { board: false, piece: "king", color: "white", atMM: [250, -250] },
  all_036: { board: true, piece: "bishop", color: "white", atMM: [180, -178] },
  all_045: { board: true, piece: "queen", color: "white", from: "d1" },
};

const CW = 640, CH = 480, PIP = 200;
const params = new URLSearchParams(location.search);
const epId = params.get("episode") ?? "all_045";
const cfg = CFG[epId];

const canvas = document.getElementById("cal") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(CW, CH, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const TABLE = 0xcdb488;
scene.background = new THREE.Color(TABLE).multiplyScalar(0.85);
scene.add(new THREE.HemisphereLight(0xffffff, 0xa8a99c, 1.15));
const key = new THREE.DirectionalLight(0xffffff, 0.9);
key.position.set(0.4, -0.3, 1.6);
scene.add(key);
scene.add(new THREE.DirectionalLight(0xffffff, 0.3));
const desk = new THREE.Mesh(new THREE.PlaneGeometry(4, 4), new THREE.MeshStandardMaterial({ color: TABLE, roughness: 0.9 }));
desk.position.z = -0.004;
scene.add(desk);

const robot = new Xarm5Robot();
robot.toolYawTarget = -Math.PI / 2;
scene.add(robot.root);

let boardGrp: THREE.Group | null = null;
if (cfg.board) {
  boardGrp = buildBoard();
  scene.add(boardGrp);
}
const tableZ = cfg.board ? BOARD_TOP : 0;

const overhead = new THREE.PerspectiveCamera(44, CW / CH, 0.01, 50);
overhead.up.set(0, 0, 1);
overhead.position.set(0.4667, 0.4617, 0.9797);
const controls = new OrbitControls(overhead, canvas);
controls.enableDamping = true;
controls.target.set(0.4226, 0.0223, 0.2235);

const wrist = new THREE.PerspectiveCamera(58, 320 / 240, 0.005, 6);
robot.endEffector.add(wrist);
wrist.position.set(0, -0.075, -0.055);
let wristTiltDeg = 2;
const applyWristTilt = () => wrist.rotation.set(Math.PI - (wristTiltDeg * Math.PI) / 180, 0, 0);
applyWristTilt();

let frames: { t: number; state: number[] }[] = [];
let piece: THREE.Group | null = null;
const _t = new THREE.Vector3();

async function load(): Promise<void> {
  const text = await (await fetch(`/rollouts/${epId}/frames.jsonl`)).text();
  frames = text.trim().split("\n").map((l) => JSON.parse(l));
  (document.getElementById("fr") as HTMLInputElement).max = String(frames.length - 1);

  piece = createPiece(cfg.piece, cfg.color);
  piece.rotation.x = Math.PI / 2; // stand up in Z-up frame
  if (cfg.from) {
    const f = cfg.from.charCodeAt(0) - 97, r = Number(cfg.from[1]) - 1;
    const c = squareCenter(f, r);
    piece.position.set(c.x, c.y, tableZ);
  } else if (cfg.atMM) {
    piece.position.set(cfg.atMM[0] / 1000, cfg.atMM[1] / 1000, tableZ);
  }
  scene.add(piece);
  poseAt(Math.floor(frames.length * 0.55));
}

function poseAt(i: number): void {
  const s = frames[Math.max(0, Math.min(frames.length - 1, i))].state;
  _t.set(s[0] / 1000, s[1] / 1000, s[2] / 1000);
  const r = robot.solveIK(_t, { tolerance: 0.004, maxIterations: 120 });
  robot.setAnglesDeg(r.angles);
  robot.setGripper(s[4]);
  robot.root.updateMatrixWorld(true);
}

// --- UI ---------------------------------------------------------------------
const $ = (id: string) => document.getElementById(id)!;
const refImg = $("ref") as HTMLImageElement;
refImg.src = `/rollouts/${epId}/base_ref.png`;
refImg.style.opacity = "0.5";
let refOn = false;
$("refToggle").addEventListener("click", () => {
  refOn = !refOn;
  refImg.style.display = refOn ? "block" : "none";
  ($("refToggle") as HTMLButtonElement).classList.toggle("on", refOn);
});
($("refOpacity") as HTMLInputElement).addEventListener("input", (e) => {
  refImg.style.opacity = String(Number((e.target as HTMLInputElement).value) / 100);
});
const fovEl = $("fov") as HTMLInputElement;
fovEl.value = String(overhead.fov);
fovEl.addEventListener("input", () => { overhead.fov = Number(fovEl.value); overhead.updateProjectionMatrix(); });
const wtEl = $("wt") as HTMLInputElement;
wtEl.value = String(wristTiltDeg);
wtEl.addEventListener("input", () => { wristTiltDeg = Number(wtEl.value); applyWristTilt(); });
const frEl = $("fr") as HTMLInputElement;
frEl.addEventListener("input", () => poseAt(Number(frEl.value)));

// Board offset controls (only meaningful when a board is present).
const bx = $("bx") as HTMLInputElement, by = $("by") as HTMLInputElement, byaw = $("byaw") as HTMLInputElement;
if (!cfg.board) ($("boardCtl") as HTMLDivElement).style.display = "none";
function applyBoardOffset(): void {
  if (!boardGrp) return;
  boardGrp.position.set(Number(bx.value), Number(by.value), 0);
  boardGrp.rotation.z = (Number(byaw.value) * Math.PI) / 180;
}
[bx, by, byaw].forEach((el) => el.addEventListener("input", applyBoardOffset));

function updateReadout(): void {
  $("fovVal").textContent = `${overhead.fov.toFixed(1)}deg`;
  $("wtVal").textContent = `${wristTiltDeg}deg`;
  $("frVal").textContent = frEl.value;
  $("bxVal").textContent = bx.value;
  $("byVal").textContent = by.value;
  $("byawVal").textContent = `${byaw.value}deg`;
  const r3 = (v: number) => Number(v.toFixed(4));
  const p = overhead.position, t = controls.target;
  let s =
    `episode ${epId}\n` +
    `overhead.position.set(${r3(p.x)}, ${r3(p.y)}, ${r3(p.z)});\n` +
    `overhead.lookAt(${r3(t.x)}, ${r3(t.y)}, ${r3(t.z)});\n` +
    `fov = ${overhead.fov.toFixed(1)}\nwristTilt = ${wristTiltDeg}deg`;
  if (cfg.board) s += `\nboardOffset = { x:${bx.value}, y:${by.value}, yaw:${byaw.value} }`;
  ($("out") as HTMLTextAreaElement).value = s;
}

function tick(): void {
  controls.update();
  renderer.setScissorTest(false);
  overhead.aspect = CW / CH; overhead.updateProjectionMatrix();
  renderer.setViewport(0, 0, CW, CH);
  renderer.render(scene, overhead);
  const ph = Math.round((PIP * 240) / 320);
  wrist.aspect = 320 / 240; wrist.updateProjectionMatrix();
  renderer.setScissorTest(true);
  renderer.setViewport(CW - PIP - 6, 6, PIP, ph);
  renderer.setScissor(CW - PIP - 6, 6, PIP, ph);
  renderer.render(scene, wrist);
  renderer.setScissorTest(false);
  updateReadout();
  requestAnimationFrame(tick);
}
load();
requestAnimationFrame(tick);
