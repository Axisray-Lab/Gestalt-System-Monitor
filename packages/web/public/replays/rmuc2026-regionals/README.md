# RMUC 2026 regional-final replay fixtures

This directory contains three static replay series generated from the official
RMUC 2026 regional dataset for the Monitor GitHub Pages build:

| File                   | Series                   | Games |
| ---------------------- | ------------------------ | ----: |
| `east-final-m88.json`  | East regional final M88  |     4 |
| `south-final-m88.json` | South regional final M88 |     3 |
| `north-final-m90.json` | North regional final M90 |     4 |

Regenerate and validate the files from the Monitor repository root:

```bash
npm run generate:rmuc2026-pages
npm run verify:rmuc2026-pages
```

The generator owns source-path resolution and validates the expected dataset
identity and match selection. Missing data, a source mismatch, or invalid output
terminates the command; no substitute fixture or synthetic fallback is used.

## Transformation and inference

- The official samples are 1 Hz. Poses are deterministically interpolated into
  100 ms frames (10 Hz); discrete state is held until the next official sample.
- Health and the official replay trajectory remain authoritative. The fixture
  does not simulate vehicle physics or recompute damage.
- Remaining launch allowance is not present as an authoritative source field.
  Ground-robot ammunition is an explicitly labelled deterministic estimate.
  Its provenance, safe bounds, unresolved spend, and detected anomalies are
  stored in each replay file's metadata.
- Buff event rows contain names and timing but no numeric values. Numeric effects
  that the public competition rules determine are reconstructed from the rules
  and official event timeline. This includes applicable terrain,
  energy-mechanism, and technology-level effects.
- The official vulnerability value is projected as an icon-only boolean. A
  precise vulnerability multiplier or its source cannot be recovered and is
  not fabricated here.

## Attribution and license

Source: [RoboMaster — RMUC 2026 regional dataset release](https://bbs.robomaster.com/article/1936220?source=1)

The derived replay fixture data in this directory is licensed under
[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International
(CC BY-NC-SA 4.0)](https://creativecommons.org/licenses/by-nc-sa/4.0/).
Keep this attribution and license notice with redistributed or adapted fixture
data. The license applies to the derived replay data, not to the surrounding
Monitor source code.
