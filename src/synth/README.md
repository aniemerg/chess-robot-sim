# `src/synth/` — synthetic episode generator

Generates synthetic xArm5 chess episodes in the recorder's on-disk format, as
in-distribution as possible with the real Magnus rollouts. See
`docs/synthetic_data_plan.md` for the plan and `docs/full_dataset_analysis.md`
for the measured motion profile this reproduces.

## Pipeline

```
scenario.ts   (scenario, seed) -> scene spec + motion primitive + task + manifest
motion.ts     primitive + params -> TRUE per-frame TCP path (phase machine @ measured speed)
quantize.ts   true path -> sample-held `state` stream (recorder polling artifact)
scene.ts        spec -> randomized Three.js scene (reuses xarm5 robot/board)
piece_models.ts pluggable piece sets: procedural_lathe + sourced glTF/GLB sets
generate.ts     entry: plan -> per-frame IK -> expose window.SYNTH { renderBase, renderWrist, frames, manifest }
rng.ts          one seed -> all sampling (fully reproducible from the manifest)
```

The **image** is rendered at the true pose for every frame; the logged **state**
is sample-held (~every 3rd frame), so `frames.jsonl` looks stair-stepped like the
recorder while the frames show continuous motion (plan §1).

## Run

```bash
# writes synth/<dataset>/episodes/episode_XXXXXX/{episode.json,frames.jsonl,manifest.json,base/*.jpg,wrist/*.jpg}
node tools/render-synth.mjs <scenario> <seed> [index] [dataset]
```
The writer reuses a running Vite dev server (`npm run dev`, port 4319) or spawns
one. Output goes to `synth/` (gitignored). A side-by-side `base|wrist` preview
mp4 is written next to the dataset for eyeballing.

Scenarios (parametric core, plan §3): `queen_move`, `queen_move_yaw90`,
`table_pickup`. Open `synth.html?scenario=&seed=` in the dev server to inspect
one interactively. Append `&set=<id>` (or a 6th CLI arg) to force a piece set.

**Piece models** (`piece_models.ts`): episodes randomly draw one of several
sets (each logged with its license in the manifest). Three set kinds:

| set id | kind | license |
|---|---|---|
| `procedural_classic` | procedural | in-repo |
| `procedural_slim` / `procedural_wide` / `procedural_tall` | procedural (proportion variants) | in-repo |
| `polyhaven_chess_set` | glTF, per-piece nodes | CC0 (Poly Haven / Riley Queen) |
| `poly_jarlan_lowpoly` | per-type GLB files | CC-BY (Jarlan Perez / Poly Pizza) |

Sourced sets live under `public/assets/pieces/<set>/` with an `ATTRIBUTION.md`.
Adding a set = drop files there + one entry in `SETS` (`gltf-nodes` for a single
glTF with named piece nodes, or `per-type` for one GLB per piece type; low-poly
GLBs without normals are auto-fixed). The wrist camera is **not** randomized
(fixed mount).

## Status & known gaps (first slice)

Working end-to-end for the three first-milestone scenarios; IK follow error
~2.6 mm mean (real: ~2–4 mm). To tune against the real distributions (the
validation harness, plan §6):
- **State duplicate fraction** runs ~0.77–0.83 vs real 0.34–0.68 — the poll rate
  vs camera fps needs calibration in `quantize.ts` / `sampleMotionParams`.
- **Pickup duration** ~3.4 s is short vs real pickups (8–31 s); add longer
  inspect holds.
- Randomization is the near-real ("in_distribution") tier only; the wide-aug
  tier, background clutter, and sensor noise are not wired yet (plan §5).
  (Sourced glTF piece sets ARE wired — see `piece_models.ts`.)
