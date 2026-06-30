import * as THREE from "three";
import { createScene } from "./scene";
import { Robot, JOINT_SPECS, REST_POSE } from "./robot";
import { solveVerticalIK } from "./ik";
import { Chessboard, BOARD_CONFIG, Pick } from "./chessboard";
import { pieceHeight, PieceType, PieceColor } from "./pieces";
import { UI } from "./ui";

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const { scene, camera, renderer, controls } = createScene(canvas);
controls.target.set(0, 0.08, 0.16);

// --- Robot ------------------------------------------------------------------
const robot = new Robot();
robot.root.position.set(0, 0, -0.12); // base sits just behind the board
scene.add(robot.root);

// --- Chessboard -------------------------------------------------------------
const board = new Chessboard(BOARD_CONFIG);
scene.add(board.group);

// --- Target marker ----------------------------------------------------------
const marker = new THREE.Group();
const ring = new THREE.Mesh(
  new THREE.TorusGeometry(0.022, 0.004, 12, 32),
  new THREE.MeshBasicMaterial({ color: 0xff4d6d })
);
ring.rotation.x = Math.PI / 2;
marker.add(ring);
scene.add(marker);

// --- UI ---------------------------------------------------------------------
const ui = new UI();
const eePos = new THREE.Vector3();
function refreshReadout(): void {
  robot.getEndEffectorPosition(eePos);
  ui.setEndEffector(eePos);
}

ui.build(JOINT_SPECS, REST_POSE, {
  onJointChange: (index, radians) => {
    cancelSequence();
    robot.setAngle(index, radians);
    refreshReadout();
    ui.setSolverStatus("Manual joint control", "idle");
  },
  onMove: (target) => {
    marker.position.copy(target);
    const r = solveVerticalIK(robot, target);
    reportSolve(r, target);
    runSequence([{ arm: r.angles }]);
  },
  onReset: () => {
    cancelSequence();
    held = null;
    ui.setSolverStatus("Reset pose", "idle");
    runSequence([{ grip: 1 }, { arm: REST_POSE.slice() }]);
  },
});

marker.position.copy(ui.getTarget());
refreshReadout();

function reportSolve(r: ReturnType<typeof solveVerticalIK>, _t: THREE.Vector3): void {
  const errMm = (r.error * 1000).toFixed(1);
  if (r.success) {
    ui.setSolverStatus(`Reached · gripper vertical · err ${errMm} mm`, "ok");
  } else if (!r.reachable) {
    ui.setSolverStatus(`Unreachable · nearest pose · err ${errMm} mm`, "fail");
  } else {
    ui.setSolverStatus(`Joint-limited · nearest pose · err ${errMm} mm`, "warn");
  }
}

// --- Pick & place sequencing ------------------------------------------------
type Step =
  | { arm: number[] }
  | { grip: number; attach?: THREE.Group; detach?: { file: number; rank: number; piece: THREE.Group } };

let queue: Step[] = [];
let held: THREE.Group | null = null;

// Active interpolations.
let armAnim: { start: number[]; end: number[]; t0: number; dur: number } | null = null;
let gripAnim: { start: number; end: number; t0: number; dur: number } | null = null;
let waiting: "arm" | "grip" | null = null;
let clockMs = 0;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function runSequence(steps: Step[]): void {
  cancelSequence();
  queue = steps;
  startNextStep();
}

function cancelSequence(): void {
  queue = [];
  armAnim = null;
  gripAnim = null;
  waiting = null;
}

function startNextStep(): void {
  const step = queue.shift();
  if (!step) {
    waiting = null;
    return;
  }
  if ("arm" in step) {
    armAnim = { start: robot.getAngles(), end: step.arm, t0: clockMs, dur: 750 };
    waiting = "arm";
  } else {
    if (step.attach) robot.gripper.attach(step.attach);
    if (step.detach) {
      board.placePieceOnSquare(step.detach.piece, step.detach.file, step.detach.rank);
      board.group.attach(step.detach.piece); // ensure in board after attach
    }
    gripAnim = { start: robot.getGripper(), end: step.grip, t0: clockMs, dur: 300 };
    waiting = "grip";
  }
}

// Build a pick sequence: approach above, open, descend, close+grab, lift.
function planPick(pick: Extract<Pick, { kind: "piece" }>): void {
  const grasp = board.graspPointForPiece(pick.group);
  const above = grasp.clone();
  above.y += 0.07;
  const sGrasp = solveVerticalIK(robot, grasp);
  const sAbove = solveVerticalIK(robot, above);
  marker.position.copy(grasp);
  if (!sGrasp.success || !sAbove.success) {
    reportSolve(sGrasp.success ? sAbove : sGrasp, grasp);
    return;
  }
  ui.setSolverStatus(`Picking up ${pick.color} ${pick.type}`, "ok");
  held = pick.group;
  runSequence([
    { arm: sAbove.angles },
    { grip: 1 },
    { arm: sGrasp.angles },
    { grip: 0, attach: pick.group },
    { arm: sAbove.angles },
  ]);
}

