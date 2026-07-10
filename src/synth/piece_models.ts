import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createPiece, PieceType, PieceColor, pieceHeight } from "../pieces";

/**
 * Pluggable chess-piece model registry. Each "set" yields an upright piece
 * (standing along +Y, base at the origin, horizontally centered) that scene.ts
 * treats identically. The manifest logs the set id + license per episode.
 *
 * Three kinds of set:
 *  - `procedural`  : the in-repo Staunton lathe pieces (src/pieces.ts), with a
 *                    per-style non-uniform scale (distinct silhouettes).
 *  - `gltf-nodes`  : one glTF whose pieces are named nodes (piece_{type}_{color}).
 *  - `per-type`    : one GLB file per piece type; recolored white/black on load.
 */

type SetDef =
  | { kind: "procedural"; license: string; style: { y: number; xz: number } }
  | { kind: "gltf-nodes"; url: string; license: string }
  | { kind: "per-type"; dir: string; ext: string; license: string };

const SETS: Record<string, SetDef> = {
  // Procedural Staunton + style variants (proportion transforms; heights stay
  // >= the grasp height so the fingers always close on the piece body).
  procedural_classic: { kind: "procedural", license: "procedural (this repo)", style: { y: 1.0, xz: 1.0 } },
  procedural_slim: { kind: "procedural", license: "procedural (this repo)", style: { y: 1.06, xz: 0.8 } },
  procedural_wide: { kind: "procedural", license: "procedural (this repo)", style: { y: 1.0, xz: 1.22 } },
  procedural_tall: { kind: "procedural", license: "procedural (this repo)", style: { y: 1.2, xz: 0.92 } },
  // Sourced sets (see public/assets/pieces/<set>/ATTRIBUTION.md).
  polyhaven_chess_set: {
    kind: "gltf-nodes",
    url: "/assets/pieces/polyhaven_chess_set/chess_set_1k.gltf",
    license: "CC0 1.0 — Poly Haven / Riley Queen",
  },
  poly_jarlan_lowpoly: {
    kind: "per-type",
    dir: "/assets/pieces/poly_jarlan_lowpoly",
    ext: ".glb",
    license: "CC-BY — Jarlan Perez / Poly Pizza",
  },
};

export const PIECE_SET_IDS: string[] = Object.keys(SETS);
export const pieceSetLicense = (id: string): string => SETS[id]?.license ?? "unknown";

const BASE_WHITE = 0xe8e4da;
const BASE_BLACK = 0x2f3036;

// Load + parse each glTF/GLB once per page.
const gltfCache: Record<string, Promise<THREE.Object3D>> = {};
function loadGltf(url: string): Promise<THREE.Object3D> {
  if (!gltfCache[url]) {
    gltfCache[url] = new Promise((resolve, reject) => {
      new GLTFLoader().load(url, (g) => resolve(g.scene), undefined, reject);
    });
  }
  return gltfCache[url];
}

/** Bake a mesh's world transform, stand it along +Y, base at origin, scale to targetH. */
function normalizeMesh(src: THREE.Mesh, targetH: number, material: THREE.Material): THREE.Group {
  src.updateWorldMatrix(true, false);
  const geo = src.geometry.clone();
  geo.applyMatrix4(src.matrixWorld);
  geo.computeBoundingBox();
  let bb = geo.boundingBox!;
  // Orient the piece's longest axis (its height) to +Y if it isn't already.
  const ext = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
  const up = ext.indexOf(Math.max(...ext));
  if (up === 0) geo.rotateZ(-Math.PI / 2);
  else if (up === 2) geo.rotateX(Math.PI / 2);
  geo.computeBoundingBox();
  bb = geo.boundingBox!;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  const h = Math.max(1e-4, bb.max.y - bb.min.y);
  // Some low-poly source GLBs ship without normals — MeshStandardMaterial then
  // renders unlit (black). Compute them from the final geometry.
  if (!geo.getAttribute("normal")) geo.computeVertexNormals();

  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const group = new THREE.Group();
  group.add(mesh);
  group.scale.setScalar(targetH / h);
  return group;
}

function firstMesh(root: THREE.Object3D): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  root.traverse((o) => { const m = o as THREE.Mesh; if (!found && m.isMesh) found = m; });
  return found;
}

/** Build a piece from a named set, upright along +Y (base at origin). */
export async function makePiece(setId: string, type: PieceType, color: PieceColor): Promise<THREE.Group> {
  const def = SETS[setId] ?? SETS.procedural_classic;

  if (def.kind === "procedural") {
    const g = createPiece(type, color);
    g.scale.set(def.style.xz, def.style.y, def.style.xz);
    g.userData.type = type; g.userData.color = color;
    return g;
  }

  if (def.kind === "gltf-nodes") {
    const root = await loadGltf(def.url);
    const prefix = `piece_${type}_${color}`;
    root.updateMatrixWorld(true);
    let node: THREE.Mesh | null = null;
    root.traverse((o) => { const m = o as THREE.Mesh; if (!node && m.isMesh && m.name.startsWith(prefix)) node = m; });
    if (!node) throw new Error(`piece node not found: ${prefix}`);
    const src = node as THREE.Mesh;
    const g = normalizeMesh(src, pieceHeight(type), (src.material as THREE.Material).clone());
    g.userData.type = type; g.userData.color = color;
    return g;
  }

  // per-type: one GLB file per piece type, single mesh, recolored white/black.
  const root = await loadGltf(`${def.dir}/${type}${def.ext}`);
  const src = firstMesh(root);
  if (!src) throw new Error(`no mesh in ${setId}/${type}`);
  const material = new THREE.MeshStandardMaterial({
    color: color === "white" ? BASE_WHITE : BASE_BLACK,
    roughness: 0.5,
    metalness: 0.1,
  });
  const g = normalizeMesh(src, pieceHeight(type), material);
  g.userData.type = type; g.userData.color = color;
  return g;
}
