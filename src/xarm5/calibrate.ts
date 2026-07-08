import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Xarm5Robot } from "./robot";
import { buildBoard, squareCenter, boardCenter, BOARD_TOP } from "./board";
import { createPiece } from "../pieces";

// Interactive calibration for the ROS-frame replay scene: orbit the overhead
// camera against the real base image, and tune the wrist-camera mount tilt.
const CW = 640, CH = 480, PIP = 200; // main view + wrist preview size

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
scene.add(buildBoard());

const params = new URLSearchParams(location.search);
const epId = params.get("episode") ?? "v2_001";

// Overhead camera (start from the current replay pose).
const overhead = new THREE.PerspectiveCamera(42, CW / CH, 0.01, 50);
overhead.up.set(0, 0, 1);
overhead.position.set(0.428, -0.1062, 1.0928);
const controls = new OrbitControls(overhead, canvas);
controls.enableDamping = true;
controls.target.set(0.4226, 0.0223, 0.2235);

// Wrist camera attached to the wrist; tilt is the tunable knob.
const wrist = new THREE.PerspectiveCamera(58, 320 / 240, 0.005, 6);
robot.endEffector.add(wrist);
wrist.position.set(0, -0.075, -0.055);
let wristTiltDeg = 24;
function applyWristTilt(): void {
  wrist.rotation.set(Math.PI - (wristTiltDeg * Math.PI) / 180, 0, 0);
}
applyWristTilt();

// Episode data (for posing the arm at a frame).
let frames: { t: number; state: number[] }[] = [];
let queen: THREE.Group | null = null;
const _t = new THREE.Vector3();

async function load(): Promise<void> {
  const text = await (await fetch(`/rollouts/${epId}/frames.jsonl`)).text();
  frames = text.trim().split("\n").map((l) => JSON.parse(l));
  (document.getElementById("fr") as HTMLInputElement).max = String(frames.length - 1);
  const meta = await (await fetch(`/rollouts/${epId}/episode.json`)).json();
  const m = (meta.task as string).match(/from ([a-h][1-8])/);
  if (m) {
    const f = m[1].charCodeAt(0) - 97, r = Number(m[1][1]) - 1;
    queen = createPiece("queen", "white");
    queen.rotation.x = Math.PI / 2;
    const c = squareCenter(f, r);
    queen.position.set(c.x, c.y, BOARD_TOP);
    scene.add(queen);
  }
  poseAt(60);
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

function updateReadout(): void {
  $("fovVal").textContent = `${overhead.fov.toFixed(1)}deg`;
  $("wtVal").textContent = `${wristTiltDeg}deg`;
  $("frVal").textContent = frEl.value;
  const r3 = (v: number) => Number(v.toFixed(4));
  const p = overhead.position, t = controls.target;
  ($("out") as HTMLTextAreaElement).value =
    `overhead.position.set(${r3(p.x)}, ${r3(p.y)}, ${r3(p.z)});\n` +
    `overhead.lookAt(${r3(t.x)}, ${r3(t.y)}, ${r3(t.z)});\n` +
    `fov = ${overhead.fov.toFixed(1)}\n` +
    `wristTilt = ${wristTiltDeg}deg`;
}

function tick(): void {
  controls.update();
  // main overhead view (full canvas)
  renderer.setScissorTest(false);
  overhead.aspect = CW / CH; overhead.updateProjectionMatrix();
  renderer.setViewport(0, 0, CW, CH);
  renderer.render(scene, overhead);
  // wrist preview, bottom-right
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
void boardCenter;
load();
requestAnimationFrame(tick);
