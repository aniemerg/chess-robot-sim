import { PieceType, PieceColor } from "../pieces";

/** Per-episode replication config (ROS arm-base frame). */
export interface Overhead {
  pos: [number, number, number];
  target: [number, number, number];
  fov: number;
}
export interface XEpisode {
  board: boolean;
  piece: PieceType;
  color: PieceColor;
  from?: string; // move start square (piece placed here)
  to?: string; // move destination square
  atMM?: [number, number]; // pickup: piece world (x,y) mm
  overhead: Overhead;
  wristTilt: number; // degrees
  boardOffset?: { x: number; y: number; yaw: number };
}

const T: [number, number, number] = [0.4226, 0.0223, 0.2235];
// Setup C (chess_moves_v2) shared overhead.
const C: Overhead = { pos: [0.4667, 0.4617, 0.9797], target: T, fov: 44 };

export const XEPISODES: Record<string, XEpisode> = {
  v2_001: { board: true, piece: "queen", color: "white", from: "e7", to: "h1", overhead: C, wristTilt: 2 },
  v2_135: { board: true, piece: "queen", color: "white", from: "c4", to: "h5", overhead: C, wristTilt: 2 },
  v2_267: { board: true, piece: "queen", color: "white", from: "h3", to: "c3", overhead: C, wristTilt: 2 },
  v2_399: { board: true, piece: "queen", color: "white", from: "c1", to: "f5", overhead: C, wristTilt: 2 },

  all_011: { board: false, piece: "queen", color: "black", atMM: [245, 182], wristTilt: 2,
    overhead: { pos: [0.3494, 1.3568, 0.561], target: T, fov: 31 } },
  all_016: { board: false, piece: "king", color: "white", atMM: [250, -250], wristTilt: 2,
    overhead: { pos: [0.3841, 1.2798, 0.5641], target: T, fov: 44 } },
  all_036: { board: true, piece: "bishop", color: "white", atMM: [180, -178], wristTilt: 2,
    overhead: { pos: [0.3055, 0.8603, 0.6635], target: T, fov: 44 }, boardOffset: { x: 0, y: 0, yaw: 0 } },
  all_045: { board: true, piece: "queen", color: "white", from: "d1", to: "d4", wristTilt: 2,
    overhead: { pos: [0.3884, 0.3084, 1.0505], target: T, fov: 44 }, boardOffset: { x: 0, y: 0, yaw: 0 } },
};
