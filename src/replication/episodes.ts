import { PieceType, PieceColor } from "../pieces";

/**
 * Per-episode configuration for replicating the real-robot rollout videos.
 *
 * There is no ground-truth metadata for the source clips, so these are derived
 * by reading the frames: the task caption, whether a board is present, the
 * overhead camera setup (A/B/C), where the robot base sits relative to the
 * board, and the task-relevant piece(s). "Task-relevant pieces only" — we stage
 * just what the task needs, not the full board.
 */

export type OverheadPreset = "A" | "B" | "C";

export interface MoveAction {
  kind: "move";
  color: PieceColor;
  piece: PieceType;
  from: string; // algebraic square, e.g. "e7"
  to: string; // e.g. "h1"
}

export interface PickAction {
  kind: "pick";
  color: PieceColor;
  piece: PieceType;
  at: string; // square if on a board
}

export interface Episode {
  id: string;
  task: string;
  board: boolean;
  preset: OverheadPreset;
  /** Board yaw about its center, degrees (calibration). */
  boardRotation?: number;
  /** Reverse file direction (a<->h) to match the source board; flips colors. */
  mirrorFiles?: boolean;
  /** Robot base position in world meters [x, y, z]. */
  base: [number, number, number];
  action: MoveAction | PickAction;
}

export const EPISODES: Record<string, Episode> = {
  v2_001: {
    id: "v2_001",
    task: "move the white queen from e7 to h1",
    board: true,
    preset: "C",
    boardRotation: 270,
    mirrorFiles: true,
    base: [0.33, 0, 0.16],
    action: { kind: "move", color: "white", piece: "queen", from: "e7", to: "h1" },
  },
};

/** Parse an algebraic square ("e7") to [file 0-7, rank 0-7]. */
export function parseSquare(sq: string): [number, number] {
  const file = sq.charCodeAt(0) - "a".charCodeAt(0);
  const rank = Number(sq[1]) - 1;
  return [file, rank];
}