// Build a place sequence: approach above, descend, open+release, lift.
function planPlace(file: number, rank: number): void {
  if (!held) return;
  const piece = held;
  const center = board.worldSquareCenter(file, rank);
  const grasp = center.clone();
  grasp.y += pieceHeight(piece.userData.type) * 0.6;
  const above = grasp.clone();
  above.y += 0.07;
  const sGrasp = solveVerticalIK(robot, grasp);
  const sAbove = solveVerticalIK(robot, above);
  marker.position.copy(center);
  if (!sGrasp.success || !sAbove.success) {
    reportSolve(sGrasp.success ? sAbove : sGrasp, grasp);
    return;
  }
  ui.setSolverStatus(`Placing on ${"abcdefgh"[file]}${rank + 1}`, "ok");
  held = null;
  runSequence([
    { arm: sAbove.angles },
    { arm: sGrasp.angles },
    { grip: 1, detach: { file, rank, piece } },
    { arm: sAbove.angles },
  ]);
}

// --- Raycasting / clickable targets ----------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let downPos = { x: 0, y: 0 };

canvas.addEventListener("pointerdown", (e) => (downPos = { x: e.clientX, y: e.clientY }));

canvas.addEventListener("pointerup", (e) => {
  if (Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) return; // a drag

  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects(board.pickables, true);
  if (hits.length === 0) return;
  const pick = board.resolvePick(hits[0].object);
  if (!pick) return;

  if (editMode) {
    handleEditClick(pick);
    return;
  }
  if (waiting) return; // ignore clicks mid-motion

  if (held) {
    // Place on the clicked square (or the square under a clicked piece).
    const file = pick.kind === "square" ? pick.file : (pick.group.userData.file as number);
    const rank = pick.kind === "square" ? pick.rank : (pick.group.userData.rank as number);
    planPlace(file, rank);
  } else if (pick.kind === "piece") {
    planPick(pick);
  } else {
    // Empty square: just send the gripper there (vertical), no grab.
    const target = board.worldSquareCenter(pick.file, pick.rank);
    target.y += 0.02;
    marker.position.copy(target);
    const r = solveVerticalIK(robot, target);
    reportSolve(r, target);
    ui.setTarget(target);
    runSequence([{ arm: r.angles }]);
  }
});

// --- Board editor -----------------------------------------------------------
type Tool = "move" | "erase" | PieceType;
let editMode = false;
let tool: Tool = "move";
let brushColor: PieceColor = "white";
let selected: THREE.Group | null = null;

// Pose that parks the arm upright and off to the side, clearing the board.
const PARK_POSE = [Math.PI / 2, (-80 * Math.PI) / 180, (-30 * Math.PI) / 180, 0, 0];

// Selection highlight ring.
const selRing = new THREE.Mesh(
  new THREE.TorusGeometry(0.022, 0.0035, 12, 32),
  new THREE.MeshBasicMaterial({ color: 0x57e08a })
);
selRing.rotation.x = Math.PI / 2;
selRing.visible = false;
scene.add(selRing);

const editorEl = document.getElementById("editor") as HTMLDivElement;
const editHint = document.getElementById("editHint") as HTMLParagraphElement;
const removeSelBtn = document.getElementById("removeSel") as HTMLButtonElement;
const colorBtn = document.getElementById("colorToggle") as HTMLButtonElement;

function setSelected(piece: THREE.Group | null): void {
  selected = piece;
  removeSelBtn.disabled = !piece;
  if (piece) {
    board.worldSquareCenter(piece.userData.file, piece.userData.rank, selRing.position);
    selRing.position.y = board.group.position.y + board.surfaceLocalY + 0.004;
    selRing.visible = true;
  } else {
    selRing.visible = false;
  }
}

function handleEditClick(pick: Pick): void {
  if (tool === "move") {
    if (pick.kind === "piece") {
      setSelected(pick.group);
    } else if (selected) {
      board.movePiece(selected, pick.file, pick.rank);
      setSelected(selected); // refresh ring at new square
    }
  } else if (tool === "erase") {
    if (pick.kind === "piece") {
      if (pick.group === selected) setSelected(null);
      board.removePiece(pick.group);
    }
  } else {
    // A piece-type brush: add/replace at the target square.
    const file = pick.kind === "square" ? pick.file : (pick.group.userData.file as number);
    const rank = pick.kind === "square" ? pick.rank : (pick.group.userData.rank as number);
    setSelected(board.addPiece(tool, brushColor, file, rank));
  }
}

