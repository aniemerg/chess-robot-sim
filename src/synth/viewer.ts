import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { buildEpisode, BuiltEpisode } from "./episode";
import { PIECE_SET_IDS } from "./piece_models";

/**
 * Interactive scenario viewer. Generate an episode from (scenario, seed, set),
 * orbit the 3D sim, scrub the replay, see the base/wrist camera views as
 * recorded, toggle the motion waypoints + TCP path, and inspect the episode.json
 * / manifest / frames.jsonl behind the render. Overlays live on render layer 1
 * so the *data* cameras stay clean (no debug geometry).
 */

const $ = (id: string) => document.getElementById(id)!;
const OVERLAY_LAYER = 1;

// --- Renderers --------------------------------------------------------------
function mkRenderer(canvas: HTMLCanvasElement, w: number, h: number): THREE.WebGLRenderer {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true });
  r.setPixelRatio(1);
  r.setSize(w, h, false);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap;
  return r;
}
const mainR = mkRenderer($("main") as HTMLCanvasElement, 640, 460);
const baseR = mkRenderer($("baseCam") as HTMLCanvasElement, 300, 225);
const wristR = mkRenderer($("wristCam") as HTMLCanvasElement, 300, 225);

// --- Orbit (free) camera ----------------------------------------------------
const orbit = new THREE.PerspectiveCamera(45, 640 / 460, 0.01, 50);
orbit.up.set(0, 0, 1);
orbit.position.set(1.25, -0.95, 0.95);
orbit.layers.enable(OVERLAY_LAYER); // sees the scene AND the overlays
const controls = new OrbitControls(orbit, $("main") as HTMLCanvasElement);
controls.target.set(0.42, 0, 0.14);
controls.enableDamping = true;

// --- UI refs ----------------------------------------------------------------
const scenarioSel = $("scenario") as HTMLSelectElement;
const seedInput = $("seed") as HTMLInputElement;
const setSel = $("set") as HTMLSelectElement;
const scrub = $("scrub") as HTMLInputElement;
const playBtn = $("play") as HTMLButtonElement;
for (const id of PIECE_SET_IDS) setSel.add(new Option(id, id));

// --- State ------------------------------------------------------------------
let ep: BuiltEpisode | null = null;
let overlay: THREE.Group | null = null;
let tcpMarker: THREE.Mesh | null = null;
let frame = 0;
let playPos = 0; // float playback position (frame is the rounded, posed frame)
let playing = false;
const clock = new THREE.Clock();

const WP_COLORS = [0x8bd450, 0x5fb0ff, 0xffcf5f, 0xff8f5f, 0xff5f8f, 0xc98bff, 0x5fffd0, 0xffffff];

function disposeScene(scene: THREE.Scene | undefined): void {
  scene?.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

function buildOverlay(e: BuiltEpisode): void {
  overlay = new THREE.Group();
  // Full true TCP path.
  const pts = e.trueFrames.map((f) => new THREE.Vector3(f.x / 1000, f.y / 1000, f.z / 1000));
  const path = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: 0x9aa7b8, transparent: true, opacity: 0.8 })
  );
  path.name = "path";
  overlay.add(path);

  // Waypoint markers + a coarse polyline through them.
  const wpPts: THREE.Vector3[] = [];
  const wpGroup = new THREE.Group();
  wpGroup.name = "waypoints";
  e.waypoints.forEach((w, i) => {
    const p = new THREE.Vector3(w.pos[0] / 1000, w.pos[1] / 1000, w.pos[2] / 1000);
    wpPts.push(p);
    const s = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 16, 12),
      new THREE.MeshBasicMaterial({ color: WP_COLORS[i % WP_COLORS.length] })
    );
    s.position.copy(p);
    wpGroup.add(s);
  });
  wpGroup.add(new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(wpPts),
    new THREE.LineDashedMaterial({ color: 0x60707f, dashSize: 0.02, gapSize: 0.012 })
  ).computeLineDistances());
  overlay.add(wpGroup);

  // Moving TCP marker.
  tcpMarker = new THREE.Mesh(
    new THREE.SphereGeometry(0.009, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xff3b6b })
  );
  tcpMarker.name = "tcp";
  overlay.add(tcpMarker);

  overlay.traverse((o) => o.layers.set(OVERLAY_LAYER)); // only the orbit camera renders these
  e.scene.add(overlay);
  applyToggles();

  // Legend
  $("legend").innerHTML = e.waypoints
    .map((w, i) => `<span><span class="dot" style="background:#${WP_COLORS[i % WP_COLORS.length].toString(16).padStart(6, "0")}"></span>${i + 1}. ${w.label}</span>`)
    .join("");
}

function applyToggles(): void {
  if (!overlay) return;
  const show = (name: string, on: boolean) => { const o = overlay!.getObjectByName(name); if (o) o.visible = on; };
  show("waypoints", ($("tWp") as HTMLInputElement).checked);
  show("path", ($("tPath") as HTMLInputElement).checked);
  show("tcp", ($("tTcp") as HTMLInputElement).checked);
}

