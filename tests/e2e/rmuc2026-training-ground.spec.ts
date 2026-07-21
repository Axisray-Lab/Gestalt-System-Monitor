import { expect, test, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { appendFile } from 'node:fs/promises';

interface GsmE2EState {
  ready: boolean;
  mode: 'overview' | 'focus-loading' | 'focus';
  roundKeys: string[];
  focusedKey: string | null;
  previewUnitCount: number;
  previewRobotCount: number;
  fullUnitCount: number;
  focusedVehicleCount: number;
  focusedSandboxReady: boolean;
  perfSampleId: number;
  gpuRenderer: string;
  drawCalls: number;
  triangles: number;
  frameMsP95: number;
  longFrames: number;
  paused: boolean | null;
  playbackMs: number | null;
  durationMs: number | null;
}

interface GsmE2EApi {
  getState(): GsmE2EState;
  selectRound(key: string): void | Promise<void>;
  exitFocus(): void;
  setPaused(paused: boolean): void;
  seek(ms: number): void;
}

declare global {
  interface Window {
    __GSM_E2E__?: GsmE2EApi;
  }
}

const LIMITS = {
  expectedRounds: positiveIntegerEnv('GSM_E2E_EXPECTED_ROUNDS', 613),
  expectedPreviewRobots: positiveIntegerEnv('GSM_E2E_EXPECTED_PREVIEW_ROBOTS', 7_151),
  expectedFocusedPreviewRobots: positiveIntegerEnv(
    'GSM_E2E_EXPECTED_FOCUSED_PREVIEW_ROBOTS',
    7_139
  ),
  overviewDrawCalls: positiveIntegerEnv('GSM_E2E_MAX_OVERVIEW_DRAW_CALLS', 20),
  overviewTriangles: positiveIntegerEnv('GSM_E2E_MAX_OVERVIEW_TRIANGLES', 200_000),
  focusDrawCalls: positiveIntegerEnv('GSM_E2E_MAX_FOCUS_DRAW_CALLS', 120),
  focusTriangles: positiveIntegerEnv('GSM_E2E_MAX_FOCUS_TRIANGLES', 2_000_000),
  heapMiB: positiveIntegerEnv('GSM_E2E_MAX_HEAP_MIB', 512),
  overviewFrameP95Ms: positiveNumberEnv('GSM_E2E_MAX_OVERVIEW_FRAME_P95_MS', 250),
  overviewLongFrameMs: positiveNumberEnv('GSM_E2E_OVERVIEW_LONG_FRAME_MS', 200),
  focusFrameP95Ms: positiveNumberEnv('GSM_E2E_MAX_FOCUS_FRAME_P95_MS', 1_200),
  focusLongFrameMs: positiveNumberEnv('GSM_E2E_FOCUS_LONG_FRAME_MS', 850),
  overviewLongFrameRatio: ratioEnv('GSM_E2E_MAX_OVERVIEW_LONG_FRAME_RATIO', 0.25),
  focusLongFrameRatio: ratioEnv('GSM_E2E_MAX_FOCUS_LONG_FRAME_RATIO', 0.5),
};

test('all rounds stay lightweight while one replay owns the full renderer', async ({ page }, testInfo) => {
  const browserErrors = installBrowserDiagnostics(page);
  await mockLocalDiscoveryAgent(page);
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('canvas')).toBeVisible();

  await expect
    .poll(
      () => page.evaluate(() => {
        const api = window.__GSM_E2E__;
        return Boolean(
          api &&
          typeof api.getState === 'function' &&
          typeof api.selectRound === 'function' &&
          typeof api.exitFocus === 'function' &&
          typeof api.setPaused === 'function' &&
          typeof api.seek === 'function'
        );
      }),
      { message: 'Pages E2E build must expose window.__GSM_E2E__; no DOM fallback is allowed.' }
    )
    .toBe(true);

  await waitForState(page, state =>
    state.ready &&
    state.mode === 'overview' &&
    state.roundKeys.length === LIMITS.expectedRounds &&
    state.previewUnitCount === LIMITS.expectedRounds &&
    state.fullUnitCount === 0
  );

  const overview = await readState(page);
  assertStateShape(overview);
  expect(new Set(overview.roundKeys).size, 'Every catalog round must have one unique preview key.').toBe(
    LIMITS.expectedRounds
  );
  expect(overview.focusedKey).toBeNull();
  expect(overview.previewRobotCount, 'Every official overview robot must be instanced.').toBe(
    LIMITS.expectedPreviewRobots
  );
  expect(overview.gpuRenderer, 'Runner must exercise the declared SwiftShader path.').toMatch(
    /swiftshader/i
  );
  expect(overview.drawCalls, 'Overview draw-call complexity regression.').toBeLessThanOrEqual(
    LIMITS.overviewDrawCalls
  );
  expect(overview.triangles, 'Overview triangle complexity regression.').toBeLessThanOrEqual(
    LIMITS.overviewTriangles
  );

  const replaySearch = page.getByTestId('replay-search');
  const catalogReplays = page.getByTestId('catalog-replay');
  await expect(replaySearch).toBeVisible();
  await expect(catalogReplays).toHaveCount(12);
  await replaySearch.fill('华南农业大学 M001 G2');
  await expect(page.getByTestId('replay-search-count')).toHaveText('1 局 · 全赛区');
  await expect(catalogReplays).toHaveCount(1);
  await expect(catalogReplays).toContainText('华南农业大学');
  await expect(catalogReplays).toContainText('南部赛区');
  await replaySearch.fill('不存在的学校 M999');
  await expect(catalogReplays).toHaveCount(0);
  await expect(page.getByTestId('replay-search-empty')).toHaveText('没有匹配的对局');
  await replaySearch.fill('');
  await expect(catalogReplays).toHaveCount(12);
  await expect(page.getByTestId('replay-pagination')).toContainText('1 / 17');

  const overviewTiming = await sampleAnimationFrames(page, 4_000, LIMITS.overviewLongFrameMs);
  const overviewAfterTiming = await readState(page);
  await attachMetrics(testInfo, {
    phase: 'overview',
    limits: LIMITS,
    state: { ...overviewAfterTiming, roundKeys: `[${overviewAfterTiming.roundKeys.length} keys]` },
    timing: overviewTiming,
  });
  expect(overviewAfterTiming.perfSampleId, 'Three.js performance samples must keep advancing.').toBeGreaterThan(
    overview.perfSampleId
  );
  expect(overviewTiming.p95Ms, 'Overview SwiftShader frame p95 regression.').toBeLessThanOrEqual(
    LIMITS.overviewFrameP95Ms
  );
  expect(overviewTiming.longFrameRatio, 'Overview SwiftShader long-frame ratio regression.').toBeLessThanOrEqual(
    LIMITS.overviewLongFrameRatio
  );
  const overviewHeap = await readHeapMiB(page);
  expect(overviewHeap, 'Overview JS heap regression.').toBeLessThanOrEqual(LIMITS.heapMiB);
  await attachScreenshot(page, testInfo, 'overview-613-rounds');
  assertNoBrowserErrors(browserErrors, 'overview');

  const selectedKey = overview.roundKeys[0];
  await page.evaluate(async key => {
    const api = window.__GSM_E2E__;
    if (!api) throw new Error('window.__GSM_E2E__ is missing from the E2E Pages build.');
    await api.selectRound(key);
  }, selectedKey);
  await waitForState(page, state =>
    state.ready &&
    state.mode === 'focus' &&
    state.focusedKey === selectedKey &&
    state.previewUnitCount === LIMITS.expectedRounds - 1 &&
    state.fullUnitCount === 1
  );

  const focused = await readState(page);
  assertStateShape(focused, true);
  expect(focused.previewRobotCount).toBe(LIMITS.expectedFocusedPreviewRobots);
  expect(focused.focusedVehicleCount).toBeGreaterThan(0);
  expect(focused.focusedSandboxReady).toBe(true);
  expect(focused.drawCalls, 'Focused draw-call complexity regression.').toBeLessThanOrEqual(
    LIMITS.focusDrawCalls
  );
  expect(focused.triangles, 'Focused triangle complexity regression.').toBeLessThanOrEqual(
    LIMITS.focusTriangles
  );
  const focusedHeap = await readHeapMiB(page);
  expect(focusedHeap, 'Focused JS heap regression.').toBeLessThanOrEqual(LIMITS.heapMiB);
  await attachScreenshot(page, testInfo, 'focused-full-replay');
  assertNoBrowserErrors(browserErrors, 'focus load');

  const playToggle = page.getByTestId('replay-play-toggle');
  const back = page.getByTestId('replay-back');
  const forward = page.getByTestId('replay-forward');
  const exit = page.getByTestId('replay-exit');
  await expect(playToggle).toBeVisible();
  await expect(back).toBeVisible();
  await expect(forward).toBeVisible();
  await expect(exit).toBeVisible();

  await page.evaluate(() => {
    const api = window.__GSM_E2E__;
    if (!api) throw new Error('window.__GSM_E2E__ is missing from the E2E Pages build.');
    api.setPaused(false);
  });
  await waitForState(page, state => state.mode === 'focus' && state.paused === false);
  await playToggle.click();
  await waitForState(page, state => state.paused === true);
  const pausedAt = requiredPlaybackMs(await readState(page));
  const pausedVehicleCount = (await readState(page)).focusedVehicleCount;
  await page.waitForTimeout(5_500);
  const stillPausedAt = requiredPlaybackMs(await readState(page));
  expect(Math.abs(stillPausedAt - pausedAt), 'Paused replay clock must remain stationary.').toBeLessThanOrEqual(150);
  expect((await readState(page)).focusedVehicleCount, 'Paused replay must retain its rendered vehicles.').toBe(
    pausedVehicleCount
  );

  const durationMs = requiredDurationMs(await readState(page));
  if (durationMs <= 25_000) throw new Error(`Replay duration is too short for exact ±10s controls: ${durationMs}`);
  const stepOrigin = Math.round(durationMs * 0.5);
  await page.evaluate(target => {
    const api = window.__GSM_E2E__;
    if (!api) throw new Error('window.__GSM_E2E__ is missing from the E2E Pages build.');
    api.seek(target);
  }, stepOrigin);
  await waitForState(page, state => state.playbackMs !== null && Math.abs(state.playbackMs - stepOrigin) <= 150);
  await forward.click();
  await waitForState(page, state => state.playbackMs !== null && Math.abs(state.playbackMs - (stepOrigin + 10_000)) <= 150);
  const afterForward = requiredPlaybackMs(await readState(page));
  expect(Math.abs(afterForward - (stepOrigin + 10_000)), 'Forward control must advance exactly 10 seconds.').toBeLessThanOrEqual(150);
  await back.click();
  await waitForState(page, state => state.playbackMs !== null && Math.abs(state.playbackMs - stepOrigin) <= 150);
  const afterBack = requiredPlaybackMs(await readState(page));
  expect(Math.abs(afterBack - stepOrigin), 'Back control must rewind exactly 10 seconds.').toBeLessThanOrEqual(150);

  const seekTarget = Math.max(1_000, Math.min(durationMs - 1_000, Math.round(durationMs * 0.5)));
  await page.evaluate(target => {
    const api = window.__GSM_E2E__;
    if (!api) throw new Error('window.__GSM_E2E__ is missing from the E2E Pages build.');
    api.seek(target);
  }, seekTarget);
  await waitForState(page, state =>
    state.playbackMs !== null && Math.abs(state.playbackMs - seekTarget) <= 150
  );

  await playToggle.click();
  await waitForState(page, state => state.paused === false);
  const playingAt = requiredPlaybackMs(await readState(page));
  await page.waitForTimeout(650);
  expect(requiredPlaybackMs(await readState(page)), 'Playing replay clock must advance.').toBeGreaterThan(
    playingAt + 200
  );

  const timingStartSampleId = (await readState(page)).perfSampleId;
  const timing = await sampleAnimationFrames(page, 4_000, LIMITS.focusLongFrameMs);
  const postTimingState = await readState(page);
  await attachMetrics(testInfo, {
    limits: LIMITS,
    overview: { ...overview, roundKeys: `[${overview.roundKeys.length} keys]`, heapMiB: overviewHeap },
    focused: { ...focused, roundKeys: `[${focused.roundKeys.length} keys]`, heapMiB: focusedHeap },
    postTiming: { ...postTimingState, roundKeys: `[${postTimingState.roundKeys.length} keys]` },
    timing,
  });
  await appendGitHubSummary({ overview, focused, overviewHeap, focusedHeap, overviewTiming, timing, postTimingState });
  expect(postTimingState.perfSampleId, 'Three.js focus samples must keep advancing.').toBeGreaterThan(
    timingStartSampleId
  );
  expect(timing.p95Ms, 'SwiftShader frame p95 smoke budget exceeded.').toBeLessThanOrEqual(
    LIMITS.focusFrameP95Ms
  );
  expect(timing.longFrameRatio, 'SwiftShader long-frame ratio smoke budget exceeded.').toBeLessThanOrEqual(
    LIMITS.focusLongFrameRatio
  );
  assertNoBrowserErrors(browserErrors, 'playback and performance sample');

  await exit.click();
  await waitForState(page, state =>
    state.mode === 'overview' &&
    state.focusedKey === null &&
    state.previewUnitCount === LIMITS.expectedRounds &&
    state.fullUnitCount === 0
  );
  await attachScreenshot(page, testInfo, 'returned-to-overview');
  assertNoBrowserErrors(browserErrors, 'exit focus');
});

