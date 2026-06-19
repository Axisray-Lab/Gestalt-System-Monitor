<script setup lang="ts">
import { computed, ref } from 'vue';
import type { LauncherStatus } from '@gsm/protocol';
import type { MatchView } from '@/feed/types';

const props = defineProps<{
  matches: MatchView[];
  focusedKey: string | null;
  agentConnected: boolean;
  launcherStatus: LauncherStatus | null;
  launcherBusy: boolean;
  launcherError: string | null;
}>();
const emit = defineEmits<{
  (e: 'focus', key: string): void;
  (e: 'overview'): void;
  (e: 'launch', count: number): void;
}>();

const launchCount = ref(1);

const recommendedMatches = computed(
  () => props.launcherStatus?.resources.recommendedAdditionalMatches ?? 0,
);
const sampledMatches = computed(
  () => props.launcherStatus?.resources.sampledAdditionalMatches ?? recommendedMatches.value,
);
const runningLaunches = computed(
  () => props.launcherStatus?.launches.filter((launch) => launch.status === 'running').length ?? 0,
);
const launcherReady = computed(
  () => props.agentConnected && Boolean(props.launcherStatus?.ready),
);
const canLaunch = computed(
  () =>
    launcherReady.value &&
    !props.launcherBusy &&
    launchCount.value >= 1 &&
    launchCount.value <= recommendedMatches.value,
);
const installLabel = computed(() => {
  const install = props.launcherStatus?.install;
  if (!props.agentConnected) return 'agent offline';
  if (!install) return 'not found';
  return install.executablePath ? install.name : 'missing executable';
});

function adjustLaunchCount(delta: number) {
  launchCount.value = clampCount(launchCount.value + delta);
}

function normalizeLaunchCount() {
  launchCount.value = clampCount(Number(launchCount.value) || 1);
}

function requestLaunch() {
  if (canLaunch.value) emit('launch', launchCount.value);
}

function clampCount(value: number): number {
  return Math.min(16, Math.max(1, Math.round(value)));
}

function meterWidth(value: number | undefined): string {
  return `${Math.round(Math.min(100, Math.max(0, value ?? 0)))}%`;
}

function formatBytes(value: number | undefined): string {
  if (value == null) return '--';
  const gib = value / 1024 / 1024 / 1024;
  return `${gib.toFixed(gib >= 10 ? 0 : 1)} GB`;
}

function formatPercent(value: number | undefined): string {
  return value == null ? '--' : `${Math.round(value)}%`;
}
</script>

<template>
  <aside class="sidebar">
    <div class="brand">Gestalt<span>·</span>System Monitor</div>

    <button v-if="focusedKey !== null" class="overview-btn" @click="emit('overview')">
      ← Overview
    </button>

    <div class="sec-title">
      Matches
      <span class="dot" :class="{ on: agentConnected }" :title="agentConnected ? 'agent online' : 'agent offline'" />
    </div>

    <div v-if="!agentConnected" class="hint">
      discovery agent offline — showing the built-in mock only. run
      <code>npm run agent</code> (or <code>agent:mock</code>) to see LAN matches
    </div>

    <div class="sec-title">
      Launcher
      <span
        class="dot"
        :class="{ on: launcherReady }"
        :title="launcherReady ? 'launcher ready' : 'launcher blocked'"
      />
    </div>

    <section class="launcher">
      <div class="launcher-kv">
        <span>Install</span>
        <strong :title="launcherStatus?.install?.installDir">{{ installLabel }}</strong>
      </div>

      <div class="resource">
        <div class="resource-top">
          <span>RAM free</span>
          <strong>{{ formatBytes(launcherStatus?.resources.memory.freeBytes) }}</strong>
        </div>
        <div class="meter">
          <i :style="{ width: meterWidth(launcherStatus?.resources.memory.freePercent) }" />
        </div>
      </div>

      <div class="resource">
        <div class="resource-top">
          <span>CPU free</span>
          <strong>{{ formatPercent(launcherStatus?.resources.cpu.freePercent) }}</strong>
        </div>
        <div class="meter">
          <i :style="{ width: meterWidth(launcherStatus?.resources.cpu.freePercent) }" />
        </div>
      </div>

      <div class="launcher-kv" :title="`instant estimate: ${sampledMatches}`">
        <span>Safe slots</span>
        <strong>{{ recommendedMatches }}</strong>
      </div>
      <div class="launcher-kv">
        <span>Started</span>
        <strong>{{ runningLaunches }}</strong>
      </div>

      <div class="launch-controls">
        <button class="count-btn" :disabled="launcherBusy" aria-label="Decrease launch count" @click="adjustLaunchCount(-1)">
          -
        </button>
        <input
          v-model.number="launchCount"
          class="count-input"
          type="number"
          min="1"
          max="16"
          :disabled="launcherBusy"
          aria-label="Headless match count"
          @change="normalizeLaunchCount"
        />
        <button class="count-btn" :disabled="launcherBusy" aria-label="Increase launch count" @click="adjustLaunchCount(1)">
          +
        </button>
        <button class="launch-btn" :disabled="!canLaunch" @click="requestLaunch">
          {{ launcherBusy ? 'Starting' : 'Start' }}
        </button>
      </div>

      <div v-if="launcherError || (!launcherReady && launcherStatus?.reason)" class="launcher-msg">
        {{ launcherError || launcherStatus?.reason }}
      </div>
    </section>

    <button
      v-for="m in matches"
      :key="m.key"
      class="proc"
      :class="{ active: m.key === focusedKey }"
      @click="emit('focus', m.key)"
    >
      <span class="s-dot" :data-status="m.status" />
      <span class="proc-text">
        <span class="proc-name">{{ m.label }}</span>
        <span class="proc-sub">
          {{ m.playerCount != null ? m.playerCount + 'p · ' : '' }}{{ m.status }}
        </span>
      </span>
    </button>
  </aside>
</template>
