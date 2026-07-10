import * as THREE from "three";
import { Rng, uniform, pick, chance, randInt } from "./rng";

/**
 * Procedural floor/table finishes for domain randomization. Several distinct
 * texture families (wood planks, tile, checker mat, marble, concrete, woven
 * cloth, grid mat, plain), each drawn on a canvas with seeded detail so the
 * table surface varies meaningfully episode to episode (not just in color).
 */

export type FloorFamily =
  | "wood_planks" | "tile" | "checker" | "marble" | "concrete" | "cloth" | "grid_mat" | "plain";

export interface FloorSpec {
  family: FloorFamily;
  color: number; // primary
  color2: number; // secondary (grout / vein / alt square / grid line)
  roughness: number;
  repeat: number; // texture tiling across the desk
  rotationDeg: number;
  bgScale: number; // background wall = color * bgScale
}

const WOOD = [0xc8a678, 0xb98a55, 0xd8b98a, 0xa9825a, 0x9c7248, 0x8f6b47, 0xdcc39a, 0x6e4b29];
const NEUTRAL = [0x8a8f96, 0x6f7580, 0xb7b2a6, 0x7a6f63, 0x9aa0a6, 0x3f4650, 0xa89c86, 0xd7d2c8, 0x556b5a, 0x4a5a6a];
const ACCENT = [0x2f6b43, 0x3a5a8c, 0x8c3a3a, 0x5a5a5a, 0x1f1f24, 0xd7d2c8, 0x6b5a3a];

const rgb = (h: number): [number, number, number] => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const css = (h: number, a = 1): string => { const [r, g, b] = rgb(h); return `rgba(${r},${g},${b},${a})`; };
const shade = (h: number, f: number): string => {
  const [r, g, b] = rgb(h);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
};

export function sampleFloor(rng: Rng): FloorSpec {
  const family = pick(rng, ["wood_planks", "wood_planks", "tile", "checker", "marble", "concrete", "cloth", "grid_mat", "plain"] as FloorFamily[]);
  const base: Omit<FloorSpec, "family"> = {
    color: pick(rng, family === "wood_planks" ? WOOD : NEUTRAL),
    color2: pick(rng, ACCENT),
    roughness: uniform(rng, 0.5, 0.95),
    repeat: uniform(rng, 1.6, 3.4),
    rotationDeg: chance(rng, 0.5) ? uniform(rng, 0, 90) : 0,
    bgScale: uniform(rng, 0.7, 0.95),
  };
  if (family === "checker") base.repeat = uniform(rng, 1.0, 2.0);
  if (family === "cloth" || family === "grid_mat") base.repeat = uniform(rng, 2.0, 4.0);
  return { family, ...base };
}

function draw(spec: FloorSpec, rng: Rng): HTMLCanvasElement {
  const N = 512;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d")!;
  const { color, color2 } = spec;
  g.fillStyle = css(color);
  g.fillRect(0, 0, N, N);

  if (spec.family === "wood_planks") {
    const planks = randInt(rng, 4, 8), h = N / planks;
    for (let p = 0; p < planks; p++) {
      const y0 = p * h;
      g.fillStyle = shade(color, 0.85 + rng() * 0.3);
      g.fillRect(0, y0, N, h);
      for (let s = 0; s < 40; s++) { // grain streaks along the plank
        const y = y0 + rng() * h;
        g.strokeStyle = css(rng() > 0.5 ? 0x4a3116 : 0xeadcbf, 0.04 + rng() * 0.08);
        g.lineWidth = 1 + rng() * 2;
        g.beginPath(); g.moveTo(0, y);
        for (let x = 0; x <= N; x += 32) g.lineTo(x, y + Math.sin(x * 0.03 + p) * 2);
        g.stroke();
      }
      g.fillStyle = shade(color, 0.55); g.fillRect(0, y0, N, 2); // plank gap
    }
  } else if (spec.family === "tile") {
    const t = randInt(rng, 3, 6), s = N / t;
    for (let i = 0; i < t; i++) for (let j = 0; j < t; j++) {
      g.fillStyle = shade(color, 0.9 + rng() * 0.2);
      g.fillRect(i * s, j * s, s, s);
    }
    g.strokeStyle = css(color2); g.lineWidth = 4;
    for (let i = 0; i <= t; i++) { g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, N); g.stroke(); g.beginPath(); g.moveTo(0, i * s); g.lineTo(N, i * s); g.stroke(); }
  } else if (spec.family === "checker") {
    const t = randInt(rng, 4, 8), s = N / t;
    for (let i = 0; i < t; i++) for (let j = 0; j < t; j++) {
      g.fillStyle = (i + j) % 2 ? css(color) : css(color2);
      g.fillRect(i * s, j * s, s, s);
    }
  } else if (spec.family === "marble") {
    for (let k = 0; k < randInt(rng, 8, 16); k++) {
      g.strokeStyle = css(color2, 0.12 + rng() * 0.18);
      g.lineWidth = 1 + rng() * 4;
      let x = rng() * N, y = rng() * N;
      g.beginPath(); g.moveTo(x, y);
      for (let s = 0; s < 24; s++) { x += (rng() - 0.5) * 60; y += (rng() - 0.5) * 60; g.lineTo(x, y); }
      g.stroke();
    }
  } else if (spec.family === "concrete") {
    for (let k = 0; k < 6000; k++) {
      const f = rng() > 0.5 ? 1.15 : 0.85;
      g.fillStyle = shade(color, f); g.globalAlpha = 0.05 + rng() * 0.1;
      g.fillRect(rng() * N, rng() * N, 1 + rng() * 3, 1 + rng() * 3);
    }
    g.globalAlpha = 1;
  } else if (spec.family === "cloth") {
    const step = 6 + randInt(rng, 0, 6);
    for (let y = 0; y < N; y += step) { g.fillStyle = shade(color, y % (step * 2) < step ? 1.08 : 0.92); g.fillRect(0, y, N, step); }
    for (let x = 0; x < N; x += step) { g.fillStyle = css(color, 0.18); g.fillRect(x, 0, Math.max(1, step / 2), N); }
  } else if (spec.family === "grid_mat") {
    const step = N / randInt(rng, 10, 22);
    g.strokeStyle = css(color2, 0.55); g.lineWidth = 1.5;
    for (let x = 0; x <= N; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, N); g.stroke(); }
    for (let y = 0; y <= N; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(N, y); g.stroke(); }
  }
  // "plain" -> flat fill only (no map is used; see makeFloorMaterial)
  return c;
}

/** Build the desk material for a floor spec (canvas texture baked with detail). */
export function makeFloorMaterial(spec: FloorSpec, rng: Rng): THREE.MeshStandardMaterial {
  if (spec.family === "plain") {
    return new THREE.MeshStandardMaterial({ color: spec.color, roughness: spec.roughness });
  }
  const tex = new THREE.CanvasTexture(draw(spec, rng));
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.center.set(0.5, 0.5);
  tex.rotation = (spec.rotationDeg * Math.PI) / 180;
  tex.repeat.set(spec.repeat, spec.repeat);
  tex.anisotropy = 8;
  return new THREE.MeshStandardMaterial({ map: tex, roughness: spec.roughness });
}