async function readState(page: Page): Promise<GsmE2EState> {
  return page.evaluate(() => {
    const api = window.__GSM_E2E__;
    if (!api) throw new Error('window.__GSM_E2E__ is missing from the E2E Pages build.');
    return api.getState();
  });
}

async function waitForState(page: Page, predicate: (state: GsmE2EState) => boolean): Promise<void> {
  await expect
    .poll(async () => predicate(await readState(page)), {
      message: 'Timed out waiting for the required E2E application state.',
      timeout: 120_000,
      intervals: [100, 250, 500, 1_000],
    })
    .toBe(true);
}

function assertStateShape(state: GsmE2EState, focused = false): void {
  expect(state.roundKeys).toEqual(expect.any(Array));
  for (const key of state.roundKeys) expect(key).toEqual(expect.any(String));
  for (const field of ['previewUnitCount', 'previewRobotCount', 'fullUnitCount', 'focusedVehicleCount', 'perfSampleId', 'drawCalls', 'triangles', 'frameMsP95', 'longFrames'] as const) {
    expect(Number.isFinite(state[field]), `${field} must be a finite number.`).toBe(true);
    expect(state[field], `${field} must not be negative.`).toBeGreaterThanOrEqual(0);
  }
  if (focused) {
    expect(typeof state.paused, 'Focused state must expose paused.').toBe('boolean');
    expect(Number.isFinite(state.playbackMs), 'Focused state must expose playbackMs.').toBe(true);
    expect(Number.isFinite(state.durationMs), 'Focused state must expose durationMs.').toBe(true);
  }
}

