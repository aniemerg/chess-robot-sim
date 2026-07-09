/**
 * Deterministic per-episode randomness. A single integer seed drives every
 * sampling decision so any synthetic episode is exactly reproducible from its
 * manifest (which records the seed + all resolved values).
 */
export type Rng = () => number; // uniform [0,1)

/** mulberry32 — small, fast, well-distributed 32-bit PRNG. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const uniform = (rng: Rng, lo: number, hi: number): number => lo + (hi - lo) * rng();

/** Gaussian via Box-Muller, clamped to ±clampSd standard deviations. */
export function gauss(rng: Rng, mean: number, sd: number, clampSd = 3): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  let z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  z = Math.max(-clampSd, Math.min(clampSd, z));
  return mean + sd * z;
}

export const pick = <T>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
export const chance = (rng: Rng, p: number): boolean => rng() < p;
export const randInt = (rng: Rng, loInc: number, hiInc: number): number =>
  loInc + Math.floor(rng() * (hiInc - loInc + 1));
