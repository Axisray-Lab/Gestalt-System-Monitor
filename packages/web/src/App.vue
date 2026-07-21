<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useDiscovery } from '@/discovery/useDiscovery';
import { useMatches, type MatchHooks } from '@/feed/useMatches';
import {
  configuredStaticReplays,
  RMUC2026_OVERVIEW_SHARDS,
  RMUC2026_REPLAY_CATALOG,
} from '@/feed/staticReplayCatalog';
import { drainFeedPerf, feedPerf } from '@/feed/feedPerf';
import { DioramaScene, type ThreePerformanceStats } from '@/three/DioramaScene';
import { RoundPreviewPlayback } from '@/three/RoundPreviewPlayback';
import type { WorldSnapshot } from '@gsm/protocol';
import MatchList from '@/components/MatchList.vue';

const PERF_HUD_STORAGE_KEY = 'gsm.performanceHud';
const numberFormatter = new Intl.NumberFormat('en-US');

const { processes, connected } = useDiscovery();
const staticReplays = configuredStaticReplays();
const staticReplayKeys = new Set(staticReplays.map((replay) => replay.key));

// Single source of truth for which unit is focused, two-way synced with the scene.
const focusedKey = ref<string | null>(null);
const roundPreviewReady = ref(staticReplays.length === 0);
const roundPreviewError = ref<string | null>(null);
const settingsOpen = ref(false);
const showPerformanceHud = ref(loadPerformanceHudSetting());
const performanceStats = ref<ThreePerformanceStats>({
  sampleId: 0,
  fps: 0,
  frameMs: 0,
  frameMsMin: 0,
  frameMsP95: 0,
  frameMsMax: 0,
  longFrames: 0,
  cpuMs: 0,
  updateMs: 0,
  renderMs: 0,
  labelMs: 0,
  otherMs: 0,
  gpuMs: 0,
  gpuSupported: false,
  gpuRenderer: '',
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  pixelRatio: 1,
  unitCount: 0,
  activeUnitCount: 0,
  vehicleCount: 0,
  focused: false,
  width: 0,
  height: 0,
  frameSamples: [],
});

// Frame-time sparkline geometry. Bars are coloured by the 60fps (16.7ms) and
// 30fps (33.3ms) budgets so spikes/jank read at a glance — an average can't.
const SPARK_W = 240;
const SPARK_H = 44;
const SPARK_FLOOR_MS = 50; // keep the vertical scale stable until a real spike exceeds it

function sparkMax(samples: number[]): number {
  let max = SPARK_FLOOR_MS;
  for (const ms of samples) if (ms > max) max = ms;
  return max;
}

const frameBars = computed(() => {
  const samples = performanceStats.value.frameSamples;
  if (samples.length === 0) return [] as { x: number; y: number; w: number; h: number; color: string }[];
  const max = sparkMax(samples);
  const bw = SPARK_W / samples.length;
  return samples.map((ms, i) => {
    const h = Math.max(1, (ms / max) * SPARK_H);
    return {
      x: i * bw,
      y: SPARK_H - h,
      w: Math.max(0.6, bw - 0.4),
      h,
      color: ms <= 16.7 ? '#3ec07a' : ms <= 33.3 ? '#f59e0b' : '#ef4444',
    };
  });
});

function refY(ms: number): number {
  const max = sparkMax(performanceStats.value.frameSamples);
  return SPARK_H - (ms / max) * SPARK_H;
}

const fpsClass = computed(() => {
  const f = performanceStats.value.fps;
  return f >= 50 ? 'good' : f >= 30 ? 'warn' : 'bad';
});

