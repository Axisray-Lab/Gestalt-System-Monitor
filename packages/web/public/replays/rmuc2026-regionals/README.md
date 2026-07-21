# RMUC 2026 regional replay fixtures

This directory contains all 266 match series generated from the official
RMUC 2026 regional dataset for the Monitor GitHub Pages build:

| Directory | Series | Games |
| --------- | -----: | ----: |
| `east/`   |     88 |   203 |
| `south/`  |     88 |   204 |
| `north/`  |     90 |   206 |

Each `mNNN.json.gzip` file contains the complete two-to-four-game series for one
official regional match number. The gzip transport keeps the complete 10 Hz
replay library within the GitHub Pages site-size limit; the replay payload
inside remains `gsm-watch-replay/2` JSON and is decoded strictly by the client.

Regenerate and validate the files from the Monitor repository root:

```bash
npm run generate:rmuc2026-pages
npm run verify:rmuc2026-pages
npm run verify:rmuc2026-pages-assets
```

The generator owns source-path resolution and validates the expected dataset
identity and match selection. Missing data, a source mismatch, or invalid output
terminates the command; no substitute fixture or synthetic fallback is used.

## Transformation and inference

- The official samples are 1 Hz. Poses, current health, structure health, and
  current firing heat are deterministically interpolated into 100 ms frames
  (10 Hz). Every official whole-second anchor remains exact. Death, revival,
  levels, limits, buffs, coins, and other discrete state are held.
- Health and the official replay trajectory remain authoritative. The fixture
  does not simulate vehicle physics or recompute damage.
- Remaining launch allowance is not present as an authoritative source field.
  Ground-robot ammunition is an explicitly labelled deterministic estimate.
  Its provenance, safe bounds, unresolved spend, and detected anomalies are
  stored in each replay file's metadata. Spending that cannot be uniquely
  assigned to ammunition, support, buyback, or repair remains explicitly
  unclassified rather than being forced into one operation.
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
