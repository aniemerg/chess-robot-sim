# Chess Set — Poly Haven

- **Source:** https://polyhaven.com/a/chess_set
- **Author:** Riley Queen (published via Poly Haven)
- **License:** CC0 1.0 (public domain) — no attribution legally required; recorded
  here for provenance.
- **Files:** glTF (1k textures) + `chess_set.bin` + `textures/`. Downloaded from
  the Poly Haven CDN via the public API (`api.polyhaven.com/files/chess_set`).

Used as an alternative piece-model set for synthetic data generation. Pieces are
individually named nodes (`piece_{type}_{color}[_nn]`) and are extracted per
type/color by `src/synth/piece_models.ts`. The board mesh is present in the glTF
but unused (we use the data-fitted board in `src/xarm5/board.ts`).
