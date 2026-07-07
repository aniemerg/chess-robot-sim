import * as THREE from "three";
import { createPiece, pieceHeight, PieceType, PieceColor } from "./pieces";

export interface BoardConfig {
  squareSize: number; // meters
  center: THREE.Vector3; // world position of board center (on the table)
  lightColor?: number;
  darkColor?: number;
  frameColor?: number;
  labels?: boolean; // print a-h / 1-8 around the border
}

export const BOARD_CONFIG: BoardConfig = {
  squareSize: 0.05,
  center: new THREE.Vector3(0, 0, 0.16),
};

export interface SquarePick {
  kind: "square";
  file: number;
  rank: number;
}
export interface PiecePick {
  kind: "piece";
  group: THREE.Group;
  type: PieceType;
  color: PieceColor;
}
export type Pick = SquarePick | PiecePick;

const BACK_RANK: PieceType[] = [
  "rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook",
];

/**
 * 8x8 chessboard with Staunton-style pieces. Provides world coordinates for
 * every square, helpers for the robot pick-and-place workflow, and a full
 * editing API (add / remove / move / recolor / clear / reset).
 *
 * The board lies flat on the X/Z plane at the configured center; file = column
 * (X), rank = row (Z). Rank 0/1 are white, rank 6/7 are black.
 */
export class Chessboard {
  readonly group: THREE.Group;
  readonly squares: THREE.Mesh[] = [];
  readonly pieces: THREE.Group[] = [];
  readonly surfaceLocalY: number; // local Y of the playing surface (piece base)

  private readonly n = 8;
  private readonly boardThickness = 0.012;
  private readonly tileHeight = 0.003;
  private readonly half: number;

  constructor(private cfg: BoardConfig = BOARD_CONFIG) {
    this.group = new THREE.Group();
    this.group.position.copy(cfg.center);
    this.half = (this.n * cfg.squareSize) / 2;
    this.surfaceLocalY = this.boardThickness + this.tileHeight;

    this.buildBoard();
    if (cfg.labels) this.buildLabels();
    this.resetToStart();
  }

  /** Objects the raycaster should test (board tiles + all pieces). */
  get pickables(): THREE.Object3D[] {
    return [...this.squares, ...this.pieces];
  }

  private buildBoard(): void {
    const n = this.n;
    const size = this.cfg.squareSize;

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(n * size + 0.03, this.boardThickness, n * size + 0.03),
      new THREE.MeshStandardMaterial({ color: this.cfg.frameColor ?? 0x2c2118, roughness: 0.7 })
    );
    frame.position.y = this.boardThickness / 2;
    frame.receiveShadow = true;
    this.group.add(frame);

    const light = new THREE.MeshStandardMaterial({ color: this.cfg.lightColor ?? 0xe8dcc0, roughness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: this.cfg.darkColor ?? 0x6b4a2f, roughness: 0.6 });
    const tileGeo = new THREE.BoxGeometry(size * 0.99, this.tileHeight, size * 0.99);