function setEditMode(on: boolean): void {
  editMode = on;
  editorEl.hidden = !on;
  const btn = document.getElementById("editToggle") as HTMLButtonElement;
  btn.textContent = `Edit board: ${on ? "On" : "Off"}`;
  btn.classList.toggle("on", on);
  marker.visible = !on;
  if (on) {
    cancelSequence();
    held = null;
    runSequence([{ grip: 1 }, { arm: PARK_POSE }]); // park the arm out of the way
    ui.setSolverStatus("Board edit mode — robot parked", "idle");
  } else {
    setSelected(null);
    runSequence([{ arm: REST_POSE.slice() }]);
    ui.setSolverStatus("Idle", "idle");
  }
}

document.getElementById("editToggle")!.addEventListener("click", () => setEditMode(!editMode));

document.querySelectorAll<HTMLButtonElement>(".tool").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tool").forEach((o) => o.classList.remove("active"));
    b.classList.add("active");
    tool = b.dataset.tool as Tool;
    if (tool !== "move") setSelected(null);
    editHint.textContent =
      tool === "move"
        ? "Click a piece to select, then click a square to move it."
        : tool === "erase"
        ? "Click a piece to remove it."
        : `Click a square to add a ${brushColor} ${tool}.`;
  });
});

colorBtn.addEventListener("click", () => {
  brushColor = brushColor === "white" ? "black" : "white";
  colorBtn.textContent = `Color: ${brushColor === "white" ? "White" : "Black"}`;
  colorBtn.classList.toggle("black", brushColor === "black");
  if (tool !== "move" && tool !== "erase") {
    editHint.textContent = `Click a square to add a ${brushColor} ${tool}.`;
  }
  if (selected) setSelected(board.recolorPiece(selected, brushColor)); // recolor in place
});

removeSelBtn.addEventListener("click", () => {
  if (selected) {
    board.removePiece(selected);
    setSelected(null);
  }
});

document.getElementById("setBoard")!.addEventListener("click", () => {
  board.resetToStart();
  setSelected(null);
});
document.getElementById("clearBoard")!.addEventListener("click", () => {
  board.clearBoard();
  setSelected(null);
});

// --- Wrist-camera picture-in-picture ---------------------------------------
const wristCam = robot.wristCamera;
const pipEl = document.getElementById("pip") as HTMLDivElement;
let pipRect = { x: 0, y: 0, w: 0, h: 0 }; // CSS pixels, WebGL (bottom-left) origin

function updatePipRect(): void {
  const cr = canvas.getBoundingClientRect();
  const pr = pipEl.getBoundingClientRect();
  pipRect = {
    x: pr.left - cr.left,
    y: cr.height - (pr.top - cr.top + pr.height), // flip to bottom-left origin
    w: pr.width,
    h: pr.height,
  };
  if (pr.height > 0) {
    wristCam.aspect = pr.width / pr.height;
    wristCam.updateProjectionMatrix();
  }
}
window.addEventListener("resize", updatePipRect);
updatePipRect();

// Wrist-camera focal length (zoom). setFocalLength derives the FOV from the
// camera's 35mm film gauge, so the slider reads in millimeters.
const focalEl = document.getElementById("focal") as HTMLInputElement;
const focalVal = document.getElementById("focalVal") as HTMLSpanElement;
function applyFocal(mm: number): void {
  wristCam.setFocalLength(mm);
  wristCam.updateProjectionMatrix();
  focalVal.textContent = `${mm} mm`;
}
focalEl.addEventListener("input", () => applyFocal(Number(focalEl.value)));
applyFocal(Number(focalEl.value));

// --- Wrist-cam recording + snapshot ----------------------------------------
// A dedicated offscreen canvas + renderer captures the wrist view on its own
// (the on-screen inset is just a scissor region of the main canvas, so it
// can't be recorded in isolation). MediaRecorder turns its captureStream into
// a downloadable clip; snapshots use toBlob.
const REC_RES: Record<string, [number, number]> = {
  "480": [640, 480],
  "720": [960, 720],
  "1080": [1440, 1080],
};
const recResEl = document.getElementById("recRes") as HTMLSelectElement;
const recordBtn = document.getElementById("record") as HTMLButtonElement;
const snapshotBtn = document.getElementById("snapshot") as HTMLButtonElement;
const recBadge = document.getElementById("recBadge") as HTMLSpanElement;

const recCanvas = document.createElement("canvas");
const recRenderer = new THREE.WebGLRenderer({
  canvas: recCanvas,
  antialias: true,
  preserveDrawingBuffer: true, // so toBlob/captureStream read a valid frame
});
recRenderer.setPixelRatio(1);
recRenderer.shadowMap.enabled = true;
recRenderer.shadowMap.type = THREE.PCFSoftShadowMap;

function setRecResolution(): void {
  const [w, h] = REC_RES[recResEl.value];
  recRenderer.setSize(w, h, false);
}
setRecResolution();

