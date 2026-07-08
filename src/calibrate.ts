import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Robot } from "./robot";
import { Chessboard, BoardConfig } from "./chessboard";
import { solveVerticalIK } from "./ik";
import { EPISODES, Episode, parseSquare, OverheadPreset } from "./replication/episodes";

// Starting camera presets (same as export) so calibration begins near current.
const START: Record<OverheadPreset, { pos: [number, number, number]; target: [number, number, number]; fov: number }> = {
  A: { pos: [0.0, 0.42, -0.5], target: [0, 0.02, 0.18], fov: 46 },
  B: { pos: [0.0, 0.62, -0.1], target: [0, 0.02, 0.16], fov: 40 },
  C: { pos: [-0.049, 0.912, 0.486], target: [0, 0.02, 0.17], fov: 43 },
};

const CW = 640;
const CH = 544;
const params = new URLSearchParams(location.search);
const epId = params.get("episode") ?? "v2_001";
const ep: Episode = EPISODES[epId];

const canvas = document.getElementById("cal") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(CW, CH, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const TABLE = 0xcdb488;
scene.background = new THREE.Color(TABLE).multiplyScalar(0.85);
scene.add(new THREE.HemisphereLight(0xffffff, 0xa8a99c, 1.15));
const key = new THREE.DirectionalLight(0xffffff, 0.85);
key.position.set(0.25, 1.7, 0.35);
scene.add(key);
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(6, 6),
  new THREE.MeshStandardMaterial({ color: TABLE, roughness: 0.9 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.0015;
scene.add(ground);

// Robot + board + queen.
const robot = new Robot();
robot.root.position.set(...ep.base);
robot.setWristCameraAngle(0, (90 * Math.PI) / 180);
scene.add(robot.root);

const boardCenter = new THREE.Vector3(0, 0, 0.16);
const cfg: BoardConfig = {
  squareSize: 0.05,
  center: boardCenter.clone(),
  lightColor: 0xe7e2d0,
  darkColor: 0x2f6b43,
  frameColor: 0xd8d1bb,
  labels: true,
  mirrorFiles: ep.mirrorFiles ?? false,
};
const board = new Chessboard(cfg);
board.clearBoard();
board.group.rotation.y = ((ep.boardRotation ?? 0) * Math.PI) / 180;
scene.add(board.group);
if (ep.action.kind === "move") {
  const [f, r] = parseSquare(ep.action.from);
  board.addPiece(ep.action.piece, ep.action.color, f, r);
}

// Park the arm at a board-view pose so it is visible but out of the way.
board.group.updateMatrixWorld(true);
const home = solveVerticalIK(
  robot,
  new THREE.Vector3(boardCenter.x, 0.3, boardCenter.z)
).angles;
robot.setAngles(home);

// Camera + controls.
const cam = new THREE.PerspectiveCamera(START[ep.preset].fov, CW / CH, 0.01, 50);
cam.position.set(...START[ep.preset].pos);
const controls = new OrbitControls(cam, canvas);
controls.target.set(...START[ep.preset].target);
controls.enableDamping = true;

const wristCam = robot.wristCamera;

// --- UI ---------------------------------------------------------------------
const $ = (id: string) => document.getElementById(id)!;
$("epLabel").textContent = `${ep.id} — “${ep.task}”  (preset ${ep.preset})`;

const fovEl = $("fov") as HTMLInputElement;
const rollEl = $("roll") as HTMLInputElement;
const bxEl = $("bx") as HTMLInputElement;
const bzEl = $("bz") as HTMLInputElement;
const outEl = $("out") as HTMLTextAreaElement;
const refImg = $("ref") as HTMLImageElement;
const refOpacity = $("refOpacity") as HTMLInputElement;

fovEl.value = String(START[ep.preset].fov);
bxEl.value = String(ep.base[0]);
bzEl.value = String(ep.base[2]);
let boardRot = ep.boardRotation ?? 0;

refImg.src = `/ref_${ep.id}_overhead.png`;
let refOn = false;
$("refToggle").addEventListener("click", () => {
  refOn = !refOn;
  refImg.style.display = refOn ? "block" : "none";
  (document.getElementById("refToggle") as HTMLButtonElement).classList.toggle("on", refOn);
});
refOpacity.addEventListener("input", () => (refImg.style.opacity = String(Number(refOpacity.value) / 100)));
refImg.style.opacity = "0.45";

fovEl.addEventListener("input", () => {
  cam.fov = Number(fovEl.value);
  cam.updateProjectionMatrix();
});
bxEl.addEventListener("input", () => (robot.root.position.x = Number(bxEl.value)));
bzEl.addEventListener("input", () => (robot.root.position.z = Number(bzEl.value)));
document.querySelectorAll<HTMLButtonElement>("[data-rot]").forEach((b) =>
  b.addEventListener("click", () => {
    boardRot = Number(b.dataset.rot);
    board.group.rotation.y = (boardRot * Math.PI) / 180;
    document.querySelectorAll("[data-rot]").forEach((o) => o.classList.remove("on"));
    b.classList.add("on");
  })
);

function updateReadout(): void {
  const roll = Number(rollEl.value);
  $("fovVal").textContent = `${cam.fov}°`;
  $("rollVal").textContent = `${roll}°`;
  $("bxVal").textContent = robot.root.position.x.toFixed(2);
  $("bzVal").textContent = robot.root.position.z.toFixed(2);
  const r3 = (v: number) => Number(v.toFixed(3));
  const p = cam.position;
  const t = controls.target;
  outEl.value =
    `preset ${ep.preset}: { pos: [${r3(p.x)}, ${r3(p.y)}, ${r3(p.z)}], ` +
    `target: [${r3(t.x)}, ${r3(t.y)}, ${r3(t.z)}], fov: ${cam.fov}, roll: ${roll} }\n` +
    `boardRotation: ${boardRot}\n` +
    `base: [${r3(robot.root.position.x)}, ${ep.base[1]}, ${r3(robot.root.position.z)}]`;
}

// --- Render loop ------------------------------------------------------------
function tick(): void {
  controls.update();
  cam.rotateZ((Number(rollEl.value) * Math.PI) / 180); // apply roll after controls

  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, CW, CH);
  renderer.render(scene, cam);

  // wrist preview (bottom-right corner)
  const pw = 180;
  const ph = Math.round((pw * 272) / 320);
  wristCam.aspect = 320 / 272;
  wristCam.updateProjectionMatrix();
  renderer.setScissorTest(true);
  renderer.setViewport(CW - pw - 6, 6, pw, ph);
  renderer.setScissor(CW - pw - 6, 6, pw, ph);
  renderer.render(scene, wristCam);
  renderer.setScissorTest(false);

  updateReadout();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
