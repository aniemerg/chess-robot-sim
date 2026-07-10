import * as THREE from "three";
import { resolveScenario } from "./scenario";
import { buildScene } from "./scene";
import { plan } from "./motion";
import { sampleHold, duplicateFraction, LoggedFrame } from "./quantize";
import { mulberry32 } from "./rng";
import { pieceSetLicense } from "./piece_models";

/**
 * Synthetic episode entry point (loaded by synth.html). Resolves a scenario +
 * seed, plans the true trajectory, builds the randomized scene, solves IK per
 * TRUE frame (image = true pose), quantizes the logged `state` (sample-held),
 * and exposes window.SYNTH for the headless writer (tools/render-synth.mjs).
 *
 * Renders base + wrist to separate 320x240 JPEGs — the recorder's on-disk form.
 */

const IMG_W = 320, IMG_H = 240;
const JPEG_QUALITY = 0.9;

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "queen_move";
const seed = Number(params.get("seed") ?? "1");
const index = Number(params.get("index") ?? "0");

const ep = resolveScenario(scenario, seed);

// Optional piece-set override (testing / targeted generation), e.g. &set=polyhaven_chess_set
const setOverride = params.get("set");
if (setOverride) {
  ep.spec.piece.model = setOverride;
  const p0 = (ep.manifest.pieces as Array<Record<string, unknown>>)[0];
  p0.model = setOverride;
  p0.license = pieceSetLicense(setOverride);
}

// --- Renderer (single 320x240 target, one camera at a time) -----------------
const canvas = (document.getElementById("out") as HTMLCanvasElement) ?? document.createElement("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(IMG_W, IMG_H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const built = await buildScene(ep.spec, mulberry32(seed ^ 0x9e3779b9));
const { scene, robot, overhead, wrist, piece, tableZ } = built;

// --- Plan motion + solve IK per true frame ----------------------------------
const planned = plan(ep.primitive, ep.motion, mulberry32(seed ^ 0x1234));
const _t = new THREE.Vector3();
const solvedAngles: number[][] = [];
const grip: number[] = [];
let maxErr = 0, sumErr = 0;
for (const f of planned.frames) {
  _t.set(f.x / 1000, f.y / 1000, f.z / 1000);
  const r = robot.solveIK(_t, { tolerance: 0.004, maxIterations: 100 });
  robot.setAnglesDeg(r.angles);
  solvedAngles.push(r.angles.slice());
  grip.push(f.grip);
  const e = robot.getTCP(_t.clone()).distanceTo(new THREE.Vector3(f.x / 1000, f.y / 1000, f.z / 1000));
  maxErr = Math.max(maxErr, e); sumErr += e;
}

// Logged (sample-held) state stream. yaw stored in state comes from the true
// pose too, so its hold pattern matches x/y/z.
const logged: LoggedFrame[] = sampleHold(planned.frames, 4.5, mulberry32(seed ^ 0x55aa));

// --- Held piece (not rigidly parented; follows fingertips, clamped to surface) ---
const attachFrame = planned.graspFrame;
const detachFrame = planned.releaseFrame; // -1 for pickup
const isMove = ep.primitive.kind === "move";
const _tcp = new THREE.Vector3();
let applied = 0;
let graspOffset = 0.045;
function updatePiece(f: number): void {
  if (applied < 1 && attachFrame >= 0 && f >= attachFrame) {
    robot.getTCP(_tcp);
    graspOffset = _tcp.z - tableZ;
    applied = 1;
  }
  if (applied < 2 && detachFrame >= 0 && isMove && f >= detachFrame) {
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

// Piece follow is stateful (applied advances monotonically) — reset if a frame
// is posed out of order (the writer renders 0..N in order, so this is cheap).
let lastPosed = -1;
function poseFrame(f: number): void {
  if (f < lastPosed) { applied = 0; piece.position.set(ep.spec.pieceStartMM[0] / 1000, ep.spec.pieceStartMM[1] / 1000, tableZ); piece.rotation.set(Math.PI / 2, 0, 0); }
  robot.setAnglesDeg(solvedAngles[f]);
  robot.setGripper(grip[f]);
  robot.root.updateMatrixWorld(true);
  for (let k = Math.max(0, lastPosed + 1); k <= f; k++) updatePiece(k); // advance follow state
  lastPosed = f;
}

function renderWith(cam: THREE.PerspectiveCamera): string {
  cam.aspect = IMG_W / IMG_H;
  cam.updateProjectionMatrix();
  renderer.setViewport(0, 0, IMG_W, IMG_H);
  renderer.render(scene, cam);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}
const renderBase = (f: number): string => { poseFrame(clampF(f)); return renderWith(overhead); };
const renderWrist = (f: number): string => { poseFrame(clampF(f)); return renderWith(wrist); };
const clampF = (f: number) => Math.max(0, Math.min(solvedAngles.length - 1, f));

const duration = planned.duration;
const episodeJson = {
  index,
  task: ep.task,
  num_frames: logged.length,
  success: true,
  duration_s: +duration.toFixed(3),
};

(window as unknown as Record<string, unknown>).SYNTH = {
  ready: true,
  numFrames: logged.length,
  scenario,
  seed,
  episode: episodeJson,
  frames: logged,
  manifest: ep.manifest,
  stats: {
    maxErr_mm: +(maxErr * 1000).toFixed(2),
    meanErr_mm: +((sumErr / planned.frames.length) * 1000).toFixed(2),
    dupFraction: +duplicateFraction(logged).toFixed(3),
    graspFrame: attachFrame,
    releaseFrame: detachFrame,
    duration_s: +duration.toFixed(3),
  },
  renderBase,
  renderWrist,
};

// Prime the first frame so a viewer shows something immediately.
renderBase(0);