let mediaRecorder: MediaRecorder | null = null;
let recChunks: Blob[] = [];
let recStartMs = 0;
let recording = false;

function bestMime(): string {
  const cands = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  if (!("MediaRecorder" in window)) return "";
  return cands.find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
}

function download(blob: Blob, ext: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  a.href = url;
  a.download = `wristcam-${ts}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function startRecording(): void {
  if (recording) return;
  if (!("MediaRecorder" in window) || typeof recCanvas.captureStream !== "function") {
    ui.setSolverStatus("Recording is not supported in this browser", "fail");
    return;
  }
  setRecResolution();
  const mime = bestMime();
  const stream = recCanvas.captureStream(30);
  mediaRecorder = new MediaRecorder(
    stream,
    mime ? { mimeType: mime, videoBitsPerSecond: 12_000_000 } : undefined
  );
  recChunks = [];
  mediaRecorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  mediaRecorder.onstop = () => {
    const type = mediaRecorder?.mimeType || mime || "video/webm";
    download(new Blob(recChunks, { type }), type.includes("mp4") ? "mp4" : "webm");
  };
  mediaRecorder.start();
  recording = true;
  recStartMs = clockMs;
  recResEl.disabled = true;
  recordBtn.textContent = "■ Stop";
  recordBtn.classList.add("recording");
  recBadge.hidden = false;
}

function stopRecording(): void {
  if (!recording || !mediaRecorder) return;
  mediaRecorder.stop();
  recording = false;
  recResEl.disabled = false;
  recordBtn.textContent = "● Record";
  recordBtn.classList.remove("recording");
  recBadge.hidden = true;
}

recordBtn.addEventListener("click", () => (recording ? stopRecording() : startRecording()));

snapshotBtn.addEventListener("click", () => {
  setRecResolution();
  recRenderer.render(scene, wristCam);
  recCanvas.toBlob((blob) => blob && download(blob, "png"), "image/png");
});

// --- Home: pose where the wrist cam frames the whole board ------------------
const HOME_HEIGHT = 0.34; // grasp-point height above the board (m)
// Park the wrist back over the near edge: the wrist cam's forward tilt then
// sweeps the whole board from near to far.
const HOME_ZOFF = -0.18;
const HOME_FOCAL = 15; // wide enough to see all 8x8
function goHome(): void {
  if (editMode) setEditMode(false);
  cancelSequence();
  held = null;
  const c = board.group.position;
  const target = new THREE.Vector3(c.x, HOME_HEIGHT, c.z + HOME_ZOFF);
  const r = solveVerticalIK(robot, target);
  focalEl.value = String(HOME_FOCAL);
  applyFocal(HOME_FOCAL);
  marker.position.copy(target);
  reportSolve(r, target);
  ui.setSolverStatus("Home — wrist cam board view", r.success ? "ok" : "warn");
  runSequence([{ grip: 1 }, { arm: r.angles }]);
}
document.getElementById("home")!.addEventListener("click", goHome);

// --- Render loop ------------------------------------------------------------
const viewSize = new THREE.Vector2();
let last = performance.now();
function tick(now: number): void {
  const dt = now - last;
  last = now;
  clockMs += dt;

  if (armAnim) {
    const t = Math.min(1, (clockMs - armAnim.t0) / armAnim.dur);
    const e = easeInOutCubic(t);
    const angles = armAnim.start.map((s, i) => s + (armAnim!.end[i] - s) * e);
    robot.setAngles(angles);
    ui.setSliderValues(angles);
    refreshReadout();
    if (t >= 1) {
      armAnim = null;
      if (waiting === "arm") startNextStep();
    }
  }

  if (gripAnim) {
    const t = Math.min(1, (clockMs - gripAnim.t0) / gripAnim.dur);
    robot.setGripper(gripAnim.start + (gripAnim.end - gripAnim.start) * t);
    if (t >= 1) {
      gripAnim = null;
      if (waiting === "grip") startNextStep();
    }
  }

  controls.update();

  // Main view (full canvas).
  renderer.getSize(viewSize);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, viewSize.x, viewSize.y);
  renderer.render(scene, camera);

  // Wrist-camera inset.
  if (pipRect.w > 0) {
    renderer.setScissorTest(true);
    renderer.setViewport(pipRect.x, pipRect.y, pipRect.w, pipRect.h);
    renderer.setScissor(pipRect.x, pipRect.y, pipRect.w, pipRect.h);
    renderer.render(scene, wristCam);
    renderer.setScissorTest(false);
  }

  // Feed the recording canvas (its captureStream samples it).
  if (recording) {
    recRenderer.render(scene, wristCam);
    const s = Math.floor((clockMs - recStartMs) / 1000);
    recBadge.textContent = `● REC ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