function phaseFor(e: BuiltEpisode, f: number): string {
  const isMove = e.detachFrame >= 0;
  if (e.attachFrame < 0) return "—";
  if (f < e.attachFrame) return "approach / hover (gripper open)";
  if (isMove) return f < e.detachFrame ? "carrying (grasped)" : "released — retract to home";
  return "grasped — lift high & hold";
}

function setFrame(f: number): void {
  if (!ep) return;
  frame = Math.max(0, Math.min(ep.numFrames - 1, Math.round(f)));
  ep.poseFrame(frame);
  if (tcpMarker) { const t = ep.trueFrames[frame]; tcpMarker.position.set(t.x / 1000, t.y / 1000, t.z / 1000); }
  scrub.value = String(frame);
  const t = ep.logged[frame];
  $("frameLbl").textContent = `frame ${frame}/${ep.numFrames - 1}`;
  $("timeLbl").textContent = `${t.t.toFixed(2)}s`;
  $("phaseLbl").textContent = phaseFor(ep, frame);
  const fmt = (a: number[]) => `[x ${a[0].toFixed(1)}, y ${a[1].toFixed(1)}, z ${a[2].toFixed(1)} mm | yaw ${a[3].toFixed(0)}° | grip ${a[4].toFixed(2)}]`;
  $("frameInfo").textContent =
    `frame ${frame}   t = ${t.t.toFixed(3)} s\n` +
    `state  = ${fmt(t.state)}\n` +
    `action = ${fmt(t.action)}   (action[i] = state[i+1], the commanded next state)\n\n` +
    `grasp @ frame ${ep.attachFrame}` + (ep.detachFrame >= 0 ? `   release @ frame ${ep.detachFrame}` : "   (pickup: no release)");
}

function fillInfo(e: BuiltEpisode): void {
  $("task").innerHTML = `${e.task}<span class="kind" id="taskKind">scenario: ${e.scenario} · seed ${e.seed} · ${e.numFrames} frames · ${e.stats.duration_s}s · IK ${e.stats.meanErr_mm}mm</span>`;
  $("epJson").textContent = JSON.stringify(e.episodeJson, null, 2);
  $("manifest").textContent = JSON.stringify(e.manifest, null, 2);
  const L = e.logged;
  const head = L.slice(0, 4).map((x) => JSON.stringify(x));
  const tail = L.slice(-3).map((x) => JSON.stringify(x));
  $("framesJsonl").textContent = [...head, `… (${L.length} rows total; note the repeated state rows = sample-hold) …`, ...tail].join("\n");
}

async function generate(): Promise<void> {
  const gen = $("gen") as HTMLButtonElement;
  gen.disabled = true; gen.textContent = "…";
  const old = ep?.scene;
  if (old && overlay) old.remove(overlay);
  ep = await buildEpisode(scenarioSel.value, Number(seedInput.value), { setOverride: setSel.value || null });
  if (old) disposeScene(old);
  buildOverlay(ep);
  scrub.max = String(ep.numFrames - 1);
  fillInfo(ep);
  playing = false; playBtn.textContent = "▶ Play";
  setFrame(0);
  gen.disabled = false; gen.textContent = "Generate";
  (window as unknown as Record<string, unknown>).VIEWER = {
    ready: true, task: ep.task, num: ep.numFrames, waypoints: ep.waypoints.length, stats: ep.stats,
    setFrame: (f: number) => setFrame(f),
  };
}

// --- Wiring -----------------------------------------------------------------
$("gen").addEventListener("click", generate);
$("rand").addEventListener("click", () => { seedInput.value = String(Math.floor(Math.random() * 100000)); generate(); });
scrub.addEventListener("input", () => { playing = false; playBtn.textContent = "▶ Play"; setFrame(Number(scrub.value)); playPos = frame; });
playBtn.addEventListener("click", () => {
  if (!ep) return;
  playing = !playing;
  playBtn.textContent = playing ? "⏸ Pause" : "▶ Play";
  if (playing && frame >= ep.numFrames - 1) { setFrame(0); }
  playPos = frame;
  clock.getDelta();
});
for (const id of ["tWp", "tPath", "tTcp"]) $(id).addEventListener("change", applyToggles);

function loop(): void {
  const dt = clock.getDelta();
  if (playing && ep) {
    playPos += dt * ep.fps;
    if (playPos >= ep.numFrames - 1) { setFrame(ep.numFrames - 1); playing = false; playBtn.textContent = "▶ Play"; }
    else setFrame(playPos);
  }
  controls.update();
  if (ep) {
    mainR.render(ep.scene, orbit);
    baseR.render(ep.scene, ep.overhead);
    wristR.render(ep.scene, ep.wrist);
  }
  requestAnimationFrame(loop);
}

seedInput.value = "11";
generate();
requestAnimationFrame(loop);
