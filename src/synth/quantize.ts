import { Rng } from "./rng";
import { TrueFrame } from "./motion";

/**
 * Sample-and-hold the true per-frame poses into the logged `state` stream,
 * reproducing the recorder's polling artifact: the camera runs at ~14 fps but
 * the robot state is polled slower (~4.5 Hz), so ~1/3–2/3 of consecutive states
 * are exact duplicates (run-lengths ~2–3). See docs/full_dataset_analysis.md §4.
 *
 * Returns recorder-format rows: state = [x,y,z(mm), yaw(deg), gripper], and
 * action[i] = state[i+1] (the commanded next state; last action = last state).
 */
export interface LoggedFrame {
  i: number;
  t: number;
  state: number[]; // [x,y,z,yaw,grip]
  action: number[];
}

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

const toState = (f: TrueFrame): number[] => [round(f.x, 3), round(f.y, 3), round(f.z, 3), round(f.yaw, 3), round(f.grip, 4)];

export function sampleHold(frames: TrueFrame[], pollHz: number, rng: Rng): LoggedFrame[] {
  // A poll clock ticks ~pollHz with jitter; state updates only on a tick,
  // otherwise it holds the value latched at the last tick.
  const held: number[][] = [];
  let nextPoll = 0; // time of the next allowed state update
  let latched = toState(frames[0]);
  for (const f of frames) {
    if (f.t >= nextPoll) {
      latched = toState(f);
      const interval = (1 / pollHz) * (1 + (rng() - 0.5) * 0.5); // ±25% jitter
      nextPoll = f.t + interval;
    }
    held.push(latched);
  }

  const out: LoggedFrame[] = [];
  for (let i = 0; i < frames.length; i++) {
    out.push({
      i,
      t: round(frames[i].t, 4),
      state: held[i],
      action: held[Math.min(i + 1, frames.length - 1)],
    });
  }
  return out;
}

/** Fraction of consecutive states that are exact duplicates (validation aid). */
export function duplicateFraction(logged: LoggedFrame[]): number {
  let dup = 0;
  for (let i = 1; i < logged.length; i++) {
    const a = logged[i - 1].state, b = logged[i].state;
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]) dup++;
  }
  return logged.length > 1 ? dup / (logged.length - 1) : 0;
}