// "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 ..., D3D11)" → "Intel(R) UHD
// Graphics 630" so the HUD can show iGPU-vs-dGPU at a glance (full string on hover).
const shortGpu = computed(() => {
  const raw = performanceStats.value.gpuRenderer;
  if (!raw) return '';
  const angle = raw.match(/^ANGLE \(([^,]+),\s*(.+?)(?:\s+(?:Direct3D|OpenGL|Vulkan).*)?\)$/);
  if (angle) return angle[2].trim();
  return raw;
});
const gpuIsIntegrated = computed(() => /intel|uhd|iris|microsoft basic|swiftshader|llvmpipe/i.test(shortGpu.value));

const host = ref<HTMLDivElement>();
let scene: DioramaScene | null = null;
let roundPreviewPlayback: RoundPreviewPlayback | null = null;
let appUnmounting = false;

function requireScene(): DioramaScene {
  if (!scene) throw new Error('DioramaScene is unavailable after match feeds started');
  return scene;
}

// Latest snapshot per match key, for the sidebar detail panel.
// shallowRef: every add/remove/snapshot replaces the whole .value object (below),
// so reactivity fires on identity change without deep-proxying each WorldSnapshot.
// The Three.js render path reads the raw snap and doesn't need reactivity.
const snapshotMap = shallowRef<Record<string, WorldSnapshot>>({});
let requiredPerfSampleId = 0;

const hooks: MatchHooks = {
  onAdd: (key, label) => {
    if (staticReplayKeys.has(key)) requireScene().addFocusedPreviewUnit(key, label);
    else requireScene().addUnit(key, label);
  },
  onRemove: (key) => {
    if (staticReplayKeys.has(key)) requireScene().removeFocusedPreviewUnit(key);
    else requireScene().removeUnit(key);
    if (focusedKey.value === key) {
      focusedKey.value = null;
      snapshotMap.value = {};
    }
  },
  onMap: (key, map) => requireScene().setMap(key, map),
  onSnapshot: (key, snap) => {
    const tScene = performance.now();
    requireScene().updateSnapshot(key, snap);
    feedPerf.sceneSnapMs += performance.now() - tScene;
    // Only the focused match's snapshot feeds the sidebar detail panel. Storing all
    // 66 matches reactively (a fresh spread per tick × N feeds) was pure overhead;
    // the Three.js render path consumes `snap` directly above, not snapshotMap.
    if (key === focusedKey.value) snapshotMap.value = { [key]: snap };
  },
  onReplayPlayback: (key, paused) => requireScene().setReplayPaused(key, paused),
  onReplayDiscontinuity: (key) => requireScene().markReplayDiscontinuity(key),
};
// No built-in synthetic mock: matches come from the agent (real LAN discovery +
// the auto-replayed local datasets multi-1/15/50). See the gsmAgent vite plugin.
const {
  matches,
  start,
  setActiveKeys,
  setFocusedKey: setMaterializedStaticReplayKey,
  setReplayPaused,
  seekReplay,
} = useMatches(processes, hooks, {
  staticReplays,
});

