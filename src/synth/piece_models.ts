import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createPiece, PieceType, PieceColor, pieceHeight } from "../pieces";

/**
 * Pluggable chess-piece model registry. Each "set" yields an upright piece
 * (standing along +Y, base at the origin, horizontally centered) that scene.ts
 * treats identically to the procedural pieces. Sourced glTF/GLB sets drop in
 * here; the manifest logs the set id + license per episode for ablations.
 *
 * `procedural_lathe` — the in-repo Staunton lathe pieces (src/pieces.ts).
 * `polyhaven_chess_set` — CC0 antique set from Poly Haven (per-piece nodes).
 */

const PROCEDURAL = "procedural_lathe";

interface GltfSet { url: string; license: string; }
const GLTF_SETS: Record<string, GltfSet> = {
  polyhaven_chess_set: {
    url: "/assets/pieces/polyhaven_chess_set/chess_set_1k.gltf",
    license: "CC0 1.0 — Poly Haven / Riley Queen",
  },
};

export const PIECE_SET_IDS: string[] = [PROCEDURAL, ...Object.keys(GLTF_SETS)];
export const pieceSetLicense = (id: string): string =>
  id === PROCEDURAL ? "procedural (this repo)" : GLTF_SETS[id]?.license ?? "unknown";

// Load + parse each glTF once per page.
const gltfCache: Record<string, Promise<THREE.Object3D>> = {};
function loadGltf(url: string): Promise<THREE.Object3D> {
  if (!gltfCache[url]) {
    gltfCache[url] = new Promise((resolve, reject) => {
      new GLTFLoader().load(url, (g) => resolve(g.scene), undefined, reject);
    });
  }
  return gltfCache[url];
}

/** Extract one piece by node name, bake its world transform, normalize pose+scale. */
function extractPiece(root: THREE.Object3D, type: PieceType, color: PieceColor, targetH: number): THREE.Group {
  const prefix = `piece_${type}_${color}`;
  let node: THREE.Mesh | null = null;
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!node && m.isMesh && m.name.startsWith(prefix)) node = m;
  });
  if (!node) throw new Error(`piece node not found: ${prefix}`);
  const src = node as THREE.Mesh;

  // Bake world transform (board placement + standing orientation + scale) into a
  // geometry copy, then recenter so the base sits at y=0, centered in x/z.
  const geo = src.geometry.clone();
  geo.applyMatrix4(src.matrixWorld);
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  const h = Math.max(1e-4, bb.max.y - bb.min.y);

  const material = (src.material as THREE.Material).clone();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const group = new THREE.Group();
  group.add(mesh);
  group.scale.setScalar(targetH / h); // match the procedural standing height for consistent grasp geometry
  group.userData.type = type;
  group.userData.color = color;
  return group;
}

/** Build a piece from a named set, upright along +Y (base at origin). */
export async function makePiece(setId: string, type: PieceType, color: PieceColor): Promise<THREE.Group> {
  if (setId === PROCEDURAL || !GLTF_SETS[setId]) return createPiece(type, color);
  const root = await loadGltf(GLTF_SETS[setId].url);
  return extractPiece(root, type, color, pieceHeight(type));
}
