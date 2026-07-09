import * as THREE from "three";

/**
 * Board placed from the data-derived grid pose (see docs/rollout_data_analysis).
 * ROS arm-base frame (Z up, meters). square_center(file,rank) in mm:
 *   x = 1.61f + 56.81r + 251.49 ;  y = -56.89f + 1.28r + 211.65
 */
export const A1 = new THREE.Vector3(0.25149, 0.21165, 0);
export const U_FILE = new THREE.Vector3(0.00161, -0.05689, 0); // per file (a->h)
export const V_RANK = new THREE.Vector3(0.05681, 0.00128, 0); // per rank (1->8)
export const SQUARE = 0.0569;
export const BOARD_TOP = 0.009;
export const BOARD_YAW = Math.atan2(V_RANK.y, V_RANK.x);

export function squareCenter(file: number, rank: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(A1).addScaledVector(U_FILE, file).addScaledVector(V_RANK, rank);
}
export const boardCenter = squareCenter(3.5, 3.5);

/**
 * Procedural wood-grain floor texture — varies across the whole surface (so
 * orientation and motion are readable) without a grid.
 */
export function makeFloorTexture(): THREE.CanvasTexture {
  const N = 512;
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d")!;
  g.fillStyle = "#c8a678";
  g.fillRect(0, 0, N, N);
  // Vertical grain: thin streaks with a slow wave + noise.
  for (let x = 0; x < N; x++) {
    const wave = Math.sin(x * 0.06) + Math.sin(x * 0.017 + 1.3) * 0.6;
    const shade = wave * 0.5 + (Math.random() - 0.5) * 1.1;
    const a = Math.min(0.22, Math.abs(shade) * 0.16);
    g.fillStyle = shade > 0 ? `rgba(96,64,34,${a})` : `rgba(226,198,158,${a})`;
    g.fillRect(x, 0, 1, N);
  }
  // A few darker grain streaks / knots for large-scale variation.
  for (let k = 0; k < 30; k++) {
    const x = Math.random() * N;
    g.strokeStyle = `rgba(80,52,26,${0.05 + Math.random() * 0.08})`;
    g.lineWidth = 1 + Math.random() * 3;
    g.beginPath();
    g.moveTo(x, 0);
    for (let y = 0; y <= N; y += 32) g.lineTo(x + Math.sin(y * 0.02 + k) * 8, y);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2.5, 2.5); // ~1.6m per tile over the 4m table
  tex.anisotropy = 8;
  return tex;
}

function labelMesh(txt: string): THREE.Mesh {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 64;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#20242b";
  g.font = "bold 44px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(txt, 32, 34);
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(0.03, 0.03),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true })
  );
  m.rotation.z = BOARD_YAW;
  return m;
}

/** Build the green/cream board (tiles + border + a-h/1-8 labels) at its pose. */
export function buildBoard(): THREE.Group {
  const group = new THREE.Group();
  const lightMat = new THREE.MeshStandardMaterial({ color: 0xe7e2d0, roughness: 0.6 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x2f6b43, roughness: 0.6 });
  const tileGeo = new THREE.BoxGeometry(SQUARE, SQUARE, 0.004);
  const c = new THREE.Vector3();
  for (let f = 0; f < 8; f++)
    for (let r = 0; r < 8; r++) {
      const isLight = (f + r) % 2 === 1; // a1 (0,0) dark, standard
      const tile = new THREE.Mesh(tileGeo, isLight ? lightMat : darkMat);
      squareCenter(f, r, c);
      tile.position.set(c.x, c.y, 0.007);
      tile.rotation.z = BOARD_YAW;
      tile.receiveShadow = true;
      group.add(tile);
    }
  squareCenter(3.5, 3.5, c);
  const border = new THREE.Mesh(
    new THREE.BoxGeometry(SQUARE * 8 + 0.02, SQUARE * 8 + 0.02, 0.006),
    new THREE.MeshStandardMaterial({ color: 0xd8d1bb, roughness: 0.7 })
  );
  border.position.set(c.x, c.y, 0.003);
  border.rotation.z = BOARD_YAW;
  border.receiveShadow = true;
  group.add(border);
  for (let f = 0; f < 8; f++) {
    squareCenter(f, -0.8, c);
    const l = labelMesh("abcdefgh"[f]);
    l.position.set(c.x, c.y, BOARD_TOP + 0.001);
    group.add(l);
  }
  for (let r = 0; r < 8; r++) {
    squareCenter(-0.8, r, c);
    const l = labelMesh(String(r + 1));
    l.position.set(c.x, c.y, BOARD_TOP + 0.001);
    group.add(l);
  }
  return group;
}
