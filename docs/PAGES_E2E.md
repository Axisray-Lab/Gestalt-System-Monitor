# GitHub Pages browser and performance regression

The Pages workflow runs the built RMUC 2026 replay monitor in headless Chromium before deployment. A failed browser assertion blocks the Pages artifact from being deployed.

## Scope

The Playwright scenario verifies one continuous user journey:

1. the overview reports exactly 613 unique round previews and 7,151 official robot points;
2. only lightweight previews render in overview;
3. selecting one round leaves 612 lightweight previews and creates exactly one full renderer;
4. a pause longer than the renderer's five-second stale window retains vehicles, while play, exact ±10-second steps, direct seek, and exit change authoritative replay state;
5. exiting destroys the full renderer and restores all 613 previews.

Screenshots, a JSON result, an HTML report, and a Playwright trace on failure are uploaded as the `pages-e2e-report` workflow artifact.
The measured unit counts, renderer complexity, heap, frame p95, and long-frame ratio are also written to the workflow run summary.

## Required application contract

The E2E build must use `VITE_GSM_E2E=1` and expose `window.__GSM_E2E__`. The test intentionally has no DOM or static-data fallback: a missing or incomplete contract fails the run.

`getState()` must return:

- `ready`, `mode` (`overview`, `focus-loading`, or `focus`);
- `roundKeys`, `focusedKey`, `previewUnitCount`, and `fullUnitCount`;
- `drawCalls`, `triangles`, `frameMsP95`, `longFrames`, `perfSampleId`, and the active GPU renderer;
- `previewRobotCount`, focused vehicle count, and focused sandbox-model readiness;
- `paused`, `playbackMs`, and `durationMs` after focus is ready (and `null` in overview).

The API must also provide `selectRound(key)`, `exitFocus()`, `setPaused(paused)`, and `seek(ms)`. User-facing controls must expose these stable test ids:

- `replay-play-toggle`
- `replay-back`
- `replay-forward`
- `replay-exit`

## Gates

Scene-complexity gates are deterministic and blocking:

| State | Preview units | Full units | Draw calls | Triangles |
| --- | ---: | ---: | ---: | ---: |
| Overview | 613 | 0 | at most 20 | at most 200,000 |
| Focus | 612 | 1 | at most 120 | at most 2,000,000 |

The JavaScript heap is garbage-collected through Chromium CDP before measurement and must remain at or below 512 MiB.

GitHub-hosted runners render WebGL through SwiftShader, so their timing is useful for catching regressions but is not a hardware-GPU benchmark. The test asserts that Chromium really selected SwiftShader and that Three.js performance sample ids continue to advance.

The 613-round overview has a blocking frame-rate budget:

- animation-frame p95 at most 250 ms;
- frames slower than 200 ms at most 25% of its four-second sample.

The existing focused high-detail renderer is much slower under software rasterization, so its separate gate is intentionally only a hang/stall smoke budget:

- animation-frame p95 at most 1,200 ms;
- frames slower than 850 ms at most 50% of the sample.

The HUD's rolling p95 is still captured in the report, but is diagnostic rather than blocking because its long window deliberately includes replay loading, screenshots, and forced garbage collection.

Thresholds can be tightened deliberately with the `GSM_E2E_*` environment variables declared in the test. Invalid values fail at test discovery; they never silently use another value. The first successful GitHub-hosted run establishes the remote SwiftShader baseline for later tightening.

## Local run

From the repository root in PowerShell:

```powershell
$env:VITE_GSM_STATIC_REPLAYS = 'rmuc2026-regionals'
$env:VITE_GSM_E2E = '1'
npm run build
npx playwright install --only-shell chromium
npm run test:e2e
```

The test serves the existing `packages/web/dist` directory with Vite preview. It does not rebuild automatically, so it cannot accidentally test a non-Pages configuration.