function requiredPlaybackMs(state: GsmE2EState): number {
  if (state.playbackMs === null || !Number.isFinite(state.playbackMs)) {
    throw new Error('Focused E2E state is missing a finite playbackMs.');
  }
  return state.playbackMs;
}

function requiredDurationMs(state: GsmE2EState): number {
  if (state.durationMs === null || !Number.isFinite(state.durationMs) || state.durationMs <= 2_000) {
    throw new Error('Focused E2E state is missing a durationMs greater than 2000.');
  }
  return state.durationMs;
}

interface FrameSample {
  sampleCount: number;
  p95Ms: number;
  maxMs: number;
  longFrames: number;
  longFrameRatio: number;
}

async function sampleAnimationFrames(page: Page, durationMs: number, longFrameMs: number): Promise<FrameSample> {
  return page.evaluate(
    ({ duration, threshold }) => new Promise<FrameSample>(resolve => {
      const samples: number[] = [];
      let startedAt: number | null = null;
      let previousAt: number | null = null;
      const onFrame = (now: number): void => {
        startedAt ??= now;
        if (previousAt !== null) samples.push(now - previousAt);
        previousAt = now;
        if (now - startedAt < duration) {
          requestAnimationFrame(onFrame);
          return;
        }
        const sorted = [...samples].sort((left, right) => left - right);
        const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
        const longFrames = samples.filter(sample => sample > threshold).length;
        resolve({
          sampleCount: samples.length,
          p95Ms: sorted[p95Index] ?? Number.POSITIVE_INFINITY,
          maxMs: sorted.at(-1) ?? Number.POSITIVE_INFINITY,
          longFrames,
          longFrameRatio: samples.length === 0 ? 1 : longFrames / samples.length,
        });
      };
      requestAnimationFrame(onFrame);
    }),
    { duration: durationMs, threshold: longFrameMs }
  );
}

