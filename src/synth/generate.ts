import * as THREE from "three";
import { buildEpisode } from "./episode";

/**
 * Synthetic episode entry point (loaded by synth.html). Builds an episode via
 * the shared builder and exposes window.SYNTH for the headless writer
 * (tools/render-synth.mjs): renders base + wrist to separate 320x240 JPEGs,
 * the recorder's on-disk form.
 */

const IMG_W = 320, IMG_H = 240;
const JPEG_QUALITY = 0.9;

const params = new URLSearchParams(location.search);
const scenario = params.get("scenario") ?? "queen_move";
const seed = Number(params.get("seed") ?? "1");
const index = Number(params.get("index") ?? "0");
const setOverride = params.get("set");

const ep = await buildEpisode(scenario, seed, { index, setOverride });

const canvas = (document.getElementById("out") as HTMLCanvasElement) ?? document.createElement("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(IMG_W, IMG_H, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

function renderWith(cam: THREE.PerspectiveCamera): string {
  cam.aspect = IMG_W / IMG_H;
  cam.updateProjectionMatrix();
  renderer.setViewport(0, 0, IMG_W, IMG_H);
  renderer.render(ep.scene, cam);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}
const renderBase = (f: number): string => { ep.poseFrame(f); return renderWith(ep.overhead); };
const renderWrist = (f: number): string => { ep.poseFrame(f); return renderWith(ep.wrist); };

(window as unknown as Record<string, unknown>).SYNTH = {
  ready: true,
  numFrames: ep.numFrames,
  scenario,
  seed,
  episode: ep.episodeJson,
  frames: ep.logged,
  manifest: ep.manifest,
  stats: ep.stats,
  renderBase,
  renderWrist,
};

renderBase(0); // prime the first frame
