import * as THREE from "three";

export type PieceType = "pawn" | "rook" | "knight" | "bishop" | "queen" | "king";
export type PieceColor = "white" | "black";

/**
 * Classic Staunton-style chess pieces. The rotationally symmetric pieces are
 * built with THREE.LatheGeometry from a hand-drawn silhouette (radius, height)
 * in meters; the knight uses an extruded horse-head profile on a turned base.
 * Small toppers (rook crenellations, bishop mitre ball, queen coronet, king
 * cross) add the recognizable detail a lathe alone cannot.
 *
 * All pieces stand on the X/Z plane with y = 0 at the base.
 */

// Silhouettes: arrays of [radius, height] from the base upward, in meters.
const PROFILES: Record<Exclude<PieceType, "knight">, number[][]> = {
  pawn: [
    [0.0, 0.0], [0.0145, 0.0], [0.0145, 0.003], [0.011, 0.005], [0.0075, 0.009],
    [0.0085, 0.012], [0.006, 0.0145], [0.006, 0.016], [0.0098, 0.0175],
    [0.0085, 0.0205], [0.0075, 0.0225], [0.009, 0.0245], [0.0075, 0.028],
    [0.004, 0.0305], [0.0, 0.032],
  ],
  rook: [
    [0.0, 0.0], [0.016, 0.0], [0.016, 0.004], [0.012, 0.007], [0.0095, 0.012],
    [0.009, 0.024], [0.0105, 0.028], [0.0125, 0.03], [0.0125, 0.036],
    [0.011, 0.036], [0.011, 0.031], [0.0, 0.031],
  ],
  bishop: [
    [0.0, 0.0], [0.0155, 0.0], [0.0155, 0.004], [0.011, 0.007], [0.0075, 0.012],
    [0.0072, 0.026], [0.0115, 0.03], [0.0075, 0.033], [0.0055, 0.036],
    [0.0075, 0.04], [0.0065, 0.044], [0.0042, 0.05], [0.0, 0.054],
  ],
  queen: [
    [0.0, 0.0], [0.0175, 0.0], [0.0175, 0.004], [0.012, 0.008], [0.0085, 0.014],
    [0.0075, 0.03], [0.0078, 0.04], [0.012, 0.045], [0.014, 0.05], [0.011, 0.053],
    [0.008, 0.057], [0.0, 0.06],
  ],
  king: [
    [0.0, 0.0], [0.018, 0.0], [0.018, 0.004], [0.013, 0.009], [0.009, 0.015],
    [0.008, 0.034], [0.0082, 0.046], [0.013, 0.051], [0.0145, 0.056],
    [0.011, 0.06], [0.009, 0.064], [0.0, 0.066],
  ],
};

const MATERIALS: Record<PieceColor, THREE.MeshStandardMaterial> = {
  white: new THREE.MeshStandardMaterial({ color: 0xeae3d2, roughness: 0.55, metalness: 0.05 }),
  black: new THREE.MeshStandardMaterial({ color: 0x2a2d33, roughness: 0.5, metalness: 0.1 }),
};

function lathe(profile: number[][], mat: THREE.Material): THREE.Mesh {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y));
  const geo = new THREE.LatheGeometry(pts, 28);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

function knight(mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  // Turned pedestal.
  const base = lathe(
    [
      [0.0, 0.0], [0.016, 0.0], [0.016, 0.004], [0.012, 0.008], [0.009, 0.013],
      [0.0085, 0.02], [0.011, 0.022], [0.011, 0.024], [0.0, 0.024],
    ],
    mat
  );
  g.add(base);

  // Horse-head silhouette extruded into a slab, standing on the pedestal.
  const s = new THREE.Shape();
  s.moveTo(-0.006, 0.0);
  s.lineTo(0.008, 0.0);
  s.lineTo(0.01, 0.012);
  s.lineTo(0.013, 0.02);
  s.lineTo(0.009, 0.026);
  s.lineTo(0.012, 0.03); // muzzle
  s.lineTo(0.006, 0.032);
  s.lineTo(-0.002, 0.03);
  s.lineTo(-0.006, 0.034); // ears/mane top
  s.lineTo(-0.01, 0.03);
  s.lineTo(-0.009, 0.022);
  s.lineTo(-0.012, 0.016);
  s.lineTo(-0.008, 0.008);
  s.closePath();

  const head = new THREE.Mesh(
    new THREE.ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.001, bevelSize: 0.001, bevelSegments: 1 }),
    mat
  );
  head.rotation.y = Math.PI / 2;
  head.position.set(0.006, 0.022, 0);
  head.castShadow = true;
  g.add(head);
  return g;
}

/** Build a chess piece. Returns a Group with userData.type/color set. */
export function createPiece(type: PieceType, color: PieceColor): THREE.Group {
  const mat = MATERIALS[color];
  const group = new THREE.Group();

  if (type === "knight") {
    const k = knight(mat);
    group.add(k);
  } else {
    group.add(lathe(PROFILES[type], mat));
  }

  // Recognizable toppers.
  if (type === "rook") {
    // Crenellations around the rim.
    for (let i = 0; i < 6; i++) {
      const n = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.006, 0.005), mat);
      const a = (i / 6) * Math.PI * 2;
      n.position.set(Math.cos(a) * 0.0095, 0.039, Math.sin(a) * 0.0095);
      n.castShadow = true;
      group.add(n);
    }
  } else if (type === "bishop") {
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.0045, 16, 12), mat);
    ball.position.y = 0.057;
    ball.castShadow = true;
    group.add(ball);
  } else if (type === "queen") {
    for (let i = 0; i < 7; i++) {
      const pt = new THREE.Mesh(new THREE.SphereGeometry(0.0028, 12, 10), mat);
      const a = (i / 7) * Math.PI * 2;
      pt.position.set(Math.cos(a) * 0.009, 0.062, Math.sin(a) * 0.009);
      pt.castShadow = true;
      group.add(pt);
    }
    const crown = new THREE.Mesh(new THREE.SphereGeometry(0.004, 14, 10), mat);
    crown.position.y = 0.063;
    group.add(crown);
  } else if (type === "king") {
    const v = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.016, 0.004), mat);
    v.position.y = 0.072;
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.004, 0.004), mat);
    h.position.y = 0.07;
    v.castShadow = true;
    h.castShadow = true;
    group.add(v, h);
  }

  group.userData.type = type;
  group.userData.color = color;
  return group;
}

/** Approximate standing height of a piece, for grasp targeting. */
export function pieceHeight(type: PieceType): number {
  const tops: Record<PieceType, number> = {
    pawn: 0.032,
    rook: 0.042,
    knight: 0.04,
    bishop: 0.058,
    queen: 0.066,
    king: 0.076,
  };
  return tops[type];
}