watch(focusedKey, (key) => {
  requiredPerfSampleId = performanceStats.value.sampleId + 1;
  setMaterializedStaticReplayKey(key);
  if (key !== null && staticReplayKeys.has(key)) {
    if (!roundPreviewPlayback) {
      throw new Error(`Round preview playback is unavailable while focusing ${key}`);
    }
    if (!roundPreviewPlayback.hasRound(key)) {
      throw new Error(`Round preview playback does not contain focused round ${key}`);
    }
    seekReplay(key, roundPreviewPlayback.positionMs(key));
  }
  snapshotMap.value = {};
  requireScene().applyFocus(key);
});
watch(showPerformanceHud, (enabled) => {
  try {
    window.localStorage.setItem(PERF_HUD_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    /* localStorage can be unavailable in hardened browser contexts */
  }
});

function loadPerformanceHudSetting(): boolean {
  try {
    return window.localStorage.getItem(PERF_HUD_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function formatCount(value: number): string {
  return numberFormatter.format(Math.round(value));
}

// Dev-only: stream a compact per-window perf sample to the Vite perf sink so the
// real browser/GPU time series can be read off disk (see gsmPerfSink in vite.config).
const round1 = (n: number): number => Math.round(n * 10) / 10;
function sendPerf(body: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  fetch('/__perf/log', { method: 'POST', body: JSON.stringify(body), keepalive: true }).catch(
    () => {
      /* sink not mounted (older dev server) / offline — ignore */
    }
  );
}
interface FeedFrameCost {
  parseMs: number;
  applyMs: number;
  projectMs: number;
  sceneSnapMs: number;
  msgsPerSec: number;
}

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

interface GsmE2EHook {
  getState(): GsmE2EState;
  selectRound(key: string): void;
  exitFocus(): void;
  setPaused(paused: boolean): void;
  seek(positionMs: number): void;
}

declare global {
  interface Window {
    __GSM_E2E__?: GsmE2EHook;
  }
}

function installE2EHook(): void {
  if (import.meta.env.VITE_GSM_E2E !== '1') return;
  window.__GSM_E2E__ = {
    getState: () => {
      if (!scene) throw new Error('E2E state requested before DioramaScene initialization');
      const key = focusedKey.value;
      const view = key === null ? null : matches.value.find((match) => match.key === key) ?? null;
      const playback = view?.replayPlayback ?? null;
      const stats = performanceStats.value;
      const overviewReady =
        key === null &&
        stats.focusedKey === null &&
        stats.previewSlotCount === staticReplays.length &&
        stats.previewVisibleSlotCount === staticReplays.length &&
        (stats.previewRobotCount ?? 0) > 0;
      const focusReady =
        key !== null &&
        view?.status === 'open' &&
        playback !== null &&
        stats.focusedKey === key &&
        stats.focusedFullUnitCount === 1 &&
        stats.focusedSandboxReady === true &&
        stats.vehicleCount > 0;
      const mode: GsmE2EState['mode'] =
        key === null ? 'overview' : focusReady ? 'focus' : 'focus-loading';
      return {
        ready:
          roundPreviewReady.value &&
          roundPreviewError.value === null &&
          stats.sampleId >= requiredPerfSampleId &&
          stats.drawCalls > 0 &&
          (key === null ? overviewReady : focusReady),
        mode,
        roundKeys: staticReplays.map((replay) => replay.key),
        focusedKey: key,
        previewUnitCount: stats.previewVisibleSlotCount ?? 0,
        previewRobotCount: stats.previewRobotCount ?? 0,
        fullUnitCount: stats.focusedFullUnitCount ?? 0,
        focusedVehicleCount: stats.vehicleCount,
        focusedSandboxReady: stats.focusedSandboxReady === true,
        perfSampleId: stats.sampleId,
        gpuRenderer: stats.gpuRenderer,
        drawCalls: stats.drawCalls,
        triangles: stats.triangles,
        frameMsP95: stats.frameMsP95,
        longFrames: stats.longFrames,
        paused: playback?.paused ?? null,
        playbackMs: playback?.positionMs ?? null,
        durationMs: playback?.durationMs ?? null,
      };
    },
    selectRound: (key) => {
      if (!staticReplayKeys.has(key)) throw new Error(`E2E requested an unknown round: ${key}`);
      focusedKey.value = key;
    },
    exitFocus: () => {
      focusedKey.value = null;
    },
    setPaused: (paused) => {
      const key = focusedKey.value;
      if (key === null) throw new Error('E2E pause requested without a focused replay');
      setReplayPaused(key, paused);
    },
    seek: (positionMs) => {
      const key = focusedKey.value;
      if (key === null) throw new Error('E2E seek requested without a focused replay');
      seekReplay(key, positionMs);
    },
  };
}

function perfSample(s: ThreePerformanceStats, feed: FeedFrameCost): Record<string, unknown> {
  return {
    type: 'sample',
    tMs: Math.round(performance.now()),
    fps: round1(s.fps),
    frameMs: round1(s.frameMs),
    min: round1(s.frameMsMin),
    p95: round1(s.frameMsP95),
    max: round1(s.frameMsMax),
    hitches: s.longFrames,
    cpuMs: round1(s.cpuMs),
    updateMs: round1(s.updateMs),
    renderMs: round1(s.renderMs),
    labelMs: round1(s.labelMs),
    otherMs: round1(s.otherMs),
    feedParseMs: round1(feed.parseMs),
    feedApplyMs: round1(feed.applyMs),
    feedProjectMs: round1(feed.projectMs),
    sceneSnapMs: round1(feed.sceneSnapMs),
    feedMsgsPerSec: Math.round(feed.msgsPerSec),
    gpuMs: round1(s.gpuMs),
    draws: s.drawCalls,
    tris: s.triangles,
    matches: `${s.previewVisibleSlotCount ?? s.activeUnitCount}/${s.previewSlotCount ?? s.unitCount}`,
    vehicles: s.previewRobotCount ?? s.vehicleCount,
    focused: s.focused,
    // Window focus / tab visibility: if hitches line up with hasFocus=false, the
    // jank is the browser throttling the unfocused window, not our rendering.
    hasFocus: document.hasFocus(),
    vis: document.visibilityState,
    dpr: window.devicePixelRatio,
    screen: `${window.screen.width}x${window.screen.height}`,
    gpu: s.gpuRenderer,
  };
}

// Feed cost is accumulated in feedPerf across all sockets and drained once per
// perf window (same ~500ms cadence as the scene stats), normalized to per-frame so
// it lines up with updateMs/renderMs/otherMs. It's a slice of "Other".
let lastStatsAt = performance.now();
const feedFrameCost = ref<FeedFrameCost>({ parseMs: 0, applyMs: 0, projectMs: 0, sceneSnapMs: 0, msgsPerSec: 0 });

// Long Tasks (>50ms main-thread blocks) directly attribute the frame-time spikes:
// if a hitch coincides with a long task it's main-thread work/GC; if not, it's
// compositor/vsync jank. Accumulated by an observer and drained each perf window.
let longTaskCount = 0;
let longTaskMaxMs = 0;
if (typeof PerformanceObserver !== 'undefined') {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTaskCount += 1;
        if (e.duration > longTaskMaxMs) longTaskMaxMs = e.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {
    /* longtask entry type unsupported (e.g. Firefox) — telemetry just stays 0 */
  }
}

onMounted(() => {
  sendPerf({ type: 'reset' }); // start a fresh telemetry log for this page load
  scene = new DioramaScene(host.value!, {
    onFocusChange: (k) => (focusedKey.value = k),
    onPerformanceStats: (stats) => {
      performanceStats.value = stats;
      const now = performance.now();
      const windowMs = Math.max(1, now - lastStatsAt);
      lastStatsAt = now;
      const feed = drainFeedPerf();
      const frames = Math.max(1, Math.round((stats.fps * windowMs) / 1000));
      const cost: FeedFrameCost = {
        parseMs: feed.parseMs / frames,
        applyMs: feed.applyMs / frames,
        projectMs: feed.projectMs / frames,
        sceneSnapMs: feed.sceneSnapMs / frames,
        msgsPerSec: (feed.messages * 1000) / windowMs,
      };
      feedFrameCost.value = cost;
      const sample = perfSample(stats, cost);
      sample.longtasks = longTaskCount;
      sample.longTaskMaxMs = round1(longTaskMaxMs);
      longTaskCount = 0;
      longTaskMaxMs = 0;
      sendPerf(sample);
    },
    // Hidden boards stop projecting snapshots — only the ~visible/focused feeds work.
    onActiveKeysChange: (keys) => setActiveKeys(keys),
  });
  if (staticReplays.length > 0) {
    roundPreviewPlayback = new RoundPreviewPlayback(
      scene,
      staticReplays,
      RMUC2026_OVERVIEW_SHARDS,
      RMUC2026_REPLAY_CATALOG.databaseSha256
    );
    void roundPreviewPlayback.start()
      .then(() => {
        if (appUnmounting) return;
        roundPreviewReady.value = true;
      })
      .catch((error: unknown) => {
        if (appUnmounting) return;
        const message = error instanceof Error ? error.message : String(error);
        roundPreviewError.value = message;
        console.error('[rmuc overview] load failed', error);
      });
  }
  start();
  installE2EHook();
});

onBeforeUnmount(() => {
  appUnmounting = true;
  if (import.meta.env.VITE_GSM_E2E === '1') delete window.__GSM_E2E__;
  roundPreviewPlayback?.dispose();
  roundPreviewPlayback = null;
  scene?.dispose();
  scene = null;
});
</script>

<template>
  <div class="app">
    <MatchList
      :matches="matches"
      :focused-key="focusedKey"
      :agent-connected="connected"
      :snapshot-map="snapshotMap"
      @focus="focusedKey = $event"
      @overview="focusedKey = null"
      @replay-paused="setReplayPaused"
      @replay-seek="seekReplay"
    />
    <main class="stage">
      <div ref="host" class="canvas-host" />
      <div v-if="roundPreviewError" class="preview-status error" role="alert">
        RMUC2026 全量预览加载失败：{{ roundPreviewError }}
      </div>
      <div
        v-else-if="staticReplays.length > 0 && !roundPreviewReady"
        class="preview-status"
        aria-live="polite"
      >
        正在校验并加载 613 局轻量轨迹…
      </div>
    </main>

    <aside v-if="showPerformanceHud" class="perf-hud" aria-label="Three.js performance monitor">
      <div class="perf-head">
        <span>Three.js · {{ performanceStats.focused ? 'focus' : 'overview' }}</span>
        <strong :class="fpsClass">{{ Math.round(performanceStats.fps) }} FPS</strong>
      </div>

      <svg
        class="perf-spark"
        :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line class="perf-ref" x1="0" :y1="refY(16.7)" :x2="SPARK_W" :y2="refY(16.7)" />
        <line class="perf-ref warn" x1="0" :y1="refY(33.3)" :x2="SPARK_W" :y2="refY(33.3)" />
        <rect
          v-for="(bar, i) in frameBars"
          :key="i"
          :x="bar.x"
          :y="bar.y"
          :width="bar.w"
          :height="bar.h"
          :fill="bar.color"
        />
      </svg>

      <div
        v-if="shortGpu"
        class="perf-gpu-name"
        :class="{ warn: gpuIsIntegrated }"
        :title="performanceStats.gpuRenderer"
      >
        {{ gpuIsIntegrated ? '⚠ ' : '' }}{{ shortGpu }}
      </div>

      <dl class="perf-grid">
        <div>
          <dt>Frame</dt>
          <dd>{{ performanceStats.frameMs.toFixed(1) }} ms</dd>
        </div>
        <div>
          <dt>p95 / max</dt>
          <dd>{{ performanceStats.frameMsP95.toFixed(1) }} / {{ performanceStats.frameMsMax.toFixed(0) }}</dd>
        </div>
        <div>
          <dt title="Frames slower than 33ms (≈30fps) in the last second">Hitches</dt>
          <dd :class="{ bad: performanceStats.longFrames > 0 }">{{ performanceStats.longFrames }}</dd>
        </div>
        <div>
          <dt>GPU</dt>
          <dd>{{ performanceStats.gpuSupported ? performanceStats.gpuMs.toFixed(1) + ' ms' : 'n/a' }}</dd>
        </div>
      </dl>

      <div class="perf-section">CPU per frame</div>
      <dl class="perf-grid">
        <div>
          <dt title="Vehicle interpolation + camera/controls update">Update</dt>
          <dd>{{ performanceStats.updateMs.toFixed(1) }} ms</dd>
        </div>
        <div>
          <dt title="three.js WebGL draw-call submission">Render</dt>
          <dd>{{ performanceStats.renderMs.toFixed(1) }} ms</dd>
        </div>
        <div>
          <dt title="CSS2D label/panel DOM layout">Labels</dt>
          <dd>{{ performanceStats.labelMs.toFixed(1) }} ms</dd>
        </div>
        <div>
          <dt title="Outside the render loop: feed processing, GC, layout/paint, vsync wait">Other</dt>
          <dd>{{ performanceStats.otherMs.toFixed(1) }} ms</dd>
        </div>
        <div>
          <dt title="JSON.parse + store fold + projection across all feeds, per frame — a slice of Other">Feed</dt>
          <dd>{{ (feedFrameCost.parseMs + feedFrameCost.applyMs + feedFrameCost.projectMs).toFixed(1) }} ms</dd>
        </div>
        <div v-if="performanceStats.previewUpdateMs != null">
          <dt title="Latest shared 613-round point-batch update">Preview</dt>
          <dd>{{ performanceStats.previewUpdateMs.toFixed(1) }} ms</dd>
        </div>
        <div>
          <dt title="WS messages folded per second across all open feeds">Feed msgs</dt>
          <dd>{{ formatCount(feedFrameCost.msgsPerSec) }}/s</dd>
        </div>
      </dl>

      <div class="perf-section">Scene</div>
      <dl class="perf-grid">
        <div>
          <dt>Draws</dt>
          <dd>{{ formatCount(performanceStats.drawCalls) }}</dd>
        </div>
        <div>
          <dt>Triangles</dt>
          <dd>{{ formatCount(performanceStats.triangles) }}</dd>
        </div>
        <div>
          <dt title="Visible lightweight previews / total rounds">Previews</dt>
          <dd>
            {{ (performanceStats.previewSlotCount ?? 0) > 0
              ? performanceStats.previewVisibleSlotCount
              : performanceStats.activeUnitCount }} /
            {{ (performanceStats.previewSlotCount ?? 0) > 0
              ? performanceStats.previewSlotCount
              : performanceStats.unitCount }}
          </dd>
        </div>
        <div>
          <dt>Preview points</dt>
          <dd>{{ (performanceStats.previewSlotCount ?? 0) > 0
            ? performanceStats.previewRobotCount
            : performanceStats.vehicleCount }}</dd>
        </div>
        <div>
          <dt>Resources</dt>
          <dd>{{ performanceStats.geometries }} geo / {{ performanceStats.textures }} tex</dd>
        </div>
        <div>
          <dt>Programs</dt>
          <dd>{{ performanceStats.programs }}</dd>
        </div>
        <div>
          <dt>DPR</dt>
          <dd>{{ performanceStats.pixelRatio.toFixed(2) }}</dd>
        </div>
        <div>
          <dt>Viewport</dt>
          <dd>{{ performanceStats.width }}x{{ performanceStats.height }}</dd>
        </div>
      </dl>
    </aside>

    <div class="settings-menu" :class="{ open: settingsOpen }">
      <button
        class="settings-fab"
        type="button"
        title="Settings"
        aria-label="Settings"
        aria-controls="settings-panel"
        :aria-expanded="settingsOpen"
        @click="settingsOpen = !settingsOpen"
      >
        <span aria-hidden="true">&#9881;</span>
      </button>
      <section v-if="settingsOpen" id="settings-panel" class="settings-panel" aria-label="Settings">
        <div class="settings-title">Settings</div>
        <label class="settings-toggle">
          <span class="settings-copy">
            <strong>Performance HUD</strong>
            <small>{{ showPerformanceHud ? 'Visible' : 'Hidden' }}</small>
          </span>
          <input v-model="showPerformanceHud" type="checkbox" />
          <span class="toggle-track" aria-hidden="true"><i /></span>
        </label>
      </section>
    </div>
  </div>
</template>