async function readHeapMiB(page: Page): Promise<number> {
  const session: CDPSession = await page.context().newCDPSession(page);
  try {
    await session.send('Performance.enable');
    await session.send('HeapProfiler.collectGarbage');
    const response = await session.send('Performance.getMetrics') as {
      metrics: { name: string; value: number }[];
    };
    const used = response.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value;
    if (used === undefined || !Number.isFinite(used)) {
      throw new Error('Chromium CDP did not expose JSHeapUsedSize.');
    }
    return Math.round((used / 1024 / 1024) * 10) / 10;
  } finally {
    await session.detach();
  }
}

function installBrowserDiagnostics(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(`[pageerror] ${error.stack ?? error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`[console.error] ${message.text()}`);
  });
  return errors;
}

function assertNoBrowserErrors(errors: readonly string[], phase: string): void {
  expect(errors, `Browser errors reported during ${phase}:\n${errors.join('\n')}`).toEqual([]);
}

async function mockLocalDiscoveryAgent(page: Page): Promise<void> {
  const status = {
    install: null,
    candidates: [],
    resources: {
      capturedAt: 0,
      platform: 'playwright',
      memory: { totalBytes: 1, freeBytes: 1, usedBytes: 0, usedPercent: 0, freePercent: 100 },
      cpu: { logicalCores: 1, usedPercent: 0, freePercent: 100 },
      budget: { perMatchMemoryBytes: 1, perMatchCpuCores: 1, reservedMemoryBytes: 0 },
      recommendedAdditionalMatches: 0,
    },
    launches: [],
    batches: [],
    headlessArgs: [],
    autoSave: { available: false, enabledByDefault: false, mode: 'off', reason: 'E2E static replay mode' },
    ready: false,
    reason: 'E2E static replay mode',
  };
  await page.route('http://localhost:7788/launcher', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ kind: 'launcherStatus', status }),
    })
  );
  await page.route('http://localhost:7788/processes', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ kind: 'processes', processes: [] }),
    })
  );
  await page.routeWebSocket(/ws:\/\/localhost:7788\/?$/, socket => {
    socket.send(JSON.stringify({ kind: 'processes', processes: [] }));
  });
}

async function attachScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
}

async function attachMetrics(testInfo: TestInfo, value: unknown): Promise<void> {
  await testInfo.attach('performance-metrics', {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
    contentType: 'application/json',
  });
}

async function appendGitHubSummary(input: {
  overview: GsmE2EState;
  focused: GsmE2EState;
  overviewHeap: number;
  focusedHeap: number;
  overviewTiming: FrameSample;
  timing: FrameSample;
  postTimingState: GsmE2EState;
}): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const markdown = [
    '## RMUC 2026 Pages browser regression',
    '',
    '| State | Preview/full units | Draw calls | Triangles | JS heap | Frame p95 | Long-frame ratio |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| Overview | ${input.overview.previewUnitCount}/${input.overview.fullUnitCount} | ${input.overview.drawCalls} | ${input.overview.triangles} | ${input.overviewHeap.toFixed(1)} MiB | ${input.overviewTiming.p95Ms.toFixed(1)} ms | ${(input.overviewTiming.longFrameRatio * 100).toFixed(1)}% |`,
    `| Focus | ${input.focused.previewUnitCount}/${input.focused.fullUnitCount} | ${input.focused.drawCalls} | ${input.focused.triangles} | ${input.focusedHeap.toFixed(1)} MiB | ${input.timing.p95Ms.toFixed(1)} ms (app ${input.postTimingState.frameMsP95.toFixed(1)} ms) | ${(input.timing.longFrameRatio * 100).toFixed(1)}% |`,
    '',
  ].join('\n');
  await appendFile(summaryPath, `${markdown}\n`, 'utf8');
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = positiveNumberEnv(name, fallback);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a positive integer; got ${value}.`);
  return value;
}

function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number; got ${raw}.`);
  return value;
}

function ratioEnv(name: string, fallback: number): number {
  const value = positiveNumberEnv(name, fallback);
  if (value > 1) throw new Error(`${name} must be greater than 0 and at most 1; got ${value}.`);
  return value;
}
