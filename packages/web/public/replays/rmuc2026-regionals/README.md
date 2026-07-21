# RMUC 2026 regional replay fixtures

This directory contains all 266 match series generated from the official
RMUC 2026 regional dataset for the Monitor GitHub Pages build:

| Directory | Series | Games |
| --------- | -----: | ----: |
| `east/`   |     88 |   203 |
| `south/`  |     88 |   204 |
| `north/`  |     90 |   206 |

Each `mNNN.json.gzip` file contains the complete two-to-four-game series for one
official regional match number. The v2 replay catalog exposes every game as an
independent descriptor with an exact half-open frame range while all games in a
series continue to share this one asset. No replay payload is copied. The gzip
transport keeps the complete 10 Hz replay library within the GitHub Pages
site-size limit; the replay payload inside remains `gsm-watch-replay/2` JSON and
is decoded strictly by the client.

`overview/east.bin.gzip`, `overview/south.bin.gzip`, and
`overview/north.bin.gzip` are the lightweight region-wide training-ground
tracks. They contain only the official 1 Hz robot point trajectory needed by
the overview renderer: signed 16-bit UE-centimetre XYZ positions at a declared
1 cm quantization and one defeated-state bit. The files use
`gsm-rmuc2026-overview-track/1`; their byte length, SHA-256, region identity,
round identities, sample totals, and record boundaries are verified before use.
Focused playback always uses the corresponding authoritative 10 Hz series
asset, not the overview track.

Regenerate and validate the files from the Monitor repository root:

```bash
npm run generate:rmuc2026-pages
npm run verify:rmuc2026-pages
npm run verify:rmuc2026-pages-assets
```

The generator owns source-path resolution and validates the expected dataset
identity and match selection. Missing data, a source mismatch, or invalid output
terminates the command; no substitute fixture or synthetic fallback is used.
Catalog and overview validation also requires exactly 203 eastern, 204 southern,
and 206 northern games (613 total), with contiguous 100 ms frame cuts and the
explicit 3 s separators already present in each series asset.

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