    for (let rank = 0; rank < n; rank++) {
      for (let file = 0; file < n; file++) {
        // Standard chess coloring: a1 (file 0, rank 0) is dark; a8 is light.
        const isLight = (rank + file) % 2 === 1;
        const sq = new THREE.Mesh(tileGeo, isLight ? light : dark);
        const { x, z } = this.squareCenterLocal(file, rank);
        sq.position.set(x, this.boardThickness + this.tileHeight / 2, z);
        sq.receiveShadow = true;
        sq.userData.kind = "square";
        sq.userData.file = file;
        sq.userData.rank = rank;
        this.group.add(sq);
        this.squares.push(sq);
      }
    }
  }

  /** Print file letters (a-h) and rank numbers (1-8) around the border. */
  private buildLabels(): void {
    const size = this.cfg.squareSize;
    const off = this.half + size * 0.42; // just outside the playing area
    const y = this.boardThickness + 0.001;

    const makeLabel = (txt: string): THREE.Mesh => {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d")!;
      g.fillStyle = "#20242b";
      g.font = "bold 46px system-ui, sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(txt, 32, 34);
      const tex = new THREE.CanvasTexture(c);
      tex.anisotropy = 4;
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(size * 0.6, size * 0.6),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true })
      );
      m.rotation.x = -Math.PI / 2; // lie flat, facing up
      return m;
    };

    for (let f = 0; f < this.n; f++) {
      const { x } = this.squareCenterLocal(f, 0);
      const near = makeLabel("abcdefgh"[f]);
      near.position.set(x, y, -off);
      const far = makeLabel("abcdefgh"[f]);
      far.position.set(x, y, off);
      far.rotation.z = Math.PI;
      this.group.add(near, far);
    }
    for (let r = 0; r < this.n; r++) {
      const { z } = this.squareCenterLocal(0, r);
      const left = makeLabel(String(r + 1));
      left.position.set(-off, y, z);
      const right = makeLabel(String(r + 1));
      right.position.set(off, y, z);
      this.group.add(left, right);
    }
  }

  // --- Editing API ----------------------------------------------------------

  /** Add a piece to a square, replacing any piece already there. Returns it. */
  addPiece(type: PieceType, color: PieceColor, file: number, rank: number): THREE.Group {
    const existing = this.pieceAt(file, rank);
    if (existing) this.removePiece(existing);

    const piece = createPiece(type, color);
    const { x, z } = this.squareCenterLocal(file, rank);
    piece.position.set(x, this.surfaceLocalY, z);
    piece.rotation.y = color === "white" ? 0 : Math.PI; // face the opponent
    piece.userData.file = file;
    piece.userData.rank = rank;
    this.group.add(piece);
    this.pieces.push(piece);
    return piece;
  }

  /** Remove a piece from the board and free its geometry. */
  removePiece(piece: THREE.Group): void {
    const i = this.pieces.indexOf(piece);
    if (i >= 0) this.pieces.splice(i, 1);
    piece.parent?.remove(piece);
    piece.traverse((o) => {
      if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
    });
  }

  /** Recolor a piece in place (rebuilds it). Returns the new piece. */
  recolorPiece(piece: THREE.Group, color: PieceColor): THREE.Group {
    const { type, file, rank } = piece.userData as {
      type: PieceType; file: number; rank: number;
    };
    return this.addPiece(type, color, file, rank); // addPiece removes the old one
  }

  /** Move a piece onto a square, capturing any occupant. */
  movePiece(piece: THREE.Group, file: number, rank: number): void {
    const occupant = this.pieceAt(file, rank);
    if (occupant && occupant !== piece) this.removePiece(occupant);
    this.placePieceOnSquare(piece, file, rank);
  }

  /** Remove every piece. */
  clearBoard(): void {
    while (this.pieces.length) this.removePiece(this.pieces[0]);
  }

  /** Clear and lay out the standard starting position. */
  resetToStart(): void {
    this.clearBoard();
    for (let file = 0; file < this.n; file++) {
      this.addPiece(BACK_RANK[file], "white", file, 0);
      this.addPiece("pawn", "white", file, 1);
      this.addPiece("pawn", "black", file, 6);
      this.addPiece(BACK_RANK[file], "black", file, 7);
    }
  }

  pieceAt(file: number, rank: number): THREE.Group | null {
    return (
      this.pieces.find((p) => p.userData.file === file && p.userData.rank === rank) ?? null
    );
  }

  // --- Geometry helpers -----------------------------------------------------

  /** Local (board-frame) center of a square (X/Z); Y is the surface. */
  squareCenterLocal(file: number, rank: number): { x: number; z: number } {
    const size = this.cfg.squareSize;
    return {
      x: -this.half + size / 2 + file * size,
      z: -this.half + size / 2 + rank * size,
    };
  }

  /** World position of a square's playing surface (respects board rotation). */
  worldSquareCenter(file: number, rank: number, out = new THREE.Vector3()): THREE.Vector3 {
    const { x, z } = this.squareCenterLocal(file, rank);
    out.set(x, this.surfaceLocalY, z);
    this.group.updateMatrixWorld();
    return this.group.localToWorld(out);
  }

  /** Resolve a raycast hit into a square or piece pick (walks up the graph). */
  resolvePick(hit: THREE.Object3D): Pick | null {
    let o: THREE.Object3D | null = hit;
    while (o) {
      if (o.userData.kind === "square") {
        return { kind: "square", file: o.userData.file, rank: o.userData.rank };
      }
      if (o.userData.type) {
        return {
          kind: "piece",
          group: o as THREE.Group,
          type: o.userData.type,
          color: o.userData.color,
        };
      }
      o = o.parent;
    }
    return null;
  }

  /** Grasp point (world) for holding a piece, around its upper body. */
  graspPointForPiece(piece: THREE.Group, out = new THREE.Vector3()): THREE.Vector3 {
    piece.getWorldPosition(out);
    out.y = this.group.position.y + this.surfaceLocalY + pieceHeight(piece.userData.type) * 0.6;
    return out;
  }

  /** Reparent a piece onto a square, base on the surface (used by the robot). */
  placePieceOnSquare(piece: THREE.Group, file: number, rank: number): void {
    this.group.attach(piece); // preserves world transform, then we set it cleanly
    const { x, z } = this.squareCenterLocal(file, rank);
    piece.position.set(x, this.surfaceLocalY, z);
    piece.rotation.set(0, piece.userData.color === "white" ? 0 : Math.PI, 0);
    piece.userData.file = file;
    piece.userData.rank = rank;
  }
}
