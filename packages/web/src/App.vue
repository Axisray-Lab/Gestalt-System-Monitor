<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDiscovery } from '@/discovery/useDiscovery';
import { useMatches, type MatchHooks } from '@/feed/useMatches';
import { DioramaScene, type ThreePerformanceStats } from '@/three/DioramaScene';
import MatchList from '@/components/MatchList.vue';

const PERF_HUD_STORAGE_KEY = 'gsm.performanceHud';
const numberFormatter = new Intl.NumberFormat('en-US');

const {
  processes,
  connected,
  launcherStatus,
  launcherBusy,
  launcherError,
  launchHeadlessMatches,
} = useDiscovery();

// Single source of truth for which unit is focused, two-way synced with the scene.
const focusedKey = ref<string | null>(null);
const settingsOpen = ref(false);
const showPerformanceHud = ref(loadPerformanceHudSetting());
const performanceStats = ref<ThreePerformanceStats>({
  fps: 0,
  frameMs: 0,
  drawCalls: 0,
  triangles: 0,
  geometries: 0,
  textures: 0,
  programs: 0,
  pixelRatio: 1,
  unitCount: 0,
  width: 0,
  height: 0,
});

const host = ref<HTMLDivElement>();
let scene: DioramaScene | null = null;

const hooks: MatchHooks = {
  onAdd: (key, label) => scene?.addUnit(key, label),
  onRemove: (key) => {
    scene?.removeUnit(key);
    if (focusedKey.value === key) focusedKey.value = null;
  },
  onMap: (key, map) => scene?.setMap(key, map),
  onSnapshot: (key, snap) => scene?.updateSnapshot(key, snap),
};
const { matches, start } = useMatches(processes, hooks);

watch(focusedKey, (k) => scene?.applyFocus(k));
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

async function launchMatches(count: number) {
  try {
    await launchHeadlessMatches(count);
  } catch {
    /* error state is surfaced by useDiscovery */
  }
}

onMounted(() => {
  scene = new DioramaScene(host.value!, {
    onFocusChange: (k) => (focusedKey.value = k),
    onPerformanceStats: (stats) => (performanceStats.value = stats),
  });
  start();
});

onBeforeUnmount(() => {
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
      :launcher-status="launcherStatus"
      :launcher-busy="launcherBusy"
      :launcher-error="launcherError"
      @focus="focusedKey = $event"
      @overview="focusedKey = null"
      @launch="launchMatches"
    />
    <main class="stage">
      <div ref="host" class="canvas-host" />
    </main>

    <aside v-if="showPerformanceHud" class="perf-hud" aria-label="Three.js performance monitor">
      <div class="perf-head">
        <span>Three.js</span>
        <strong>{{ Math.round(performanceStats.fps) }} FPS</strong>
      </div>
      <dl class="perf-grid">
        <div>
          <dt>Frame</dt>
          <dd>{{ performanceStats.frameMs.toFixed(1) }} ms</dd>
        </div>
        <div>
          <dt>Draws</dt>
          <dd>{{ formatCount(performanceStats.drawCalls) }}</dd>
        </div>
        <div>
          <dt>Triangles</dt>
          <dd>{{ formatCount(performanceStats.triangles) }}</dd>
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
          <dt>Matches</dt>
          <dd>{{ performanceStats.unitCount }}</dd>
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
