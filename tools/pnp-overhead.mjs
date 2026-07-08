// Fit the overhead camera (position, look-at target, fov) in the ROS arm-base
// frame to annotated 2-D board-corner pixels, via reprojection-error descent.
// Tries all 8 dihedral corner orderings and reports the best.
import * as THREE from "three";

const IMG_W = 320, IMG_H = 240, AR = IMG_W / IMG_H;

// 3-D outer checker corners (ROS meters, z = board top), cyclic order a1->h1->h8->a8.
const C3D = [
  [0.222, 0.239, 0.009], // a1
  [0.235, -0.216, 0.009], // h1
  [0.690, -0.205, 0.009], // h8
  [0.677, 0.250, 0.009], // a8
];
// Annotated 2-D corners (native px), clockwise TL,TR,BR,BL.
const C2D = [
  [112, 60],
  [226, 65],
  [234, 202],
  [107, 199],
];
// Asymmetric anchor: the white queen at e7 (breaks the 4-corner symmetry).
const QUEEN3D = [0.599, -0.008, 0.02];
const QUEEN2D = [131, 116];

function makeCam([x, y, z, tx, ty, tz], fov) {
  const c = new THREE.PerspectiveCamera(fov, AR, 0.01, 50);
  c.up.set(0, 0, 1);
  c.position.set(x, y, z);
  c.lookAt(tx, ty, tz);
  c.updateMatrixWorld(true);
  c.updateProjectionMatrix();
  return c;
}
function project(cam, p) {
  const v = new THREE.Vector3(p[0], p[1], p[2]).project(cam);
  return [(v.x * 0.5 + 0.5) * IMG_W, (1 - (v.y * 0.5 + 0.5)) * IMG_H];
}
function cost(params, fov, corr) {
  const cam = makeCam(params, fov);
  let s = 0;
  for (const [p3, p2] of corr) {
    const q = project(cam, p3);
    s += (q[0] - p2[0]) ** 2 + (q[1] - p2[1]) ** 2;
  }
  return s;
}
// Optimize the 6 pose params for a FIXED fov (fov/distance are degenerate).
function optimize(corr, fov, init) {
  let p = init.slice();
  let step = [0.06, 0.06, 0.06, 0.06, 0.06, 0.04];
  let best = cost(p, fov, corr);
  for (let it = 0; it < 8000; it++) {
    const i = it % 6;
    let improved = false;
    for (const d of [1, -1]) {
      const q = p.slice();
      q[i] += d * step[i];
      const c = cost(q, fov, corr);
      if (c < best) { best = c; p = q; improved = true; }
    }
    if (!improved && it % 6 === 5) step = step.map((s) => s * 0.9);
  }
  return { p, best };
}

// Correct labeling (determined via the queen anchor): rank 1 on the right where
// the arm enters. a1=BR, h1=TR, h8=TL, a8=BL, plus the queen.
const [a1, h1, h8, a8] = C3D;
const [TL, TR, BR, BL] = C2D;
const corr = [[a1, BR], [h1, TR], [h8, TL], [a8, BL], [QUEEN3D, QUEEN2D]];
const init = [0.44, -0.6, 0.9, 0.456, 0.017, 0.02];
let bestOverall = null;
for (let fov = 30; fov <= 75; fov += 1) {
  const { p, best } = optimize(corr, fov, init);
  const rms = Math.sqrt(best / corr.length);
  if (p[2] > 0.2 && (!bestOverall || best < bestOverall.best)) {
    bestOverall = { p, best, rms, fov, name: `fov=${fov}`, corr };
  }
}
if (!bestOverall) throw new Error("no above-table solution");
bestOverall.p = [...bestOverall.p, bestOverall.fov];
const p = bestOverall.p;
console.log(`\nBEST: ${bestOverall.name}  RMS=${bestOverall.rms.toFixed(2)}px`);
console.log(`overhead.position.set(${p[0].toFixed(4)}, ${p[1].toFixed(4)}, ${p[2].toFixed(4)});`);
console.log(`overhead.lookAt(${p[3].toFixed(4)}, ${p[4].toFixed(4)}, ${p[5].toFixed(4)});`);
console.log(`fov = ${p[6].toFixed(2)}`);
const cam = makeCam(p.slice(0, 6), p[6]);
for (const [p3, t] of bestOverall.corr) {
  const q = project(cam, p3);
  console.log(`  proj (${q[0].toFixed(0)},${q[1].toFixed(0)}) vs (${t[0]},${t[1]})`);
}
